import { NextResponse } from 'next/server';
import { getAllQuestions, getAnsweredCount, normalizeSpreadsheetId } from '@/lib/googleSheets';
import { checkAgentSecret } from '@/lib/checkAgentSecret';

export const runtime = 'nodejs';

// GET /api/agent/next-question?conversation_id=xxx&spreadsheet_id=xxx
//
// spreadsheet_id IS the survey identifier -- multi-survey support just
// means the agent passes a different one per call (set via Dograh's
// initial_context when the call is triggered/routed). Everything else
// about this endpoint is unchanged: stateless, "next question" is just
// "however many rows this conversation_id already has in responses".
export async function GET(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get('conversation_id');
  const rawSpreadsheetId = searchParams.get('spreadsheet_id');

  if (!conversationId) {
    return NextResponse.json({ error: 'Missing conversation_id.' }, { status: 400 });
  }
  if (!rawSpreadsheetId) {
    return NextResponse.json({ error: 'Missing spreadsheet_id.' }, { status: 400 });
  }
  const spreadsheetId = normalizeSpreadsheetId(rawSpreadsheetId);

  try {
    const [questions, answeredCount] = await Promise.all([
      getAllQuestions(spreadsheetId),
      getAnsweredCount(spreadsheetId, conversationId),
    ]);

    if (answeredCount >= questions.length) {
      return NextResponse.json({ done: true, index: answeredCount, question: null });
    }

    return NextResponse.json({
      done: false,
      index: answeredCount,
      question: questions[answeredCount],
      total: questions.length,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to fetch next question.' },
      { status: 502 }
    );
  }
}
