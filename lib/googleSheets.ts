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

  // Some hosting panels (observed with Coolify) double every backslash in
  // stored env var values, turning the intended single "\n" escape into
  // "\\n". Match one-or-more backslashes before "n" so this works whether
  // the value arrives correctly escaped or double-escaped.
  const normalizedKey = rawKey.replace(/\\+n/g, '\n').trim();

  // Impersonate USER_GOOGLE_EMAIL via domain-wide delegation (set up in
  // Google Workspace admin) rather than acting as the bare service account.
  // Service accounts have essentially no Drive storage of their own, so
  // creating brand-new spreadsheets as the service account fails with a
  // 403 even though reading/writing files already shared with it works
  // fine. Impersonating a real Workspace user routes creation through that
  // user's own storage/ownership instead, which is what Google recommends
  // for exactly this case.
  const subject = process.env.USER_GOOGLE_EMAIL || undefined;

  cachedClient = new JWT({
    email,
    key: normalizedKey,
    subject,
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
    throw new Error(`Google API error (${res.status}) on ${init?.method ?? 'GET'} ${url}: ${body}`);
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

const SCREENER_TAB = 'screener';

/**
 * Persist a screener's full structured question list (skip/terminate/
 * internal-note logic included) to its own tab as a single JSON string --
 * this is what lets a Dograh tool call resolve conditional logic
 * server-side at call time instead of relying on the agent to self-track it
 * from a rendered script. Sheets cells cap out around 50k characters;
 * guard against silently truncating a screener that's grown too large.
 */
export async function writeScreener(spreadsheetId: string, screener: unknown): Promise<void> {
  const json = JSON.stringify(screener);
  if (json.length > 45000) {
    throw new Error(
      `Screener JSON is ${json.length} characters, too close to a Google Sheets cell's ~50k limit. Split this screener into smaller documents.`
    );
  }

  const meta = await authedFetch(`${SHEETS_BASE}/${spreadsheetId}?fields=sheets.properties.title`);
  const titles: string[] = (meta.sheets ?? []).map((s: any) => s.properties?.title);

  if (!titles.includes(SCREENER_TAB)) {
    await authedFetch(`${SHEETS_BASE}/${spreadsheetId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: SCREENER_TAB } } }],
      }),
    });
  }

  await authedFetch(
    `${SHEETS_BASE}/${spreadsheetId}/values/${SCREENER_TAB}!A1?valueInputOption=RAW`,
    {
      method: 'PUT',
      body: JSON.stringify({ values: [[json]] }),
    }
  );
}

/** Read back a screener's raw JSON string. Throws if none was ever pushed. */
export async function getScreenerRaw(spreadsheetId: string): Promise<string> {
  const data = await authedFetch(`${SHEETS_BASE}/${spreadsheetId}/values/${SCREENER_TAB}!A1`).catch(
    () => null
  );
  const value: string | undefined = data?.values?.[0]?.[0];
  if (!value) {
    throw new Error(
      'No screener data found for this survey. Push it from the survey-parser app first (Push to Google Sheet on a screener-type result).'
    );
  }
  return value;
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

/**
 * Remove a survey's row from the index sheet's "surveys" tab, matched by
 * spreadsheetId in column A. Idempotent -- a no-op (not an error) if the
 * row is already gone, so a retried/duplicate delete call is harmless.
 */
export async function removeSurveyFromIndex(spreadsheetId: string): Promise<void> {
  const indexId = getIndexSheetId();

  const meta = await authedFetch(`${SHEETS_BASE}/${indexId}?fields=sheets.properties`);
  const sheetMeta = (meta.sheets ?? []).find(
    (s: any) => s.properties?.title === INDEX_TAB
  );
  if (!sheetMeta) return; // no "surveys" tab at all yet -- nothing to remove

  const data = await authedFetch(`${SHEETS_BASE}/${indexId}/values/${INDEX_TAB}!A:A`).catch(
    () => null
  );
  const values: string[][] = data?.values ?? [];
  // Row 0 is the header ("spreadsheet_id", ...); data starts at row index 1.
  const rowIndex = values.findIndex((row, i) => i > 0 && row[0] === spreadsheetId);
  if (rowIndex === -1) return;

  await authedFetch(`${SHEETS_BASE}/${indexId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: sheetMeta.properties.sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        },
      ],
    }),
  });
}

