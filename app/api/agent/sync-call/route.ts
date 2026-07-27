import { NextResponse } from 'next/server';
import {
  appendResponsesBatch,
  clearConfirmedAnswers,
  getConfirmedAnswers,
  getFields,
  resolveSpreadsheetId,
} from '@/lib/googleSheets';
import { checkAgentSecret } from '@/lib/checkAgentSecret';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/agent/sync-call
// { conversation_id, spreadsheet_id, answers: { field_key: value, ... } }  -- outbound
// { conversation_id, phone_number, answers: { field_key: value, ... } }    -- inbound
//
// The end-of-call step of the hybrid gathered_context survey flow. Fired
// once per call, from a Webhook Node placed right before End Call (not a
// custom HTTP API tool the agent decides to call -- Dograh's own Webhook
// Node feature, configured at agent-build time with a body_template like
// { "answers": { "first_name": "{{gathered_context.first_name}}", ... } }).
//
// Writes every answer for the call in ONE Sheets API call (appendResponsesBatch)
// instead of one write per question -- this is what actually delivers the
// reliability win over the old per-question tool-loop design: a single
// write per call means there's no read-after-write race to hit at all,
// regardless of how the agent behaves.
//
// For fields flagged "validated" in the survey's field list, prefers the
// confirmed value recorded by validate-field mid-call (normalized, and
// actually re-askable if it was wrong) over the raw value in `answers`
// (passively extracted, never checked) -- see getConfirmedAnswers.
export async function POST(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await request.json();
  const conversationId: string | undefined = body.conversation_id;
  const rawSpreadsheetId: string | undefined = body.spreadsheet_id;
  const phoneNumber: string | undefined = body.phone_number;
  const answers: Record<string, string> =
    body.answers && typeof body.answers === 'object' ? body.answers : {};

  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'Missing conversation_id.' }, { status: 400 });
  }
  if (!rawSpreadsheetId && !phoneNumber) {
    return NextResponse.json({ error: 'Missing spreadsheet_id or phone_number.' }, { status: 400 });
  }

  try {
    const spreadsheetId = await resolveSpreadsheetId({
      spreadsheetId: rawSpreadsheetId,
      phoneNumber,
    });

    const fields = await getFields(spreadsheetId);
    const confirmed = getConfirmedAnswers(spreadsheetId, conversationId);

    const rows = fields
      .map((field, index) => {
        const value = confirmed.get(field.key) ?? answers[field.key];
        if (value === undefined || value === null || value === '') return null;
        return { conversationId, questionIndex: index, question: field.question, answer: String(value) };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    await appendResponsesBatch(spreadsheetId, rows);
    clearConfirmedAnswers(spreadsheetId, conversationId);

    return NextResponse.json({ ok: true, recorded: rows.length, total: fields.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to sync call results.' },
      { status: 502 }
    );
  }
}
