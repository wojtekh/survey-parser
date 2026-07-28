import { JWT } from 'google-auth-library';
import { DateTime } from 'luxon';
import { getBusinessTimeZone, getDefaultDurationMinutes } from './dateResolution';

// Date/duration parsing (resolveRequestedDate, parseDurationMinutes,
// getBusinessTimeZone, getDefaultDurationMinutes) now lives in
// lib/dateResolution.ts -- shared with lib/calcom.ts, nothing about
// interpreting caller input is specific to Google. Re-exported below so
// existing imports from '@/lib/googleCalendar' keep working unchanged.
export { resolveRequestedDate, parseDurationMinutes, getBusinessTimeZone, getDefaultDurationMinutes } from './dateResolution';

// Appointment booking for the voice agent -- same domain-wide-delegation
// pattern as lib/googleSheets.ts (impersonate USER_GOOGLE_EMAIL so events
// are created as a real Workspace user, not the bare service account), but
// a separate cached JWT client since the scopes differ. Requires:
//   1. Google Calendar API enabled in the same Cloud Console project.
//   2. The `https://www.googleapis.com/auth/calendar` scope added to the
//      service account's existing domain-wide delegation entry in Workspace
//      admin (Security -> API Controls -> Domain-wide Delegation) -- it's
//      additive, doesn't replace the Sheets/Drive scopes already there.
// See README for the full walkthrough.
//
// GOOGLE_CALENDAR_ID controls which calendar gets booked into (defaults to
// USER_GOOGLE_EMAIL's primary calendar). Deliberately its own env var
// rather than hardcoded 'primary' -- copy this file + its two API routes
// and point GOOGLE_CALENDAR_ID at a different calendar to stand up a second,
// independent booking tool (e.g. a separate line of business) without
// touching anything else.

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';

let cachedClient: JWT | null = null;

function getAuthClient(): JWT {
  if (cachedClient) return cachedClient;

  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (!email || !rawKey) {
    throw new Error(
      'GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY not set. See README for setup.'
    );
  }

  // Same double-backslash normalization as lib/googleSheets.ts -- Coolify
  // has been observed to double every backslash in stored env var values,
  // turning "\n" into "\\n".
  const normalizedKey = rawKey.replace(/\\+n/g, '\n').trim();

  const subject = process.env.USER_GOOGLE_EMAIL || undefined;

  cachedClient = new JWT({
    email,
    key: normalizedKey,
    subject,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });
  return cachedClient;
}

async function authedFetch(url: string, init?: RequestInit): Promise<any> {
  const client = getAuthClient();
  const { token } = await client.getAccessToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(
      `Google Calendar API error (${res.status}) on ${init?.method ?? 'GET'} ${url}: ${body}`
    );
  }
  if (res.status === 204) return null; // e.g. event delete has no body
  return res.json();
}

export function getCalendarId(): string {
  return process.env.GOOGLE_CALENDAR_ID || 'primary';
}

function getBusinessHours(): { startHour: number; endHour: number } {
  const startHour = Number(process.env.BUSINESS_HOURS_START ?? 9);
  const endHour = Number(process.env.BUSINESS_HOURS_END ?? 17);
  return { startHour, endHour };
}

/** 1 = Monday ... 7 = Sunday (luxon's weekday numbering). Defaults to Mon-Fri. */
function getBusinessDays(): number[] {
  const raw = process.env.BUSINESS_DAYS;
  if (!raw) return [1, 2, 3, 4, 5];
  return raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n >= 1 && n <= 7);
}

export interface BusySlot {
  start: string; // ISO
  end: string; // ISO
}

/** Raw busy blocks from Google's freeBusy API for an arbitrary ISO range. */
export async function getBusySlots(timeMinISO: string, timeMaxISO: string): Promise<BusySlot[]> {
  const calendarId = getCalendarId();
  const data = await authedFetch(`${CALENDAR_BASE}/freeBusy`, {
    method: 'POST',
    body: JSON.stringify({
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      items: [{ id: calendarId }],
    }),
  });
  const entry = data.calendars?.[calendarId];
  if (entry?.errors?.length) {
    throw new Error(
      `Google Calendar freeBusy error for calendar "${calendarId}": ${JSON.stringify(entry.errors)}. ` +
        `Check GOOGLE_CALENDAR_ID and that this calendar is shared with the service account (or is the impersonated user's own calendar).`
    );
  }
  return entry?.busy ?? [];
}

export interface OpenSlot {
  /** Spoken-friendly label in business-hours timezone, e.g. "9:00 AM". */
  label: string;
  startISO: string;
  endISO: string;
}

