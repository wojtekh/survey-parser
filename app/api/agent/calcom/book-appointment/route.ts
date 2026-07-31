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
