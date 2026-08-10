import { DateTime } from 'luxon';
import { getBusinessTimeZone } from './dateResolution';

// Cal.com v2 API wrapper -- an alternative booking backend alongside
// lib/googleCalendar.ts, not a replacement. Cal.com does most of the work
// lib/googleCalendar.ts hand-rolls itself: business hours, buffers, min
// notice, and double-booking prevention are all configured once on the
// Event Type in Cal.com's dashboard and enforced server-side, rather than
// via BUSINESS_HOURS_START/END env vars and a manual freeBusy recheck here.
// Trade-off: less code and less to get wrong on our side, but the actual
// scheduling rules live in Cal.com's UI instead of this repo -- check the
// Event Type's settings, not env vars, if availability looks wrong.
//
// Setup (hosted cal.com):
//   1. cal.com -> create an Event Type (e.g. "Consultation", 30 min).
//      Note its numeric ID (Event Type -> Advanced/URL, or via GET
//      /v2/event-types once you have an API key).
//   2. Settings -> Security -> generate an API key (cal_... test /
//      cal_live_... live).
//   3. Set CAL_API_KEY and CAL_EVENT_TYPE_ID in .env / Coolify.
//
// Self-hosted (cal.diy or similar): set CAL_API_BASE_URL to your own
// instance's API origin (e.g. https://cal.yourdomain.com/api) -- same
// endpoints, same auth model, just a different host. Verify the exact API
// path prefix against whatever version you're running; it has moved
// around across Cal.com/cal.diy releases.
//
// cal-api-version is a required header, pinned per endpoint below.
// Cal.com does version its API and can require bumping these dates on
// upgrade -- check https://cal.com/docs/api-reference/v2 if a request
// starts failing after a Cal.com update.

function getApiBase(): string {
  return (process.env.CAL_API_BASE_URL || 'https://api.cal.com').replace(/\/$/, '');
}

function getApiKey(): string {
  const key = process.env.CAL_API_KEY;
  if (!key) {
    throw new Error('CAL_API_KEY not set. See lib/calcom.ts header comment for setup.');
  }
  return key;
}

export function getEventTypeId(): number {
  const raw = process.env.CAL_EVENT_TYPE_ID;
  const id = Number(raw);
  if (!raw || !Number.isFinite(id)) {
    throw new Error('CAL_EVENT_TYPE_ID not set or not a number. See lib/calcom.ts header comment for setup.');
  }
  return id;
}

// Deliberately shorter than Dograh's own tool-call timeout (observed at 5s
// on a real test call -- "Request timed out after 5.0 seconds", followed by
// a pipeline crash). Aborting on our side first means the agent gets back a
// real, actionable error ("Cal.com is slow right now, try again") instead of
// leaving Dograh to hit its own timeout, which appears not to fail
// gracefully. Not a fix for whatever made Cal.com slow that one time -- just
// makes sure OUR response always beats Dograh's cutoff when it happens again.
const CAL_API_TIMEOUT_MS = 3500;

async function calFetch(path: string, init: RequestInit & { apiVersion: string }): Promise<any> {
  const { apiVersion, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${getApiBase()}${path}`, {
      ...rest,
      headers: {
        ...(rest.headers ?? {}),
        Authorization: `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
        'cal-api-version': apiVersion,
      },
      signal: AbortSignal.timeout(CAL_API_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') {
      throw new Error(
        `Cal.com API did not respond within ${CAL_API_TIMEOUT_MS / 1000}s on ${rest.method ?? 'GET'} ${path}.`
      );
    }
    throw err;
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = body?.error?.message || body?.message || JSON.stringify(body);
    throw new Error(`Cal.com API error (${res.status}) on ${rest.method ?? 'GET'} ${path}: ${message}`);
  }
  return body;
}

export interface OpenSlot {
  /** Spoken-friendly label in business-hours timezone, e.g. "9:00 AM". */
  label: string;
  startISO: string;
  endISO: string;
}

/**
 * Open slots for one calendar date, entirely as computed by Cal.com's own
 * Event Type schedule (working hours, buffers, min notice, existing
 * bookings) -- unlike lib/googleCalendar.ts's getAvailableSlots, there's
 * no local business-hours/day-of-week logic here, Cal.com already applies
 * its own rules server-side. durationMinutes is only meaningful for Event
 * Types configured with multiple selectable lengths; for a fixed-length
 * Event Type it's ignored by Cal.com (the configured length always wins).
 */
