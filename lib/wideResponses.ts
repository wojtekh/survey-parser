import { authedFetch, SHEETS_BASE } from './googleSheets';

// One row per caller, one column per question.
//
// The old shape was one row per ANSWER -- conversation_id, question_index,
// question, user_response -- so a 16-question screener produced 16 rows and
// two simultaneous callers interleaved into an unreadable block. Reading one
// person's screener meant filtering column A and reassembling by hand.
//
// This writes what a recruiter actually wants to look at:
//
//   A               B      C          D           E        | F   G   H  ...
//   conversation_id status started_at last_update answered | Q1  Q2  Q3 ...
//                                                          | <question text>
//
// Row 1 is the machine key, row 2 the human label, data from row 3.
//
// Answers are written AS THEY ARRIVE, not batched at the end. That is what
// makes a hangup visible: the row exists from the first answer onward, so a
// caller who drops at Q14 leaves 13 answers and a status that never moved off
// "in progress". A batched write would leave nothing at all to annotate.

/** Fixed columns before the questions start. */
export const ADMIN_COLUMNS = [
  'conversation_id',
  'status',
  'started_at',
  'last_update',
  'answered',
] as const;

const FIRST_QUESTION_COL = ADMIN_COLUMNS.length; // 0-based -> column F
const RESPONSES_TAB = 'responses';

/**
 * What we can honestly say about a call.
 *
 * `terminated` and `completed` are observed -- the screener tool decided them.
 * A hangup is NOT observable: nothing tells us the caller left. It shows up as
 * a row still reading "in progress" long after last_update. Inferred, and
 * labelled as the absence it is rather than dressed up as a detection.
 */
export type CallStatus = 'in progress' | 'terminated' | 'completed';

export interface ResponseColumn {
  /** Column key in row 1 -- the question's id, e.g. "Q1". */
  id: string;
  /** Human label in row 2 -- the question text. */
  text: string;
}

/** 0-based column index to A1 letters. 0 -> A, 25 -> Z, 26 -> AA. */
export function colLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** The A1 column for a question id, or null if it is not in this survey. */
export function columnForQuestion(columns: ResponseColumn[], questionId: string): string | null {
  const i = columns.findIndex((c) => c.id === questionId);
  return i === -1 ? null : colLetter(FIRST_QUESTION_COL + i);
}

/**
 * Write the two header rows. Called once, at push time, when the questions
 * are first known.
 */
export async function writeWideHeader(
  spreadsheetId: string,
  columns: ResponseColumn[]
): Promise<void> {
  const lastCol = colLetter(FIRST_QUESTION_COL + Math.max(columns.length - 1, 0));
  const keys = [...ADMIN_COLUMNS, ...columns.map((c) => c.id)];
  const labels = [...ADMIN_COLUMNS.map(() => ''), ...columns.map((c) => c.text)];

  await authedFetch(`${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: [{ range: `${RESPONSES_TAB}!A1:${lastCol}2`, values: [keys, labels] }],
    }),
  });
}

/**
 * Which sheet row a call is on, keyed by spreadsheet + session.
 *
 * Process-lifetime only, like the other caches here. A miss costs one extra
 * read of column A, not a wrong write -- findRow is the fallback, and it is
 * what makes a server restart mid-call survivable.
 */
const rowCache = new Map<string, number>();
const rowKey = (spreadsheetId: string, sessionId: string) => `${spreadsheetId}::${sessionId}`;

/** Locate an existing row by scanning column A. Only on a cache miss. */
async function findRow(spreadsheetId: string, sessionId: string): Promise<number | null> {
  const data = await authedFetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/${RESPONSES_TAB}!A:A`
  ).catch(() => null);
  const values: string[][] = data?.values ?? [];
  for (let i = 0; i < values.length; i++) {
    if (values[i]?.[0] === sessionId) return i + 1; // 1-based sheet row
  }
  return null;
}

export interface WideTurn {
  sessionId: string;
  /** The question just answered. Must match a column id. */
  questionId: string;
  answer: string;
  /** How many questions this caller has answered, including this one. */
  answeredCount: number;
  status: CallStatus;
}

/**
 * Record one answer, creating the caller's row on the first turn.
 *
 * Cost: TWO Sheets calls on the first answer of a call (a column-A lookup,
 * then the append), one on every turn after. Dograh's function-call timeout is
 * a hard 5 seconds, so that first turn is the one to watch.
 *
 * The lookup is not skippable. After a server restart the row cache is empty
 * but the row exists, and an unchecked append would give that caller a second
 * row -- their answers split across two, with no way to tell afterwards which
 * half came first. Paying one read on turn one buys that away.
 *
 * From turn two it is a single call: the append response carries
 * `updates.updatedRange` (e.g. "responses!A7:AI7"), so the row number comes
 * back from the write itself rather than a follow-up read.
 */
