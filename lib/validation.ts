// Server-side format validation for fields the hybrid gathered_context flow
// flags as "needs a real check", not just passive extraction -- email,
// phone, date so far. Deliberately permissive (this is validating what a
// voice call transcribed, not a web form): the goal is to catch answers
// that are clearly malformed or clearly mis-transcribed (no @ in an email,
// wrong digit count in a phone number), not to reject anything unusual.
// Returns a normalized_value on success so the sheet stores a clean,
// consistent form even if the caller said it in an odd way ("four one six
// two nine four seven one seven seven" -> "+14162947177").

export type FieldType = 'email' | 'phone' | 'date' | 'text';

export interface ValidationResult {
  valid: boolean;
  normalizedValue?: string;
  reason?: string;
}

function validateEmail(raw: string): ValidationResult {
  const value = raw.trim().toLowerCase();
  // Permissive on purpose -- just "looks like an email", not RFC 5322.
  // Voice transcription commonly mangles spacing around the @ and dots
  // ("wojtek at me dot com" usually gets cleaned up by the LLM before this
  // is even called, but this catches what slips through).
  const match = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
  if (!match) {
    return {
      valid: false,
      reason:
        'Does not look like a valid email address (expected something like name@example.com). Ask the caller to repeat it, spelling out the domain if needed.',
    };
  }
  return { valid: true, normalizedValue: value };
}

function validatePhone(raw: string): ValidationResult {
  const digits = raw.replace(/\D/g, '');
  // Accept 10-digit NANP numbers, or 11-digit with a leading 1.
  let normalized: string;
  if (digits.length === 10) {
    normalized = `+1${digits}`;
  } else if (digits.length === 11 && digits.startsWith('1')) {
    normalized = `+${digits}`;
  } else {
    return {
      valid: false,
      reason: `Got ${digits.length} digits, expected a 10-digit North American phone number. Ask the caller to repeat their phone number digit by digit.`,
    };
  }
  return { valid: true, normalizedValue: normalized };
}

const MONTH_NAMES: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, sept: 9, october: 10, oct: 10,
  november: 11, nov: 11, december: 12, dec: 12,
};

function validateDate(raw: string): ValidationResult {
  const value = raw.trim();

  // "May 11 1964" / "May 11, 1964" / "11 May 1964"
  const wordy = value
    .toLowerCase()
    .match(/^(\d{1,2})\s+([a-z]+)\.?,?\s+(\d{4})$|^([a-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/);
  if (wordy) {
    const day = wordy[1] ?? wordy[5];
    const monthName = (wordy[2] ?? wordy[4])?.replace('.', '');
    const year = wordy[3] ?? wordy[6];
    const month = monthName ? MONTH_NAMES[monthName] : undefined;
    if (month && day && year) {
      return finalizeDate(Number(year), month, Number(day));
    }
  }

  // "1964-05-11" or "1964/05/11"
  const iso = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (iso) {
    return finalizeDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  }

  // "5/11/1964" or "05-11-1964" (assume M/D/Y, North American convention)
  const slash = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (slash) {
    return finalizeDate(Number(slash[3]), Number(slash[1]), Number(slash[2]));
  }

  return {
    valid: false,
    reason:
      'Could not parse this as a date. Ask the caller for month, day, and year clearly, e.g. "May 11th, 1964".',
  };
}

function finalizeDate(year: number, month: number, day: number): ValidationResult {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { valid: false, reason: 'Month or day out of range -- ask the caller to repeat the date.' };
  }
  const d = new Date(Date.UTC(year, month - 1, day));
  const roundTrips =
    d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
  if (!roundTrips) {
    return { valid: false, reason: 'Not a real calendar date -- ask the caller to repeat it.' };
  }
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return { valid: true, normalizedValue: `${year}-${mm}-${dd}` };
}

export function validateField(fieldType: FieldType, rawValue: string): ValidationResult {
  const value = (rawValue ?? '').trim();
  if (!value) {
    return { valid: false, reason: 'Empty answer -- ask the caller to answer the question.' };
  }

  switch (fieldType) {
    case 'email':
      return validateEmail(value);
    case 'phone':
      return validatePhone(value);
    case 'date':
      return validateDate(value);
    case 'text':
    default:
      return { valid: true, normalizedValue: value };
  }
}
