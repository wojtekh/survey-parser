import { NextResponse } from 'next/server';
import { bookAppointment } from '@/lib/calcom';
import { checkAgentSecret } from '@/lib/checkAgentSecret';
import { DateTime } from 'luxon';

export const runtime = 'nodejs';

// POST /api/agent/calcom/book-appointment
//   { conversation_id, start_iso, duration_minutes?, name, phone?, email?, notes? }
//
// Cal.com equivalent of /api/agent/book-appointment -- same request shape.
// start_iso should be a start_iso value the agent got back from
// calcom/check-availability for the same day.
//
// No manual "is this slot still free" recheck before booking, unlike the
// Google Calendar version -- Cal.com's own POST /v2/bookings validates
// availability server-side and rejects a conflicting request on its own
// (see lib/calcom.ts). A rejection that looks like a conflict is mapped to
// 409 below so the agent reacts the same way either backend.
//
// conversation_id is optional, same reasoning as the Google Calendar
// version: only used for traceability (Cal.com booking metadata), and
// {{workflow_run_id}} has a documented history of resolving empty on some
// Dograh calls (see dograh/tools-setup.md).
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

  // Deliberately NOT defaulting to APPOINTMENT_DURATION_MINUTES here (unlike
  // check-availability) -- Cal.com rejects lengthInMinutes outright on a
  // fixed-length Event Type, even when the value matches its own default,
  // so this must stay undefined unless the agent actually passed one (for
  // an Event Type with multiple selectable lengths). Tolerates a numeric
  // string, same as parseDurationMinutes, since some tool integrations
  // serialize numbers as strings.
  const rawDuration = body.duration_minutes;
  const parsedDuration =
    typeof rawDuration === 'number' ? rawDuration : typeof rawDuration === 'string' ? Number(rawDuration) : NaN;
  const durationMinutes = Number.isFinite(parsedDuration) && parsedDuration > 0 ? parsedDuration : undefined;

  if (!conversationId) {
    console.log('[calcom/book-appointment] conversation_id missing or empty, proceeding anyway:', {
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
      { error: 'Missing or invalid start_iso. Use a start_iso value returned by calcom/check-availability.' },
      { status: 400 }
    );
  }

  try {
    const result = await bookAppointment({
      startISO: start.toUTC().toISO()!,
      durationMinutes,
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
    const message = err instanceof Error ? err.message : 'Failed to book appointment.';

    // A TIMEOUT IS NOT A FAILURE -- it's an unknown, and treating it as a
    // failure caused a real double-booking on 2026-08-10: calFetch aborted at
    // 3.5s, Cal.com completed the booking anyway, the agent was told it had
    // failed, apologised, re-offered slots, and the caller ended up with two
    // appointments (10:30am and 2:00pm) for one call.
    //
    // Aborting the request on our side does NOT cancel Cal.com's work. The
    // write may already have committed.
    //
    // Deliberately NOT verifying inline here. Dograh's tool cutoff is ~5s and
    // calFetch already spent 3.5s; a findUpcomingBookings call could take
    // another 3.5s, blowing the budget and crashing the call. Shortening the
    // book timeout to make room introduces a worse race -- aborting at 2s
    // while Cal.com commits at 3s means verification looks too early, finds
    // nothing, and reproduces the same double-booking.
    //
    // So: hand the ambiguity back to the agent with an unmissable instruction.
    // calcom_find_appointment is a SEPARATE tool call with its own fresh 5s
    // budget, which is the only place the verification actually fits.
    const looksLikeTimeout = /did not respond within|timed out|TimeoutError|ETIMEDOUT|aborted/i.test(message);
    if (looksLikeTimeout) {
      console.warn('[calcom/book-appointment] timeout -- outcome UNKNOWN, booking may exist:', {
        conversation_id: conversationId,
        start_iso: start.toUTC().toISO(),
        name,
        phone,
        message,
      });
      return NextResponse.json(
        {
          ok: false,
          status: 'unknown',
          error:
            'TIMEOUT -- the booking may or may not have been created. Do NOT offer another time ' +
            'and do NOT try booking again yet. Call calcom_find_appointment first to check whether ' +
            'this appointment already exists. Only book again if it does not.',
        },
        // 202, not 502: the request was accepted and may well have succeeded.
        // A 5xx invites the agent to treat it as a hard failure, which is the
        // exact misreading that caused the double-booking.
        { status: 202 }
      );
    }

    // Best-effort detection of a Cal.com availability-conflict rejection --
    // not a documented, guaranteed error shape, just matching on wording
    // Cal.com is known to use. Worth re-checking against real conflict
    // errors during setup and adjusting this match if it doesn't catch.
    const looksLikeConflict = /no longer available|not available|already booked|conflict/i.test(message);
    return NextResponse.json(
      {
        error: looksLikeConflict
          ? 'That slot was just taken. Call check_availability again for a fresh list.'
          : message,
      },
      { status: looksLikeConflict ? 409 : 502 }
    );
  }
}
