import { NextResponse } from 'next/server';
import {
  appendResponse,
  getAllQuestions,
  getAnsweredCount,
  resolveSpreadsheetId,
} from '@/lib/googleSheets';
import { checkAgentSecret } from '@/lib/checkAgentSecret';

export const runtime = 'nodejs';

// POST /api/agent/submit-answer
// { conversation_id, spreadsheet_id, answer }  -- outbound
// { conversation_id, phone_number, answer }     -- inbound
//
// spreadsheet_id IS the survey identifier (see next-question route). The
// index/canonical question text are still derived server-side rather than
// trusted from the LLM, same as before.
export async function POST(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await request.json();
  const conversationId: string | undefined = body.conversation_id;
  const rawSpreadsheetId: string | undefined = body.spreadsheet_id;
  const phoneNumber: string | undefined = body.phone_number;
  const answer: string | undefined = body.answer;

  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'Missing conversation_id.' }, { status: 400 });
  }
  if (!rawSpreadsheetId && !phoneNumber) {
    return NextResponse.json({ error: 'Missing spreadsheet_id or phone_number.' }, { status: 400 });
  }
  if (!answer || typeof answer !== 'string') {
    return NextResponse.json({ error: 'Missing answer.' }, { status: 400 });
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
      return NextResponse.json(
        { error: 'All questions for this conversation are already answered.' },
        { status: 409 }
      );
    }

    const question = questions[answeredCount];
    await appendResponse(spreadsheetId, {
      conversationId,
      questionIndex: answeredCount,
      question,
      answer,
    });

    const remaining = questions.length - (answeredCount + 1);
    return NextResponse.json({ ok: true, recordedIndex: answeredCount, remaining });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to record answer.' },
      { status: 502 }
    );
  }
}