export async function getAvailableSlots(
  dateISO: string,
  durationMinutes?: number
): Promise<{ slots: OpenSlot[]; timeZone: string }> {
  const timeZone = getBusinessTimeZone();
  const eventTypeId = getEventTypeId();

  const dayStart = DateTime.fromISO(dateISO, { zone: timeZone }).startOf('day');
  if (!dayStart.isValid) {
    throw new Error(`Invalid date "${dateISO}". Expected YYYY-MM-DD.`);
  }
  const dayEnd = dayStart.endOf('day');

  const params = new URLSearchParams({
    eventTypeId: String(eventTypeId),
    start: dayStart.toUTC().toISO()!,
    end: dayEnd.toUTC().toISO()!,
    timeZone,
    format: 'range',
  });
  if (durationMinutes) params.set('duration', String(durationMinutes));

  // Endpoint is /v2/slots (not /v2/slots/available -- that path 404s as of
  // this writing; Cal.com renamed it and the start/end/format params under
  // the same cal-api-version, 2024-09-04). Confirm against
  // https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type
  // if this starts 404ing again after a Cal.com update.
  const res = await calFetch(`/v2/slots?${params.toString()}`, {
    method: 'GET',
    apiVersion: '2024-09-04',
  });

  // Response is grouped by date: { data: { "YYYY-MM-DD": [{start,end}, ...] } }.
  // Flatten across whatever date keys came back (the UTC window can spill
  // into an adjacent date key depending on timezone offset) -- already
  // scoped to this one business day via startTime/endTime above.
  const grouped: Record<string, Array<{ start: string; end: string }>> = res?.data ?? {};
  const raw = Object.values(grouped).flat();

  const slots: OpenSlot[] = raw.map((s) => {
    const startLocal = DateTime.fromISO(s.start).setZone(timeZone);
    return {
      label: startLocal.toFormat('h:mm a'),
      startISO: DateTime.fromISO(s.start).toUTC().toISO()!,
      endISO: DateTime.fromISO(s.end).toUTC().toISO()!,
    };
  });

  return { slots, timeZone };
}

export interface BookAppointmentInput {
  startISO: string;
  durationMinutes?: number;
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
  conversationId?: string;
}

export interface BookedAppointment {
  eventId: string;
  startISO: string;
  endISO: string;
  /** Spoken-friendly confirmation in business-hours timezone. */
  confirmation: string;
}

/**
 * Create the Cal.com booking. No manual "is this slot still free" recheck
 * here (unlike lib/googleCalendar.ts's bookAppointment, paired with a
 * recheck in the book-appointment route) -- Cal.com's own booking creation
 * validates availability server-side and rejects a conflicting request on
 * its own, so a separate recheck would just be a redundant round-trip.
 * The route maps a rejection here to a 409 for the agent to react to.
 *
 * Only `name` is required by Cal.com's API itself (`timeZone` is filled in
 * here too, also required) -- `email` is NOT required by the API schema,
 * despite that being a common assumption. It CAN still be required in
 * practice if the specific Event Type's booking form has "email" marked
 * required in Cal.com's dashboard (Event Type -> Advanced -> Booking
 * questions) -- check there if a phone-only booking gets rejected.
 */
/**
 * Cal.com requires E.164 for attendee.phoneNumber and rejects anything else
 * with a bare "invalid number". A caller speaking their number gives you
 * "416-222-2323" -- no country code -- and the agent passes it straight
 * through, so the booking fails and the agent starts asking the caller to
 * repeat themselves. Observed on a real call 2026-08-10: three rounds of
 * "that number seems invalid, could you check it?" before the caller
 * happened to say "plus one" out loud.
 *
 * ⚠️ Assumes +1 (North America) when no country code is present. Revisit
 * before taking calls from other regions -- a wrong country code is worse
 * than none, since Cal.com will accept it and the number will be unreachable.
 */
