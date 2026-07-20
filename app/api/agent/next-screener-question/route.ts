import { NextResponse } from 'next/server';
import { appendResponse, normalizeSpreadsheetId } from '@/lib/googleSheets';
import { checkAgentSecret } from '@/lib/checkAgentSecret';
import { getCachedScreener, getHistory, recordHistory, decideNext } from '@/lib/screenerRuntime';

export const runtime = 'nodejs';

// POST /api/agent/next-screener-question
// { conversation_id, spreadsheet_id, last_question_id?, answer? }
//
// Deterministic counterpart to record_answer for screeners parsed and
// pushed through the app's "Recruitment / qualifier screener" flow (which
// persists the structured question list -- see lib/googleSheets.ts
// writeScreener). Unlike record_answer, this endpoint both logs the answer
// AND decides what happens next in one round-trip, so the agent never has
// to judge skip/terminate logic itself -- it just asks whatever this
// returns.
//
// First call in a conversation: omit last_question_id/answer, get back Q1.
// Every call after that: pass the id of the question you just asked (as
// returned by the previous call) plus the caller's answer to it. The
// question TEXT itself is looked up server-side from the stored screener,
// not trusted from the LLM -- closes the same drift risk record_answer has
// (where the LLM reports whatever it thinks it asked).
export async function POST(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await request.json();
  const conversationId: string | undefined = body.conversation_id;
  const rawSpreadsheetId: string | undefined = body.spreadsheet_id;
  const lastQuestionId: string | undefined = body.last_question_id;
  const answer: string | undefined = body.answer;

  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'Missing conversation_id.' }, { status: 400 });
  }
  if (!rawSpreadsheetId || typeof rawSpreadsheetId !== 'string') {
    return NextResponse.json({ error: 'Missing spreadsheet_id.' }, { status: 400 });
  }
  const spreadsheetId = normalizeSpreadsheetId(rawSpreadsheetId);

  try {
    const screener = await getCachedScreener(spreadsheetId);

    // First call: no prior question to record, just hand back Q1.
    if (!lastQuestionId) {
      const first = screener.questions[0];
      if (!first) {
        return NextResponse.json({ error: 'This screener has no questions.' }, { status: 500 });
      }
      return NextResponse.json({
        done: false,
        terminated: false,
        question_id: first.id,
        question: first.text,
      });
    }

    if (typeof answer !== 'string' || !answer.trim()) {
      return NextResponse.json(
        { error: 'Missing answer for last_question_id.' },
        { status: 400 }
      );
    }

    const answeredQuestion = screener.questions.find((q) => q.id === lastQuestionId);
    if (!answeredQuestion) {
      return NextResponse.json(
        { error: `Unknown last_question_id "${lastQuestionId}" for this screener.` },
        { status: 400 }
      );
    }

    const justAnswered = { id: lastQuestionId, text: answeredQuestion.text, answer };
    const history = getHistory(conversationId);

    // Record durably (Sheets) and decide what's next (Haiku classification)
    // concurrently -- neither depends on the other's result, and doing them
    // in parallel keeps this endpoint's latency close to whichever one is
    // slower rather than their sum. Same lesson as record_answer's earlier
    // timeout: Dograh's function-call timeout is a hard 5s.
    const [, decision] = await Promise.all([
      appendResponse(spreadsheetId, {
        conversationId,
        questionIndex: Date.now(),
        question: answeredQuestion.text,
        answer,
      }),
      decideNext(screener, history, justAnswered),
    ]);

    recordHistory(conversationId, justAnswered);

    if (decision.terminate) {
      return NextResponse.json({
        done: true,
        terminated: true,
        question_id: null,
        question: null,
        closing_message: screener.closing.decline_response,
      });
    }

    if (!decision.nextQuestionId) {
      return NextResponse.json({
        done: true,
        terminated: false,
        question_id: null,
        question: null,
        closing: {
          invitation_script: screener.closing.invitation_script,
          accept_response: screener.closing.accept_response,
          decline_response: screener.closing.decline_response,
        },
      });
    }

    const next = screener.questions.find((q) => q.id === decision.nextQuestionId);
    if (!next) {
      return NextResponse.json(
        { error: `Classification returned unknown question id "${decision.nextQuestionId}".` },
        { status: 502 }
      );
    }

    return NextResponse.json({
      done: false,
      terminated: false,
      question_id: next.id,
      question: next.text,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to process screener turn.' },
      { status: 502 }
    );
  }
}
