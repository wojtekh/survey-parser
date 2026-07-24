import { NextResponse } from 'next/server';
import { getAvailableSlots, getDefaultDurationMinutes, resolveRequestedDate } from '@/lib/googleCalendar';
import { checkAgentSecret } from '@/lib/checkAgentSecret';

export const runtime = 'nodejs';

// POST /api/agent/check-availability  { date, duration_minutes? }
//
// date: pass through close to verbatim what the caller said -- "today",
// "tomorrow", a weekday name ("Tuesday" and "next Tuesday" both mean the
// nearest upcoming Tuesday -- see resolveRequestedDate's comment for the
// one edge case where "next" actually adds a week), or a literal
// YYYY-MM-DD. Resolved server-side in BUSINESS_TIME_ZONE via
// resolveRequestedDate(), not by the LLM doing date arithmetic.
// duration_minutes defaults to APPOINTMENT_DURATION_MINUTES (30 if unset).
//
// Returns open business-hours slots for that single day, already filtered
// against the calendar's real busy blocks and against "already in the
// past" if date is today. The agent should read out a couple of these
// (label is spoken-friendly, e.g. "9:00 AM") and pass the caller's chosen
// slot's start_iso straight through to book-appointment -- never construct
// or guess a time itself.
export async function POST(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const rawDate: string | undefined = body.date;
  const durationMinutes: number =
    typeof body.duration_minutes === 'number' && body.duration_minutes > 0
      ? body.duration_minutes
      : getDefaultDurationMinutes();

  if (!rawDate || typeof rawDate !== 'string') {
    return NextResponse.json({ error: 'Missing date.' }, { status: 400 });
  }

  const date = resolveRequestedDate(rawDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: `Could not resolve "${rawDate}" to a date. Expected "today", "tomorrow", a weekday name, or YYYY-MM-DD.` },
      { status: 400 }
    );
  }

  try {
    const { slots, timeZone, isBusinessDay } = await getAvailableSlots(date, durationMinutes);

    return NextResponse.json({
      date,
      time_zone: timeZone,
      is_business_day: isBusinessDay,
      slots: slots.map((s) => ({ label: s.label, start_iso: s.startISO, end_iso: s.endISO })),
      none_available: slots.length === 0,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to check availability.' },
      { status: 502 }
    );
  }
}
