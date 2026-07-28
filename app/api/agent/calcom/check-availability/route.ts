import { NextResponse } from 'next/server';
import { getAvailableSlots } from '@/lib/calcom';
import { parseDurationMinutes, resolveRequestedDate } from '@/lib/dateResolution';
import { checkAgentSecret } from '@/lib/checkAgentSecret';

export const runtime = 'nodejs';

// POST /api/agent/calcom/check-availability  { date, duration_minutes? }
//
// Cal.com equivalent of /api/agent/check-availability -- same request/
// response shape (minus is_business_day, which doesn't map cleanly onto
// Cal.com's own schedule engine -- see lib/calcom.ts), so an agent prompt
// built for the Google Calendar version needs only trivial changes to
// target this one instead.
//
// date: pass through close to verbatim what the caller said -- "today",
// "tomorrow", a weekday name, "Monday, August 3rd", or literal YYYY-MM-DD.
// Resolved server-side via resolveRequestedDate(), same as the Google
// Calendar version (shared code, lib/dateResolution.ts).
export async function POST(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const rawDate: string | undefined = body.date;
  const durationMinutes = parseDurationMinutes(body.duration_minutes);

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
    const { slots, timeZone } = await getAvailableSlots(date, durationMinutes);

    return NextResponse.json({
      date,
      time_zone: timeZone,
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
