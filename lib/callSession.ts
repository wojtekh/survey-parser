import { randomBytes } from 'crypto';

// Per-call identity for screener runs, carried inside `question_id`.
//
// THE PROBLEM
// Dograh has no working way to hand a tool a unique per-call value.
// `{{workflow_run_id}}` resolves to an empty string both as an LLM Parameter
// (the model transcribes nothing) and as a Preset Parameter (Dograh's own
// template engine errors out, "resolved to an empty value", before the call
// ever reaches this app). The only configuration confirmed working end to
// end was a Preset Parameter holding a fixed literal string -- which every
// concurrent call then shares.
//
// That matters more than it sounds. conversation_id keys BOTH the
// responses-tab rows and the in-memory answer history that feeds
// skip/terminate decisions. Two callers sharing one id means their answers
// interleave in the sheet with no way to separate them afterwards, and one
// caller's answers can drive the other caller's disqualification.
//
// THE FIX
// Use a channel that already works. get_next_screener_question already
// requires the agent to echo back the exact question_id it was handed last
// turn -- that is core to the tool functioning at all, and it is confirmed
// working on real calls. So the session id travels inside that token: the
// tool returns "a1b2c3d4.Q1", and whatever the agent echoes back carries the
// session with it.
//
// No Dograh configuration. No new obligation on the agent. Concurrent calls
// stay separate because each one is seeded independently on its first turn,
// where there is no last_question_id to decode and a fresh id is minted.

/** Separator between the session id and the real question id. */
const SEP = '.';

/**
 * 8 lowercase hex characters. Hex on purpose: no case distinction and no
 * `-`/`_`/`.` to be garbled or confused with the separator if the value ever
 * passes through a transcription path. 4 billion values is far more than
 * enough to keep concurrent calls apart.
 */
const SESSION_RE = /^[0-9a-f]{8}$/;

export function newSessionId(): string {
  return randomBytes(4).toString('hex');
}

/** Build the token handed to the agent, e.g. ("a1b2c3d4", "Q1") -> "a1b2c3d4.Q1". */
export function encodeQuestionId(sessionId: string, questionId: string): string {
  return `${sessionId}${SEP}${questionId}`;
}

/**
 * Split a token the agent echoed back.
 *
 * Splits at the FIRST separator: the session id never contains one, and a
 * question id theoretically could.
 *
 * A token with no valid session prefix is treated as a bare question id with
 * no session -- that is an agent configured before this change, mid-call.
 * Those keep working via the conversation_id fallback in resolveSession.
 */
export function decodeQuestionId(token: string): {
  sessionId: string | null;
  questionId: string;
} {
  const i = token.indexOf(SEP);
  if (i > 0) {
    const maybeSession = token.slice(0, i);
    if (SESSION_RE.test(maybeSession)) {
      return { sessionId: maybeSession, questionId: token.slice(i + 1) };
    }
  }
  return { sessionId: null, questionId: token };
}

export interface ResolvedSession {
  /** The key to use for answer history and for the responses tab's column A. */
  sessionId: string;
  /** The real question id, with any session prefix stripped. Null on the first turn. */
  questionId: string | null;
  /** Where sessionId came from -- surfaced in the response purely for debugging a live call. */
  source: 'minted' | 'question_id' | 'conversation_id';
}

/**
 * Work out which session this turn belongs to.
 *
 * Order matters:
 * 1. No last_question_id at all -- this is the first turn. Always mint.
 *    Minting here rather than trusting conversation_id is the whole point:
 *    it is what makes two simultaneous callers distinct even when Dograh
 *    hands both of them the same literal.
 * 2. A token carrying a session prefix -- use it.
 * 3. A bare token -- an agent that predates this change. Fall back to
 *    whatever conversation_id it sent so a call in flight during a deploy
 *    still finishes. Mint only if there is nothing at all.
 */
export function resolveSession(input: {
  lastQuestionId?: string;
  conversationId?: string;
}): ResolvedSession {
  const last = input.lastQuestionId?.trim();
  const supplied = input.conversationId?.trim();

  if (!last) {
    return { sessionId: newSessionId(), questionId: null, source: 'minted' };
  }

  const { sessionId, questionId } = decodeQuestionId(last);
  if (sessionId) {
    return { sessionId, questionId, source: 'question_id' };
  }
  if (supplied) {
    return { sessionId: supplied, questionId, source: 'conversation_id' };
  }
  return { sessionId: newSessionId(), questionId, source: 'minted' };
}