export function toE164(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) return '+' + trimmed.slice(1).replace(/\D/g, '');

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;              // 4162947177
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`; // 14162947177
  // Anything else: hand it over untouched and let Cal.com decide, rather than
  // guessing at a country code we have no basis for.
  return trimmed;
}

export async function bookAppointment(input: BookAppointmentInput): Promise<BookedAppointment> {
  const timeZone = getBusinessTimeZone();
  const eventTypeId = getEventTypeId();

  const attendee: Record<string, unknown> = { name: input.name, timeZone };
  if (input.email) attendee.email = input.email;
  if (input.phone) attendee.phoneNumber = toE164(input.phone);

  const body: Record<string, unknown> = {
    start: input.startISO,
    eventTypeId,
    attendee,
  };
  if (input.durationMinutes) body.lengthInMinutes = input.durationMinutes;

  // Assumes the Event Type has a booking field with slug "notes" (Cal.com's
  // default "Additional notes" field on most templates) -- if your Event
  // Type doesn't have one, this is silently ignored by Cal.com rather than
  // erroring, per bookingFieldsResponses being additionalProperties:true.
  const bookingFieldsResponses: Record<string, string> = {};
  if (input.notes) bookingFieldsResponses.notes = input.notes;
  if (Object.keys(bookingFieldsResponses).length) {
    body.bookingFieldsResponses = bookingFieldsResponses;
  }
  if (input.conversationId) {
    body.metadata = { conversation_id: input.conversationId };
  }

  const created = await calFetch('/v2/bookings', {
    method: 'POST',
    apiVersion: '2026-02-25',
    body: JSON.stringify(body),
  });

  const data = created?.data;
  if (!data?.start || !data?.end) {
    throw new Error(`Unexpected Cal.com booking response shape: ${JSON.stringify(created)}`);
  }

  const startLocal = DateTime.fromISO(data.start).setZone(timeZone);
  const confirmation = `${startLocal.toFormat('cccc, LLLL d')} at ${startLocal.toFormat('h:mm a')} (${startLocal.offsetNameShort})`;

  return {
    eventId: data.uid ?? String(data.id),
    startISO: data.start,
    endISO: data.end,
    confirmation,
  };
}

export interface UpcomingBooking {
  eventId: string;
  startISO: string;
  endISO: string;
  /** Spoken-friendly label in business-hours timezone, e.g. "Tuesday, March 4 at 9:00 AM". */
  label: string;
  attendeeName?: string;
  attendeeEmail?: string;
  attendeePhone?: string;
}

/**
 * Look up a caller's own upcoming booking(s) so calcom_cancel_appointment
 * has an event_id to act on -- a caller calling back to cancel doesn't
 * carry a booking uid around, so this resolves one from whatever
 * identifying info they give instead. Scoped to this app's own
 * CAL_EVENT_TYPE_ID and status=upcoming, so it only ever surfaces
 * cancellable appointments this integration actually booked.
 *
 * email uses Cal.com's real server-side attendeeEmail filter (exact match)
 * -- prefer it when available. name falls back to attendeeName (also
 * server-side, looser match). phone has no server-side filter in Cal.com's
 * API at all, so it's applied client-side, matching against each result's
 * attendee.phoneNumber by comparing the last 7 digits (tolerates spoken
 * numbers coming back with/without a country code or formatting).
 */
export async function findUpcomingBookings(params: {
  name?: string;
  email?: string;
  phone?: string;
}): Promise<UpcomingBooking[]> {
  const eventTypeId = getEventTypeId();
  const timeZone = getBusinessTimeZone();

  const query = new URLSearchParams({
    status: 'upcoming',
    eventTypeId: String(eventTypeId),
    limit: '50',
  });
  if (params.email) query.set('attendeeEmail', params.email);
  else if (params.name) query.set('attendeeName', params.name);

  const res = await calFetch(`/v2/bookings?${query.toString()}`, {
    method: 'GET',
    apiVersion: '2026-05-01',
  });

  const raw: any[] = Array.isArray(res?.data) ? res.data : [];
  const phoneDigits = params.phone ? params.phone.replace(/\D/g, '').slice(-7) : null;

  return raw
    .filter((b) => b?.status !== 'cancelled' && b?.uid && b?.start && b?.end)
    .filter((b) => {
      if (!phoneDigits) return true;
      const attendees: any[] = b.attendees ?? [];
      return attendees.some(
        (a) => typeof a?.phoneNumber === 'string' && a.phoneNumber.replace(/\D/g, '').endsWith(phoneDigits)
      );
    })
    .map((b) => {
      const startLocal = DateTime.fromISO(b.start).setZone(timeZone);
      const attendee = (b.attendees ?? [])[0] ?? {};
      return {
        eventId: b.uid as string,
        startISO: DateTime.fromISO(b.start).toUTC().toISO()!,
        endISO: DateTime.fromISO(b.end).toUTC().toISO()!,
        label: `${startLocal.toFormat('cccc, LLLL d')} at ${startLocal.toFormat('h:mm a')}`,
        attendeeName: attendee.name,
        attendeeEmail: attendee.email,
        attendeePhone: attendee.phoneNumber,
      };
    });
}

/**
 * Cancel a Cal.com booking by uid (from findUpcomingBookings, or one the
 * agent already has from bookAppointment's own response earlier in the
 * same call). Cal.com returns a 400 if the booking's already cancelled --
 * the route layer maps that to a clean 409 for the agent, same pattern as
 * book_appointment's slot-taken handling.
 */
export async function cancelBooking(
  bookingUid: string,
  cancellationReason?: string
): Promise<{ startISO: string; endISO: string; confirmation: string }> {
  const timeZone = getBusinessTimeZone();
  const body: Record<string, unknown> = {};
  if (cancellationReason) body.cancellationReason = cancellationReason;

  const res = await calFetch(`/v2/bookings/${encodeURIComponent(bookingUid)}/cancel`, {
    method: 'POST',
    apiVersion: '2026-02-25',
    body: JSON.stringify(body),
  });

  const data = res?.data;
  if (!data?.start || !data?.end) {
    throw new Error(`Unexpected Cal.com cancel response shape: ${JSON.stringify(res)}`);
  }

  const startLocal = DateTime.fromISO(data.start).setZone(timeZone);
  const confirmation = `${startLocal.toFormat('cccc, LLLL d')} at ${startLocal.toFormat('h:mm a')} (${startLocal.offsetNameShort})`;

  return {
    startISO: data.start,
    endISO: data.end,
    confirmation,
  };
}
