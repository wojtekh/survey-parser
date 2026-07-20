import { NextResponse } from 'next/server';
import { appendResponse, getAnsweredCount, normalizeSpreadsheetId } from '@/lib/googleSheets';
import { checkAgentSecret } from '@/lib/checkAgentSecret';

export const runtime = 'nodejs';

// POST /api/agent/record-answer  { conversation_id, spreadsheet_id, question, answer }
//
// For surveys with real branching/skip/termination logic, driven by a
// Dograh Knowledge Base document rather than our own flat "questions" tab
// (see submit-answer route, which assumes a fixed known question list --
// that doesn't hold here since the agent decides the order and can skip
// questions per the source document's own logic).
//
// Unlike submit-answer, the question text is NOT derived server-side --
// it's whatever the LLM says it just asked, trusted as-is. There's no
// canonical list to check it against here. questionIndex is just a
// running "how many answers so far for this conversation" counter (reuses
// getAnsweredCount), not a position in a known sequence -- kept only so
// the responses tab's existing 4-column shape (conversation_id,
// question_index, question, user_response) still works unchanged, and so
// rows stay in the order they were recorded.
export async function POST(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await request.json();
  const conversationId: string | undefined = body.conversation_id;
  const rawSpreadsheetId: string | undefined = body.spreadsheet_id;
  const question: string | undefined = body.question;
  const answer: string | undefined = body.answer;

  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'Missing conversation_id.' }, { status: 400 });
  }
  if (!rawSpreadsheetId || typeof rawSpreadsheetId !== 'string') {
    return NextResponse.json({ error: 'Missing spreadsheet_id.' }, { status: 400 });
  }
  if (!question || typeof question !== 'string') {
    return NextResponse.json({ error: 'Missing question.' }, { status: 400 });
  }
  if (!answer || typeof answer !== 'string') {
    return NextResponse.json({ error: 'Missing answer.' }, { status: 400 });
  }
  const spreadsheetId = normalizeSpreadsheetId(rawSpreadsheetId);

  try {
    const answeredCount = await getAnsweredCount(spreadsheetId, conversationId);

    await appendResponse(spreadsheetId, {
      conversationId,
      questionIndex: answeredCount,
      question,
      answer,
    });

    return NextResponse.json({ ok: true, recordedIndex: answeredCount });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to record answer.' },
      { status: 502 }
    );
  }
}