export async function recordWideAnswer(
  spreadsheetId: string,
  columns: ResponseColumn[],
  turn: WideTurn
): Promise<void> {
  const answerCol = columnForQuestion(columns, turn.questionId);
  if (!answerCol) {
    throw new Error(
      `Question "${turn.questionId}" has no column in this survey's responses tab. The sheet was pushed with a different question set -- re-push the survey.`
    );
  }

  const now = new Date().toISOString();
  const answered = `${turn.answeredCount}/${columns.length}`;
  const key = rowKey(spreadsheetId, turn.sessionId);
  const lastCol = colLetter(FIRST_QUESTION_COL + Math.max(columns.length - 1, 0));

  let row = rowCache.get(key) ?? null;
  if (row === null) row = await findRow(spreadsheetId, turn.sessionId);

  // --- first turn for this caller: append the whole row at once ---
  if (row === null) {
    const values: string[] = new Array(FIRST_QUESTION_COL + columns.length).fill('');
    values[0] = turn.sessionId;
    values[1] = turn.status;
    values[2] = now;
    values[3] = now;
    values[4] = answered;
    values[FIRST_QUESTION_COL + columns.findIndex((c) => c.id === turn.questionId)] = turn.answer;

    const res = await authedFetch(
      `${SHEETS_BASE}/${spreadsheetId}/values/${RESPONSES_TAB}!A:${lastCol}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      { method: 'POST', body: JSON.stringify({ values: [values] }) }
    );

    const updated: string | undefined = res?.updates?.updatedRange;
    const m = updated?.match(/![A-Z]+(\d+)/);
    if (m) rowCache.set(key, Number(m[1]));
    return;
  }

  // --- later turns: update only the cells that changed ---
  rowCache.set(key, row);
  await authedFetch(`${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      valueInputOption: 'RAW',
      data: [
        // started_at (C) is deliberately not in this list -- it is written once.
        { range: `${RESPONSES_TAB}!B${row}`, values: [[turn.status]] },
        { range: `${RESPONSES_TAB}!D${row}:E${row}`, values: [[now, answered]] },
        { range: `${RESPONSES_TAB}!${answerCol}${row}`, values: [[turn.answer]] },
      ],
    }),
  });
}

/**
 * Write a whole call in one row. For the end-of-call flow, which already holds
 * every answer -- no per-turn updating needed, and no row to find.
 */
export async function writeWideRow(
  spreadsheetId: string,
  columns: ResponseColumn[],
  input: { sessionId: string; answers: Record<string, string>; status: CallStatus }
): Promise<void> {
  const now = new Date().toISOString();
  const values: string[] = new Array(FIRST_QUESTION_COL + columns.length).fill('');
  let answered = 0;
  columns.forEach((c, i) => {
    const v = input.answers[c.id];
    if (v !== undefined && v !== null && v !== '') {
      values[FIRST_QUESTION_COL + i] = String(v);
      answered += 1;
    }
  });
  values[0] = input.sessionId;
  values[1] = input.status;
  values[2] = now;
  values[3] = now;
  values[4] = `${answered}/${columns.length}`;

  const lastCol = colLetter(FIRST_QUESTION_COL + Math.max(columns.length - 1, 0));
  await authedFetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/${RESPONSES_TAB}!A:${lastCol}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { method: 'POST', body: JSON.stringify({ values: [values] }) }
  );
}

/**
 * Set only the status cell.
 *
 * Exists so the answer write can stay in parallel with the classification
 * call. The final status is not known until the classifier returns, and
 * waiting for it would turn max(sheets, model) into sheets + model -- against
 * a hard 5s tool timeout. So the answer goes in as "in progress", and this
 * flips the cell afterwards, on the last turn only.
 */
export async function setCallStatus(
  spreadsheetId: string,
  sessionId: string,
  status: CallStatus
): Promise<void> {
  const key = rowKey(spreadsheetId, sessionId);
  const row = rowCache.get(key) ?? (await findRow(spreadsheetId, sessionId));
  if (row === null) return; // nothing written for this call yet -- nothing to mark
  rowCache.set(key, row);
  await authedFetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/${RESPONSES_TAB}!B${row}?valueInputOption=RAW`,
    { method: 'PUT', body: JSON.stringify({ values: [[status]] }) }
  );
}

/** Forget a call's cached row. Call once the row will not change again. */
export function clearRowCache(spreadsheetId: string, sessionId: string): void {
  rowCache.delete(rowKey(spreadsheetId, sessionId));
}
