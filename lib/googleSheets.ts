import { JWT } from 'google-auth-library';

// Multi-survey design: every survey gets its OWN spreadsheet (created from
// scratch, shared with you automatically), and the spreadsheet's own ID
// doubles as the survey's identifier -- no separate survey_id to keep in
// sync. One fixed "index" spreadsheet (GOOGLE_INDEX_SHEET_ID) keeps a
// running list of every survey created, so there's always a place to find
// the link back to a given survey's sheet. That index sheet needs a
// "surveys" tab; a header row is written to it automatically on first use
// if missing.
//
// Uses google-auth-library + plain fetch() against the Sheets and Drive
// REST APIs rather than the `googleapis` package (see README for why).

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_BASE = 'https://www.googleapis.com/drive/v3';
const INDEX_TAB = 'surveys';

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

  // Diagnostic only -- no secret material logged, just shape/length info,
  // to debug env-var corruption between the hosting panel and the running
  // container without printing the key itself anywhere.
  const trimmed = rawKey.trim();
  const endMarker = '-----END PRIVATE KEY-----';
  const endIdx = trimmed.indexOf(endMarker);
  console.log('[googleSheets] private key diagnostics:', {
    length: rawKey.length,
    startsWithQuote: rawKey.startsWith('"') || rawKey.startsWith("'"),
    endsWithQuote: rawKey.endsWith('"') || rawKey.endsWith("'"),
    startsWithBegin: trimmed.startsWith('-----BEGIN PRIVATE KEY-----'),
    endsWithEnd: trimmed.endsWith(endMarker) || trimmed.endsWith(endMarker + '\\n'),
    endMarkerFound: endIdx !== -1,
    charsAfterEndMarker: endIdx !== -1 ? trimmed.length - (endIdx + endMarker.length) : null,
    literalBackslashNCount: (rawKey.match(/\\n/g) || []).length,
    realNewlineCount: (rawKey.match(/\n/g) || []).length,
    containsCarriageReturn: rawKey.includes('\r'),
    // Does another env var's name appear inside this value? Proves line
    // merging in the hosting panel if true -- names only, no values leaked.
    containsOtherVarNames: ['GOOGLE_INDEX_SHEET_ID', 'USER_GOOGLE_EMAIL', 'AGENT_TOOLS_SECRET', 'ANTHROPIC_API_KEY']
      .filter((name) => rawKey.includes(name)),
    // Char codes only (never the characters/content) for whatever trails
    // the END marker -- safe to log, tells us if it's whitespace, a stray
    // escape sequence, or something else.
    trailingCharCodesAfterEndMarker:
      endIdx !== -1
        ? Array.from(trimmed.slice(endIdx + endMarker.length)).map((c) => c.charCodeAt(0))
        : null,
    beginMarkerOccurrences: (rawKey.match(/-----BEGIN PRIVATE KEY-----/g) || []).length,
    endMarkerOccurrences: (rawKey.match(/-----END PRIVATE KEY-----/g) || []).length,
    lengthTrimmedAway: rawKey.length - trimmed.length,
  });

  const normalizedKey = rawKey.replace(/\\n/g, '\n').trim();

  cachedClient = new JWT({
    email,
    key: normalizedKey,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      // drive.file (not full drive access) -- only grants access to files
      // this service account itself creates, which is exactly what sharing
      // a newly-created survey spreadsheet needs.
      'https://www.googleapis.com/auth/drive.file',
    ],
  });
  return cachedClient;
}

function normalizeSpreadsheetId(raw: string): string {
  const urlMatch = raw.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return urlMatch ? urlMatch[1] : raw.trim();
}

function getIndexSheetId(): string {
  const raw = process.env.GOOGLE_INDEX_SHEET_ID;
  if (!raw) {
    throw new Error(
      'GOOGLE_INDEX_SHEET_ID not set. Create one empty Google Sheet, share it with your service account, and add its ID to .env. See README.'
    );
  }
  return normalizeSpreadsheetId(raw);
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
    throw new Error(`Google API error (${res.status}): ${body}`);
  }
  return res.json();
}

/** Create a brand-new spreadsheet with "questions" and "responses" tabs, headers pre-filled. */
export async function createSurveySpreadsheet(
  name: string
): Promise<{ spreadsheetId: string; url: string }> {
  const created = await authedFetch(SHEETS_BASE, {
    method: 'POST',
    body: JSON.stringify({
      properties: { title: name },
      sheets: [{ properties: { title: 'questions' } }, { properties: { title: 'responses' } }],
    }),
  });

  const spreadsheetId: string = created.spreadsheetId;
  const url: string = created.spreadsheetUrl;

  await authedFetch(
    `${SHEETS_BASE}/${spreadsheetId}/values:batchUpdate`,
    {
      method: 'POST',
      body: JSON.stringify({
        valueInputOption: 'RAW',
        data: [
          { range: 'questions!A1', values: [['questions']] },
          {
            range: 'responses!A1:D1',
            values: [['conversation_id', 'question_index', 'question', 'user_response']],
          },
        ],
      }),
    }
  );

  return { spreadsheetId, url };
}

