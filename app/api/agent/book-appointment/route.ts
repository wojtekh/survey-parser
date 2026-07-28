import { NextResponse } from 'next/server';
import { getBusySlots, bookAppointment, parseDurationMinutes } from '@/lib/googleCalendar';
import { checkAgentSecret } from '@/lib/checkAgentSecret';
import { DateTime } from 'luxon';

export const runtime = 'nodejs';

// POST /api/agent/book-appointment
//   { conversation_id, start_iso, duration_minutes?, name, phone?, email?, notes? }
//
// start_iso should be a start_iso value the agent got back from
// check-availability for the same day -- not something it constructs
// itself. duration_minutes defaults to APPOINTMENT_DURATION_MINUTES and
// should normally match whatever was passed to check-availability.
//
// Re-checks the calendar's busy blocks for this exact window immediately
// before booking (a slot offered a few tool-calls ago in the same call
// could already be taken by then) -- returns 409 rather than silently
// double-booking if so.
//
// conversation_id is NOT required, unlike the survey tools -- it's only
// used for traceability in the event description (see bookAppointment),
// nothing here keys off it. Made optional deliberately: {{workflow_run_id}}
// has the same known-unreliable-template issue documented for record-answer
// and get_next_screener_question (resolves to an empty string on some
// calls), and unlike those tools there's no correctness reason to hard-fail
// a real booking over it -- a slightly less traceable calendar event beats
// an appointment that silently didn't get booked.
export async function POST(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const conversationIdRaw: string | undefined = body.conversation_id;
  const conversationId: string | undefined =
    conversationIdRaw && typeof conversationIdRaw === 'string' ? conversationIdRaw : undefined;
  const startISORaw: string | undefined = body.start_iso;
  const name: string | undefined = body.name;
  const phone: string | undefined = body.phone;
  const email: string | undefined = body.email;
  const notes: string | undefined = body.notes;
  const durationMinutes = parseDurationMinutes(body.duration_minutes);

  if (!conversationId) {
    // Diagnostic only, not a rejection -- see comment above. Worth knowing
    // if/how often this happens without blocking the booking over it.
    console.log('[book-appointment] conversation_id missing or empty, proceeding anyway:', {
      conversation_id: conversationIdRaw,
    });
  }

  if (!name || typeof name !== 'string') {
    return NextResponse.json({ error: 'Missing name.' }, { status: 400 });
  }
  if (!phone && !email) {
    return NextResponse.json({ error: 'Provide at least one of phone or email.' }, { status: 400 });
  }

  const start = startISORaw ? DateTime.fromISO(startISORaw) : null;
  if (!start || !start.isValid) {
    return NextResponse.json(
      { error: 'Missing or invalid start_iso. Use a start_iso value returned by check-availability.' },
      { status: 400 }
    );
  }
  const end = start.plus({ minutes: durationMinutes });

  try {
    const busy = await getBusySlots(start.toUTC().toISO()!, end.toUTC().toISO()!);
    const stillFree = !busy.some(
      (b) => start.toUTC() < DateTime.fromISO(b.end).toUTC() && DateTime.fromISO(b.start).toUTC() < end.toUTC()
    );
    if (!stillFree) {
      return NextResponse.json(
        { error: 'That slot was just taken. Call check-availability again for a fresh list.' },
        { status: 409 }
      );
    }

    const result = await bookAppointment({
      startISO: start.toUTC().toISO()!,
      endISO: end.toUTC().toISO()!,
      name,
      phone,
      email,
      notes,
      conversationId,
    });

    return NextResponse.json({
      ok: true,
      event_id: result.eventId,
      start_iso: result.startISO,
      end_iso: result.endISO,
      confirmation: result.confirmation,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to book appointment.' },
      { status: 502 }
    );
  }
}
