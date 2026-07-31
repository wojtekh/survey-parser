import { NextResponse } from 'next/server';
import { cancelBooking } from '@/lib/calcom';
import { checkAgentSecret } from '@/lib/checkAgentSecret';

export const runtime = 'nodejs';

// POST /api/agent/calcom/cancel-appointment  { conversation_id?, event_id, reason? }
//
// Pairs with calcom_find_appointment -- event_id must be a value that tool
// returned (or one already known from calcom_book_appointment's own
// response earlier in the same call, e.g. a caller cancelling right after
// booking). Cancels unconditionally once given a valid event_id -- there's
// no separate "are you sure" step server-side, so the agent's prompt
// should always read back the specific date/time and get explicit
// confirmation from the caller before calling this.
//
// conversation_id is optional, same reasoning as book_appointment: only
// used for traceability, not required by Cal.com's own API.
export async function POST(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const eventId: string | undefined = body.event_id;
  const reason: string | undefined = body.reason;
  const conversationIdRaw: string | undefined = body.conversation_id;

  if (!conversationIdRaw) {
    console.log('[calcom/cancel-appointment] conversation_id missing or empty, proceeding anyway.');
  }

  if (!eventId || typeof eventId !== 'string') {
    return NextResponse.json(
      { error: 'Missing event_id. Call calcom_find_appointment first to get one.' },
      { status: 400 }
    );
  }

  try {
    const result = await cancelBooking(eventId, reason);
    return NextResponse.json({
      ok: true,
      event_id: eventId,
      start_iso: result.startISO,
      end_iso: result.endISO,
      confirmation: `Cancelled the appointment on ${result.confirmation}.`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to cancel appointment.';
    // Best-effort detection of Cal.com's "already cancelled" rejection --
    // not a documented, guaranteed error shape, same caveat as
    // book-appointment's conflict detection.
    const alreadyCancelled = /already.*cancel/i.test(message);
    return NextResponse.json(
      { error: alreadyCancelled ? 'That appointment has already been cancelled.' : message },
      { status: alreadyCancelled ? 409 : 502 }
    );
  }
}
