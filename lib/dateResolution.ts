import { DateTime } from 'luxon';

// Shared, backend-agnostic helpers for turning what a voice caller says
// into concrete dates/durations. Used by both lib/googleCalendar.ts and
// lib/calcom.ts -- nothing here is specific to either booking backend,
// it's purely about interpreting the caller/agent's input the same way
// regardless of where the appointment actually gets booked.

export function getBusinessTimeZone(): string {
  // IANA name, e.g. "America/New_York". Everything below (business hours,
  // slot generation, spoken confirmations) is interpreted in this zone.
  return process.env.BUSINESS_TIME_ZONE || 'America/New_York';
}

export function getDefaultDurationMinutes(): number {
  return Number(process.env.APPOINTMENT_DURATION_MINUTES ?? 30);
}

/**
 * Parse a duration_minutes value from a tool call body, tolerating a
 * numeric string ("30") as well as a real JSON number -- some HTTP tool
 * integrations serialize "number"-typed parameters as strings, and a
 * strict `typeof === 'number'` check would silently fall back to the
 * default instead of using what was actually passed. Falls back to
 * getDefaultDurationMinutes() for anything missing, non-numeric, or <= 0.
 */
export function parseDurationMinutes(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : getDefaultDurationMinutes();
}

const WEEKDAY_NAMES = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
];

/**
 * Turn what a voice agent naturally hears ("today", "tomorrow", "next
 * Tuesday", "Monday, August 3rd") into a "YYYY-MM-DD" in
 * BUSINESS_TIME_ZONE, resolved server-side against the real current date
 * -- deliberately NOT relying on the LLM to do this date arithmetic
 * itself. Phone callers say relative dates far more than literal ones,
 * and Dograh has no confirmed way to hand the model "today's date" as
 * context (see dograh/tools-setup.md's notes on unreliable template
 * variables) -- so the agent should just pass through whatever the
 * caller said, close to verbatim, and this resolves it.
 */
export function resolveRequestedDate(raw: string): string {
  const timeZone = getBusinessTimeZone();
  const now = DateTime.now().setZone(timeZone).startOf('day');
  const normalized = raw.trim().toLowerCase();

  if (normalized === 'today') return now.toFormat('yyyy-MM-dd');
  if (normalized === 'tomorrow') return now.plus({ days: 1 }).toFormat('yyyy-MM-dd');

  // Callers phrase "the Wednesday of next calendar week" several different
  // ways -- "next Wednesday", "next week Wednesday", "Wednesday next week"
  // all confirmed heard on real test calls. All three get treated
  // identically (same nearest-upcoming-weekday semantics, see the comment
  // below on why "next" doesn't always mean +7 days).
  const nextWeekPrefixMatch = normalized.match(/^next\s+week\s+(\w+)$/);
  const nextWeekSuffixMatch = normalized.match(/^(\w+)\s+next\s+week$/);
  const nextPlainMatch = normalized.match(/^next\s+(\w+)$/);
  const nextMatch = nextWeekPrefixMatch ?? nextWeekSuffixMatch ?? nextPlainMatch;
  const weekdayWord = nextMatch ? nextMatch[1] : normalized;
  const weekdayIndex = WEEKDAY_NAMES.indexOf(weekdayWord); // 0=Monday ... 6=Sunday

  if (weekdayIndex !== -1) {
    const targetWeekday = weekdayIndex + 1; // luxon: 1=Monday ... 7=Sunday
    let daysAhead = (targetWeekday - now.weekday + 7) % 7;
    // "next Tuesday" and plain "Tuesday" both mean the nearest upcoming
    // Tuesday in the common, colloquial reading -- callers consistently
    // expect these to match (confirmed against a real test call: "next
    // Tuesday" said on a Friday was expected to mean 4 days out, not 11).
    // The one case where "next" actually adds a week: if today itself IS
    // that weekday, daysAhead comes out 0 -- plain "Tuesday" on a Tuesday
    // means today, but "next Tuesday" on a Tuesday means a week from now,
    // not today. That's the only place the "next" prefix changes anything.
    if (nextMatch && daysAhead === 0) daysAhead = 7;
    return now.plus({ days: daysAhead }).toFormat('yyyy-MM-dd');
  }

  // Falls through here for anything that isn't "today"/"tomorrow"/a bare
  // weekday name -- notably literal YYYY-MM-DD (handled below, first
  // format tried), and calendar-style phrasing real callers actually use,
  // like "Monday, August 3rd" or "August 4th" (confirmed against a real
  // test call where the agent passed exactly these). A leading weekday
  // name is stripped first since it's redundant once we have month+day;
  // ordinal suffixes (1st/2nd/3rd/4th) are stripped since luxon's parser
  // doesn't understand them.
  let cleaned = raw.trim().replace(/^(?:\w+day),?\s+/i, '');
  cleaned = cleaned.replace(/(\d+)(st|nd|rd|th)\b/gi, '$1').replace(/\s+/g, ' ').trim();

  const currentYear = now.year;
  const candidates = [
    { text: cleaned, format: 'yyyy-MM-dd' },
    { text: cleaned, format: 'MMMM d, yyyy' },
    { text: cleaned, format: 'MMMM d yyyy' },
    { text: `${cleaned} ${currentYear}`, format: 'MMMM d yyyy' },
    { text: cleaned, format: 'MMM d, yyyy' },
    { text: `${cleaned} ${currentYear}`, format: 'MMM d yyyy' },
    { text: cleaned, format: 'M/d/yyyy' },
    { text: `${cleaned}/${currentYear}`, format: 'M/d/yyyy' },
  ];

  for (const { text, format } of candidates) {
    const parsed = DateTime.fromFormat(text, format, { zone: timeZone });
    if (parsed.isValid) {
      // A bare "month day" with no year defaults to the current year; if
      // that's already more than a day in the past, the caller almost
      // certainly meant next year (e.g. booking in December for January).
      const resolved = parsed < now.minus({ days: 1 }) ? parsed.plus({ years: 1 }) : parsed;
      return resolved.toFormat('yyyy-MM-dd');
    }
  }

  return raw.trim(); // give up -- caller validates the YYYY-MM-DD format and surfaces a clear error
}