/** Give a Google account edit access to a spreadsheet the service account created. */
export async function shareSpreadsheet(spreadsheetId: string, email: string): Promise<void> {
  await authedFetch(`${DRIVE_BASE}/files/${spreadsheetId}/permissions`, {
    method: 'POST',
    body: JSON.stringify({ role: 'writer', type: 'user', emailAddress: email }),
  });
}

/** Overwrite the questions tab of a specific survey's spreadsheet (row 1 header kept). */
export async function writeQuestions(spreadsheetId: string, questions: string[]): Promise<void> {
  await authedFetch(`${SHEETS_BASE}/${spreadsheetId}/values/questions!A2:A10000:clear`, {
    method: 'POST',
  });

  await authedFetch(`${SHEETS_BASE}/${spreadsheetId}/values/questions!A1?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [['questions'], ...questions.map((q) => [q])] }),
  });
}

export async function getAllQuestions(spreadsheetId: string): Promise<string[]> {
  const data = await authedFetch(`${SHEETS_BASE}/${spreadsheetId}/values/questions!A2:A10000`);
  const values: string[][] = data.values ?? [];
  return values.map((row) => row[0]).filter((v): v is string => Boolean(v));
}

export async function getAnsweredCount(
  spreadsheetId: string,
  conversationId: string
): Promise<number> {
  const data = await authedFetch(`${SHEETS_BASE}/${spreadsheetId}/values/responses!A2:A100000`);
  const values: string[][] = data.values ?? [];
  return values.filter((row) => row[0] === conversationId).length;
}

export async function appendResponse(
  spreadsheetId: string,
  row: { conversationId: string; questionIndex: number; question: string; answer: string }
): Promise<void> {
  await authedFetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/responses!A:D:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      body: JSON.stringify({
        values: [[row.conversationId, row.questionIndex, row.question, row.answer]],
      }),
    }
  );
}

export interface SurveyIndexEntry {
  spreadsheetId: string;
  name: string;
  url: string;
  createdAt: string;
}

/**
 * Make sure the index sheet has a "surveys" tab with a header row.
 * Idempotent, and tolerant of GOOGLE_INDEX_SHEET_ID pointing at any
 * existing spreadsheet (including one that already has other tabs, like
 * your first survey's own questions/responses sheet) -- creates the
 * "surveys" tab if it isn't already there instead of erroring.
 */
async function ensureIndexHeader(): Promise<void> {
  const indexId = getIndexSheetId();

  const meta = await authedFetch(`${SHEETS_BASE}/${indexId}?fields=sheets.properties.title`);
  const titles: string[] = (meta.sheets ?? []).map((s: any) => s.properties?.title);

  if (!titles.includes(INDEX_TAB)) {
    await authedFetch(`${SHEETS_BASE}/${indexId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: INDEX_TAB } } }],
      }),
    });
  }

  const data = await authedFetch(`${SHEETS_BASE}/${indexId}/values/${INDEX_TAB}!A1:D1`).catch(
    () => null
  );
  if (data?.values?.length) return;

  await authedFetch(`${SHEETS_BASE}/${indexId}/values/${INDEX_TAB}!A1:D1?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [['spreadsheet_id', 'name', 'url', 'created_at']] }),
  });
}

export async function addSurveyToIndex(entry: SurveyIndexEntry): Promise<void> {
  await ensureIndexHeader();
  const indexId = getIndexSheetId();
  await authedFetch(
    `${SHEETS_BASE}/${indexId}/values/${INDEX_TAB}!A:D:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      body: JSON.stringify({
        values: [[entry.spreadsheetId, entry.name, entry.url, entry.createdAt]],
      }),
    }
  );
}

export async function listSurveys(): Promise<SurveyIndexEntry[]> {
  const indexId = getIndexSheetId();
  const data = await authedFetch(`${SHEETS_BASE}/${indexId}/values/${INDEX_TAB}!A2:D10000`).catch(
    () => null
  );
  const values: string[][] = data?.values ?? [];
  return values
    .filter((row) => row[0])
    .map((row) => ({
      spreadsheetId: row[0],
      name: row[1] ?? '',
      url: row[2] ?? '',
      createdAt: row[3] ?? '',
    }))
    .reverse(); // newest first
}

export { normalizeSpreadsheetId };
