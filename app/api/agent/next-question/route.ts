import { NextResponse } from 'next/server';
import { getAllQuestions, getAnsweredCount, resolveSpreadsheetId } from '@/lib/googleSheets';
import { checkAgentSecret } from '@/lib/checkAgentSecret';

export const runtime = 'nodejs';

// GET /api/agent/next-question?conversation_id=xxx&spreadsheet_id=xxx
//                          or  ?conversation_id=xxx&phone_number=xxx
//
// spreadsheet_id IS the survey identifier -- multi-survey support just
// means the agent passes a different one per call. Two ways that happens:
// outbound calls pass spreadsheet_id directly (set via Dograh's
// initial_context when the call is triggered), inbound calls pass
// phone_number instead (the number that was dialed, populated by Dograh
// from real telephony data) and resolveSpreadsheetId looks up which survey
// that number is currently mapped to. Everything else about this endpoint
// is unchanged: stateless, "next question" is just "however many rows this
// conversation_id already has in responses".
export async function GET(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get('conversation_id');
  const rawSpreadsheetId = searchParams.get('spreadsheet_id');
  const phoneNumber = searchParams.get('phone_number');

  if (!conversationId) {
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
