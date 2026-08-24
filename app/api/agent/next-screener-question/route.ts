import { NextResponse } from 'next/server';
import { appendResponse, resolveSpreadsheetId } from '@/lib/googleSheets';
import { checkAgentSecret } from '@/lib/checkAgentSecret';
import {
  getCachedScreener,
  getHistory,
  recordHistory,
  decideNext,
  getCachedTurn,
  cacheTurn,
} from '@/lib/screenerRuntime';
import { encodeQuestionId, resolveSession } from '@/lib/callSession';

export const runtime = 'nodejs';

/**
 * Said to a caller who did not qualify, when the source document gave no
 * wording of its own. Plain and final: it states the outcome and closes,
 * rather than leaving the agent to improvise an explanation.
 */
const DEFAULT_TERMINATE_MESSAGE =
  "I'm sorry, it looks like you don't qualify for this particular study. Thank you very much for your time.";

// POST /api/agent/next-screener-question
// { conversation_id, spreadsheet_id, last_question_id?, answer? }  -- outbound
// { conversation_id, phone_number, last_question_id?, answer? }     -- inbound
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
//
// conversation_id is now OPTIONAL and no longer keys anything. Dograh has no
// working way to supply a unique per-call value, so this endpoint mints its
// own session on the first turn and carries it inside question_id, which the
// agent already echoes back reliably. See lib/callSession.ts for why. A
// conversation_id that is still configured gets used only as a fallback for
// a call already in flight from an older agent build.
/**
 * Turn a decision into the response body.
 *
 * Shared by the first run and by a retry replay, so the two can never drift
 * apart -- a retry that answered differently from the call it is replaying
 * would be worse than the duplicate it replaced.
 */
function buildTurnResponse(
  screener: Awaited<ReturnType<typeof getCachedScreener>>,
  sessionId: string,
  decision: { terminate: boolean; nextQuestionId: string | null }
) {
  if (decision.terminate) {
    return {
      done: true,
      terminated: true,
      question_id: null,
      question: null,
      closing_message: screener.closing.terminate_response || DEFAULT_TERMINATE_MESSAGE,
    };
  }

  if (!decision.nextQuestionId) {
    return {
      done: true,
      terminated: false,
      question_id: null,
      question: null,
      closing: {
        invitation_script: screener.closing.invitation_script,
        accept_response: screener.closing.accept_response,
        decline_response: screener.closing.decline_response,
      },
    };
  }

  const next = screener.questions.find((q) => q.id === decision.nextQuestionId);
  if (!next) return null;

  return {
    done: false,
    terminated: false,
    question_id: encodeQuestionId(sessionId, next.id),
    question: next.text,
  };
}

export async function POST(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await request.json();
  const conversationId: string | undefined = body.conversation_id;
  const rawSpreadsheetId: string | undefined = body.spreadsheet_id;
  const phoneNumber: string | undefined = body.phone_number;
  const lastQuestionId: string | undefined = body.last_question_id;
  const answer: string | undefined = body.answer;

  if (!rawSpreadsheetId && !phoneNumber) {
    return NextResponse.json({ error: 'Missing spreadsheet_id or phone_number.' }, { status: 400 });
  }

  try {
    const spreadsheetId = await resolveSpreadsheetId({
      spreadsheetId: rawSpreadsheetId,
      phoneNumber,
    });
    const screener = await getCachedScreener(spreadsheetId);

    // One session per call, minted on the first turn and echoed back inside
    // question_id from then on. This -- not conversation_id -- is what keeps
    // two simultaneous callers apart.
    const session = resolveSession({ lastQuestionId, conversationId });

    // First call: no prior question to record, just hand back Q1.
    if (!session.questionId) {
      const first = screener.questions[0];
      if (!first) {
        return NextResponse.json({ error: 'This screener has no questions.' }, { status: 500 });
      }
      return NextResponse.json({
        done: false,
        terminated: false,
        question_id: encodeQuestionId(session.sessionId, first.id),
        question: first.text,
      });
    }

    if (typeof answer !== 'string' || !answer.trim()) {
      return NextResponse.json(
        { error: 'Missing answer for last_question_id.' },
        { status: 400 }
      );
    }

    const answeredQuestion = screener.questions.find((q) => q.id === session.questionId);
    if (!answeredQuestion) {
      return NextResponse.json(
        { error: `Unknown last_question_id "${lastQuestionId}" for this screener.` },
        { status: 400 }
      );
    }

    const justAnswered = { id: session.questionId, text: answeredQuestion.text, answer };

    // Dograh's function-call timeout is a hard 5 seconds, and it retries a
    // timed-out call with identical arguments -- while the original request
    // usually finished on our side a moment later. Replaying the stored
    // decision keeps the retry fast AND stops the answer being appended to
    // the responses tab twice.
    const replay = getCachedTurn(session.sessionId, session.questionId);
    if (replay) {
      const body = buildTurnResponse(screener, session.sessionId, replay);
      // null only if the cached next question is no longer in the screener --
      // fall through and decide again rather than answer with nothing.
      if (body) return NextResponse.json(body);
    }

    const history = getHistory(session.sessionId);

    // Record durably (Sheets) and decide what's next (Haiku classification)
    // concurrently -- neither depends on the other's result, and doing them
    // in parallel keeps this endpoint's latency close to whichever one is
    // slower rather than their sum. Same lesson as record_answer's earlier
    // timeout: Dograh's function-call timeout is a hard 5s.
    const [, decision] = await Promise.all([
      appendResponse(spreadsheetId, {
        // The session, not the supplied conversation_id -- column A of the
        // responses tab is the only thing separating one caller from another.
        conversationId: session.sessionId,
        questionIndex: Date.now(),
        question: answeredQuestion.text,
        answer,
      }),
      decideNext(screener, history, justAnswered),
    ]);

    recordHistory(session.sessionId, justAnswered);
    cacheTurn(session.sessionId, session.questionId, decision);

    if (decision.terminate) {
      return NextResponse.json({
        done: true,
        terminated: true,
        question_id: null,
        question: null,
        // decline_response used to be returned here. That is the reply to a
        // caller who QUALIFIED and turned the invitation down -- reading it
        // to someone who was screened out thanks them for considering an
        // offer they were never made.
        closing_message: screener.closing.terminate_response || DEFAULT_TERMINATE_MESSAGE,
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
      question_id: encodeQuestionId(session.sessionId, next.id),
      question: next.text,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to process screener turn.' },
      { status: 502 }
    );
  }
}