/** Move a survey's own spreadsheet to Drive Trash (recoverable, not a permanent delete). */
export async function trashSpreadsheet(spreadsheetId: string): Promise<void> {
  await authedFetch(`${DRIVE_BASE}/files/${spreadsheetId}`, {
    method: 'PATCH',
    body: JSON.stringify({ trashed: true }),
  });
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

const INBOUND_TAB = 'inbound_numbers';

export interface InboundMapping {
  phoneNumber: string;
  spreadsheetId: string;
  updatedAt: string;
}

/**
 * Which survey is currently "live" for a given inbound phone number.
 * Lets one small set of inbound Dograh tools serve every survey ever
 * created -- Dograh injects {{initial_context.called_number}} as a Preset
 * Parameter (populated from real telephony data on production inbound
 * calls, confirmed in Dograh's own docs), survey-parser resolves which
 * spreadsheet that number is currently pointed at. Reassigning a number to
 * a new survey is just updating this mapping -- no Dograh tool config ever
 * needs touching again.
 *
 * Lives as its own tab on the same index sheet as the "surveys" tab, same
 * lazy-create-if-missing pattern as ensureIndexHeader.
 */
async function ensureInboundHeader(): Promise<void> {
  const indexId = getIndexSheetId();

  const meta = await authedFetch(`${SHEETS_BASE}/${indexId}?fields=sheets.properties.title`);
  const titles: string[] = (meta.sheets ?? []).map((s: any) => s.properties?.title);

  if (!titles.includes(INBOUND_TAB)) {
    await authedFetch(`${SHEETS_BASE}/${indexId}:batchUpdate`, {
      method: 'POST',
      body: JSON.stringify({
        requests: [{ addSheet: { properties: { title: INBOUND_TAB } } }],
      }),
    });
  }

  const data = await authedFetch(`${SHEETS_BASE}/${indexId}/values/${INBOUND_TAB}!A1:C1`).catch(
    () => null
  );
  if (data?.values?.length) return;

  await authedFetch(`${SHEETS_BASE}/${indexId}/values/${INBOUND_TAB}!A1:C1?valueInputOption=RAW`, {
    method: 'PUT',
    body: JSON.stringify({ values: [['phone_number', 'spreadsheet_id', 'updated_at']] }),
  });
}

// Process-lifetime cache -- a live call can hit getActiveSurveyForNumber
// once per turn (via resolveSpreadsheetId in every agent route); without
// this, that's a full Sheets read every single turn just to re-learn a
// mapping that essentially never changes mid-call. Same latency lesson as
// record-answer's earlier Dograh 5s-timeout incident. Invalidated
// explicitly on write (set/remove), not by TTL -- this data changes rarely
// and deliberately (an admin action), so staleness isn't a real risk.
const inboundMappingCache = new Map<string, string | null>();

/** Which spreadsheet is currently live for this phone number, or null if unmapped. */
export async function getActiveSurveyForNumber(phoneNumber: string): Promise<string | null> {
  if (inboundMappingCache.has(phoneNumber)) {
    return inboundMappingCache.get(phoneNumber)!;
  }

  const indexId = getIndexSheetId();
  const data = await authedFetch(`${SHEETS_BASE}/${indexId}/values/${INBOUND_TAB}!A2:C10000`).catch(
    () => null
  );
  const values: string[][] = data?.values ?? [];
  const row = values.find((r) => r[0] === phoneNumber);
  const resolved = row?.[1] ?? null;
  inboundMappingCache.set(phoneNumber, resolved);
  return resolved;
}

/** Point a phone number at a survey -- creates the mapping if new, updates it if it already exists. */
export async function setActiveSurveyForNumber(
  phoneNumber: string,
  spreadsheetId: string
): Promise<void> {
  await ensureInboundHeader();
  const indexId = getIndexSheetId();

  const data = await authedFetch(`${SHEETS_BASE}/${indexId}/values/${INBOUND_TAB}!A2:C10000`).catch(
    () => null
  );
  const values: string[][] = data?.values ?? [];
  const rowIndex = values.findIndex((r) => r[0] === phoneNumber);
  const updatedAt = new Date().toISOString();

  if (rowIndex === -1) {
    await authedFetch(
      `${SHEETS_BASE}/${indexId}/values/${INBOUND_TAB}!A:C:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        body: JSON.stringify({ values: [[phoneNumber, spreadsheetId, updatedAt]] }),
      }
    );
    inboundMappingCache.set(phoneNumber, spreadsheetId);
    return;
  }

  // +2: header row (1) plus values[] being 0-indexed from A2.
  const sheetRow = rowIndex + 2;
  await authedFetch(
    `${SHEETS_BASE}/${indexId}/values/${INBOUND_TAB}!A${sheetRow}:C${sheetRow}?valueInputOption=RAW`,
    {
      method: 'PUT',
      body: JSON.stringify({ values: [[phoneNumber, spreadsheetId, updatedAt]] }),
    }
  );
  inboundMappingCache.set(phoneNumber, spreadsheetId);
}

/** Unmap a phone number entirely. Idempotent -- a no-op if it wasn't mapped. */
export async function removeInboundMapping(phoneNumber: string): Promise<void> {
  const indexId = getIndexSheetId();

  const meta = await authedFetch(`${SHEETS_BASE}/${indexId}?fields=sheets.properties`);
  const sheetMeta = (meta.sheets ?? []).find((s: any) => s.properties?.title === INBOUND_TAB);
  if (!sheetMeta) {
    inboundMappingCache.delete(phoneNumber);
    return;
  }

  const data = await authedFetch(`${SHEETS_BASE}/${indexId}/values/${INBOUND_TAB}!A:A`).catch(
    () => null
  );
  const values: string[][] = data?.values ?? [];
  const rowIndex = values.findIndex((row, i) => i > 0 && row[0] === phoneNumber);
  if (rowIndex === -1) {
    inboundMappingCache.delete(phoneNumber);
    return;
  }

  await authedFetch(`${SHEETS_BASE}/${indexId}:batchUpdate`, {
    method: 'POST',
    body: JSON.stringify({
      requests: [
        {
          deleteDimension: {
            range: {
              sheetId: sheetMeta.properties.sheetId,
              dimension: 'ROWS',
              startIndex: rowIndex,
              endIndex: rowIndex + 1,
            },
          },
        },
      ],
    }),
  });
  inboundMappingCache.delete(phoneNumber);
}

export async function listInboundMappings(): Promise<InboundMapping[]> {
  const indexId = getIndexSheetId();
  const data = await authedFetch(`${SHEETS_BASE}/${indexId}/values/${INBOUND_TAB}!A2:C10000`).catch(
    () => null
  );
  const values: string[][] = data?.values ?? [];
  return values
    .filter((row) => row[0])
    .map((row) => ({
      phoneNumber: row[0],
      spreadsheetId: row[1] ?? '',
      updatedAt: row[2] ?? '',
    }));
}

/**
 * Resolve which spreadsheet an agent-facing route should act on. Accepts
 * either directly (the outbound calling convention -- spreadsheet_id passed
 * straight through from initial_context) or a phone_number to look up (the
 * inbound calling convention -- see getActiveSurveyForNumber above). Used
 * uniformly across next-question, submit-answer, record-answer, and
 * next-screener-question so all four support both conventions the same way.
 */
export async function resolveSpreadsheetId(input: {
  spreadsheetId?: string | null;
  phoneNumber?: string | null;
}): Promise<string> {
  if (input.spreadsheetId) {
    return normalizeSpreadsheetId(input.spreadsheetId);
  }
  if (input.phoneNumber) {
    const resolved = await getActiveSurveyForNumber(input.phoneNumber);
    if (!resolved) {
      throw new Error(
        `No survey is currently mapped to phone number "${input.phoneNumber}". Set one in survey-parser's Inbound Numbers section.`
      );
    }
    return normalizeSpreadsheetId(resolved);
  }
  throw new Error('Missing spreadsheet_id or phone_number.');
}

export { normalizeSpreadsheetId };
