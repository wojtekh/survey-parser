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
//
// Also returns the NEXT question directly (done/question/index/total),
// computed from the same in-memory `questions` array and `answeredCount`
// this request already read -- not from a fresh read of the responses
// sheet after appending. That fresh-read approach is what next-question
// does, and it's fine for the very first question of a survey, but calling
// it again immediately after submit-answer hits a real Google Sheets
// read-after-write race: the append can return 200 before the row is
// visible to a `values.get` a few hundred ms later, so the agent gets told
// "still on question 0" right after it just answered question 0, and loops
// forever. Returning `next` here means the agent only needs to call
// next-question ONCE, for the very first question -- every question after
// that comes from submit-answer's own response, with no second read.
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

    const nextIndex = answeredCount + 1;
    const remaining = questions.length - nextIndex;
    const next =
      nextIndex >= questions.length
        ? { done: true, index: nextIndex, question: null }
        : { done: false, index: nextIndex, question: questions[nextIndex], total: questions.length };

    return NextResponse.json({ ok: true, recordedIndex: answeredCount, remaining, next });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to record answer.' },
      { status: 502 }
    );
  }
}
