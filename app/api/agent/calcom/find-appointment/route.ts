import { NextResponse } from 'next/server';
import { findUpcomingBookings } from '@/lib/calcom';
import { resolveRequestedDate } from '@/lib/dateResolution';
import { checkAgentSecret } from '@/lib/checkAgentSecret';
import { DateTime } from 'luxon';

export const runtime = 'nodejs';

// POST /api/agent/calcom/find-appointment  { name?, email?, phone?, date? }
//
// Pairs with calcom_cancel_appointment, same relationship as
// check_availability -> book_appointment. A caller calling back to cancel
// doesn't carry a booking uid around, so this resolves one (or several, if
// ambiguous) from whatever identifying info they give instead.
//
// At least one of name/email/phone is required. email is the most reliable
// (Cal.com's attendeeEmail filter is exact and server-side); name falls
// back to Cal.com's attendeeName filter; phone narrows results further
// client-side only (Cal.com's API has no phone filter, and not every Event
// Type even collects one). date is optional, only useful to disambiguate
// when a caller has multiple upcoming appointments.
export async function POST(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const name: string | undefined = body.name;
  const email: string | undefined = body.email;
  const phone: string | undefined = body.phone;
  const rawDate: string | undefined = body.date;

  if (!name && !email && !phone) {
    return NextResponse.json(
      { error: 'Provide at least one of name, email, or phone to look up the appointment.' },
      { status: 400 }
    );
  }

  let dateFilter: string | null = null;
  if (rawDate) {
    const resolved = resolveRequestedDate(rawDate);
    if (/^\d{4}-\d{2}-\d{2}$/.test(resolved)) dateFilter = resolved;
  }

  try {
    let matches = await findUpcomingBookings({ name, email, phone });

    if (dateFilter) {
      matches = matches.filter((m) => DateTime.fromISO(m.startISO).toISODate() === dateFilter);
    }

    return NextResponse.json({
      matches: matches.map((m) => ({
        event_id: m.eventId,
        start_iso: m.startISO,
        end_iso: m.endISO,
        label: m.label,
      })),
      none_found: matches.length === 0,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to look up appointment.' },
      { status: 502 }
    );
  }
}