function overlaps(aStart: DateTime, aEnd: DateTime, bStart: DateTime, bEnd: DateTime): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Open business-hours slots for one calendar date, minus whatever's already
 * busy on GOOGLE_CALENDAR_ID. Fixed-window generator (slots start on the
 * hour/half-hour etc. based on durationMinutes) -- not a full scheduling
 * engine, but enough for a voice agent to read out a handful of options.
 *
 * `dateISO` is a plain "YYYY-MM-DD" interpreted in BUSINESS_TIME_ZONE via
 * luxon, which handles DST transitions correctly (a hand-rolled UTC-offset
 * calculation would silently misfire twice a year -- this is why luxon is a
 * dependency here rather than plain Date math).
 */
export async function getAvailableSlots(
  dateISO: string,
  durationMinutes: number = getDefaultDurationMinutes()
): Promise<{ slots: OpenSlot[]; timeZone: string; isBusinessDay: boolean }> {
  const timeZone = getBusinessTimeZone();
  const { startHour, endHour } = getBusinessHours();
  const businessDays = getBusinessDays();

  const dayStart = DateTime.fromISO(dateISO, { zone: timeZone }).startOf('day');
  if (!dayStart.isValid) {
    throw new Error(`Invalid date "${dateISO}". Expected YYYY-MM-DD.`);
  }

  const isBusinessDay = businessDays.includes(dayStart.weekday);
  if (!isBusinessDay) {
    return { slots: [], timeZone, isBusinessDay: false };
  }

  const windowStart = dayStart.set({ hour: startHour, minute: 0 });
  const windowEnd = dayStart.set({ hour: endHour, minute: 0 });
  const now = DateTime.now().setZone(timeZone);

  const busy = await getBusySlots(windowStart.toUTC().toISO()!, windowEnd.toUTC().toISO()!);
  const busyRanges = busy.map((b) => ({
    start: DateTime.fromISO(b.start),
    end: DateTime.fromISO(b.end),
  }));

  const slots: OpenSlot[] = [];
  let cursor = windowStart;
  while (cursor.plus({ minutes: durationMinutes }) <= windowEnd) {
    const slotEnd = cursor.plus({ minutes: durationMinutes });

    const inPast = cursor < now;
    const isBusy = busyRanges.some((b) => overlaps(cursor, slotEnd, b.start, b.end));

    if (!inPast && !isBusy) {
      slots.push({
        label: cursor.toFormat('h:mm a'),
        startISO: cursor.toUTC().toISO()!,
        endISO: slotEnd.toUTC().toISO()!,
      });
    }

    cursor = cursor.plus({ minutes: durationMinutes });
  }

  return { slots, timeZone, isBusinessDay: true };
}

export interface BookAppointmentInput {
  startISO: string;
  endISO: string;
  name: string;
  phone?: string;
  email?: string;
  notes?: string;
  conversationId?: string;
}

export interface BookedAppointment {
  eventId: string;
  htmlLink: string;
  startISO: string;
  endISO: string;
  /** Spoken-friendly confirmation in business-hours timezone. */
  confirmation: string;
}

/**
 * Create the calendar event. Callers should re-check getAvailableSlots (or
 * at least getBusySlots for this exact window) immediately beforehand to
 * guard against a slot being taken between when it was offered and when the
 * caller confirms -- this function itself does NOT re-check, it just books
 * whatever window it's given (see the /api/agent/book-appointment route,
 * which does the race-condition check before calling this).
 */
export async function bookAppointment(input: BookAppointmentInput): Promise<BookedAppointment> {
  const calendarId = getCalendarId();
  const timeZone = getBusinessTimeZone();
  const titlePrefix = process.env.APPOINTMENT_TITLE_PREFIX || 'Appointment';

  const descriptionLines = [
    input.phone ? `Phone: ${input.phone}` : null,
    input.email ? `Email: ${input.email}` : null,
    input.notes ? `Notes: ${input.notes}` : null,
    input.conversationId ? `Booked via voice agent, conversation_id: ${input.conversationId}` : null,
  ].filter((line): line is string => Boolean(line));

  const event: Record<string, unknown> = {
    summary: `${titlePrefix} - ${input.name}`,
    description: descriptionLines.join('\n'),
    start: { dateTime: input.startISO, timeZone },
    end: { dateTime: input.endISO, timeZone },
  };

  // Only add an attendee (triggers a Calendar invite email) if we have a
  // real email address -- voice callers frequently only give a phone
  // number, and Calendar's API rejects malformed attendee emails outright.
  if (input.email) {
    event.attendees = [{ email: input.email, displayName: input.name }];
  }

  const sendUpdates = input.email ? 'all' : 'none';
  const created = await authedFetch(
    `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${sendUpdates}`,
    { method: 'POST', body: JSON.stringify(event) }
  );

  const startLocal = DateTime.fromISO(input.startISO).setZone(timeZone);
  const confirmation = `${startLocal.toFormat('cccc, LLLL d')} at ${startLocal.toFormat('h:mm a')} (${startLocal.offsetNameShort})`;

  return {
    eventId: created.id,
    htmlLink: created.htmlLink,
    startISO: input.startISO,
    endISO: input.endISO,
    confirmation,
  };
}
