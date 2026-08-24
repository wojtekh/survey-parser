import Anthropic from '@anthropic-ai/sdk';
import { getScreenerRaw } from './googleSheets';
import type { ParsedScreener } from './generateScreener';

// Server-side runtime for deterministic screener execution: given a
// structured screener (persisted via writeScreener) and the answer the
// caller just gave, decides what happens next -- terminate, or which
// question to ask -- instead of leaving that judgment to the voice agent's
// own in-context reasoning. See /api/agent/next-screener-question.
//
// Two in-memory caches, both process-lifetime only (not persisted -- Sheets
// remains the durable source of truth via appendResponse in the route
// itself):
// - screener structure per spreadsheetId: read once, reused for every turn
//   of every call using that survey, since the structure never changes
//   mid-call.
// - answer history per conversation_id: avoids re-reading the responses
//   tab from Sheets on every turn just to reconstruct context for the
//   classification call below.
const screenerCache = new Map<string, ParsedScreener>();
const historyCache = new Map<string, { id: string; text: string; answer: string }[]>();

export async function getCachedScreener(spreadsheetId: string): Promise<ParsedScreener> {
  const cached = screenerCache.get(spreadsheetId);
  if (cached) return cached;

  const raw = await getScreenerRaw(spreadsheetId);
  const parsed: ParsedScreener = JSON.parse(raw);
  screenerCache.set(spreadsheetId, parsed);
  return parsed;
}

export function getHistory(conversationId: string) {
  return historyCache.get(conversationId) ?? [];
}

export function recordHistory(conversationId: string, entry: { id: string; text: string; answer: string }) {
  const existing = historyCache.get(conversationId) ?? [];
  existing.push(entry);
  historyCache.set(conversationId, existing);
}

export function clearHistory(conversationId: string) {
  historyCache.delete(conversationId);
}

export interface NextDecision {
  terminate: boolean;
  nextQuestionId: string | null;
}

/**
 * How long the classification call gets before we stop waiting.
 *
 * Dograh's function-call timeout is a hard 5 seconds. When it fires, the
 * caller hears dead air and the agent improvises -- and the request usually
 * COMPLETED on our side a moment later, so the retry writes the answer a
 * second time. Missing the deadline is worse than a slightly worse decision.
 *
 * 3.2s leaves room for the Sheets append running alongside, plus network.
 */
const CLASSIFY_DEADLINE_MS = 3200;

/**
 * Replay cache for one turn, keyed by session + the question being answered.
 *
 * Dograh retries a timed-out tool call with identical arguments. Without
 * this, the retry re-runs the classification AND appends the answer to the
 * responses tab again -- a duplicate row, and a duplicated entry in the
 * history that feeds later skip/terminate decisions.
 *
 * Keyed on the turn rather than the session so a genuine re-answer of a
 * DIFFERENT question is never suppressed.
 */
const turnCache = new Map<string, NextDecision>();

function turnKey(sessionId: string, questionId: string): string {
  return `${sessionId}::${questionId}`;
}

export function getCachedTurn(sessionId: string, questionId: string): NextDecision | null {
  return turnCache.get(turnKey(sessionId, questionId)) ?? null;
}

export function cacheTurn(sessionId: string, questionId: string, decision: NextDecision): void {
  turnCache.set(turnKey(sessionId, questionId), decision);
}

/**
 * Single fast classification call (Haiku -- this is a narrow, well-scoped
 * judgment call, not open-ended generation) that resolves the just-answered
 * question's terminate_if condition AND walks forward through any
 * subsequent skip_if conditions in one shot, rather than one model call per
 * condition. Keeps this endpoint's added latency to roughly one Haiku
 * round-trip regardless of how many questions get skipped in a chain.
 */
export async function decideNext(
  screener: ParsedScreener,
  history: { id: string; text: string; answer: string }[],
  justAnswered: { id: string; text: string; answer: string }
): Promise<NextDecision> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set.');
  }

  const currentIndex = screener.questions.findIndex((q) => q.id === justAnswered.id);
  const remaining = currentIndex >= 0 ? screener.questions.slice(currentIndex + 1) : screener.questions;
  const justAnsweredQ = screener.questions.find((q) => q.id === justAnswered.id);

  // No terminate/skip logic at all downstream and on this question -- skip
  // the model call entirely, just return the very next question in order.
  if (!justAnsweredQ?.terminate_if && remaining.every((q) => !q.skip_if)) {
    return { terminate: false, nextQuestionId: remaining[0]?.id ?? null };
  }

  const client = new Anthropic({ apiKey });

  // Only questions that CAN be skipped need the model's judgment. When none
  // of the remaining ones carry a skip condition, the next question is
  // simply the next in order -- so the prompt drops the whole question list
  // and asks one thing. That is the common case, and the list is the largest
  // part of the prompt, so this is most of the latency saving.
  const anyRemainingSkips = remaining.some((q) => q.skip_if);

  const questionList = remaining
    .map(
      (q) =>
        `${q.id}: "${q.text}"${q.skip_if ? ` | skip_if: ${q.skip_if}` : ''}`
    )
    .join('\n');

  const historyText = [...history, justAnswered]
    .map((h) => `${h.id}: "${h.text}" -> caller answered: "${h.answer}"`)
    .join('\n');

  const prompt = anyRemainingSkips
    ? fullPrompt()
    : terminateOnlyPrompt();

  function terminateOnlyPrompt() {
    return `Conversation so far (question -> caller's answer), in order:
${historyText}

The caller just answered ${justAnswered.id}.
${justAnswered.id}'s terminate condition: ${justAnsweredQ?.terminate_if}

Task: does that terminate condition apply, given the caller's answer?

Rules:
- Numeric ranges are INCLUSIVE of both endpoints unless the text says
  otherwise. "35-45" includes someone who is 35 and someone who is 45.
- Terminate only when the condition is CLEARLY met. If the answer is
  ambiguous, partial, or you are unsure, do NOT terminate.

Respond with ONLY this JSON, no commentary:
{"terminate": true or false}`;
  }

  function fullPrompt() {
    return `Conversation so far (question -> caller's answer), in order:
${historyText}

The caller just answered ${justAnswered.id}.
${justAnsweredQ?.terminate_if ? `${justAnswered.id}'s terminate condition: ${justAnsweredQ.terminate_if}` : `${justAnswered.id} has no terminate condition.`}

Remaining questions, in order, each with its skip condition if any:
${questionList || '(none -- this was the last question)'}

Task:
1. Does ${justAnswered.id}'s terminate condition apply, given the caller's answer and the conversation so far? If ${justAnswered.id} has no terminate condition, this is false.

   Rules for this judgment:
   - Numeric ranges are INCLUSIVE of both endpoints unless the text says
     otherwise. "35-45" includes someone who is 35 and someone who is 45.
   - Terminate only when the condition is CLEARLY met. If the answer is
     ambiguous, partial, or you are unsure, do NOT terminate.
     Ending a qualified caller's screener is unrecoverable -- they are gone.
     Asking one more question of someone who should have been screened out
     costs nothing and is caught later.
2. If not terminating: walking forward through the remaining questions in order, skip any whose skip condition is satisfied by the conversation so far, and stop at the first one that is NOT skipped -- that is the next question to ask. If every remaining question would be skipped, or there are no remaining questions, there is no next question.

Respond with ONLY this JSON, no commentary:
{"terminate": true or false, "next_question_id": "Q_ID or null"}`;
  }

  // Fail open on the deadline: keep the call alive and move to the next
  // question in order. A caller who should have been screened out answering
  // one more question is recoverable from the responses tab afterwards. Dead
  // air on a real phone call is not.
  const fallback: NextDecision = { terminate: false, nextQuestionId: remaining[0]?.id ?? null };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), CLASSIFY_DEADLINE_MS);
  });

  const classify = (async (): Promise<NextDecision> => {
    const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [
      { role: 'user', content: prompt },
      { role: 'assistant', content: '{' },
    ],
  });

  const textBlock = message.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Classification call returned no text content.');
  }

  const rawText = '{' + textBlock.text;
  let parsed: { terminate: boolean; next_question_id: string | null };
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Classification response was not valid JSON: ${rawText.slice(0, 200)}`);
    parsed = JSON.parse(match[0]);
  }

    if (parsed.terminate) return { terminate: true, nextQuestionId: null };
    // The terminate-only prompt returns no next_question_id -- there is
    // nothing to skip, so the next question is the next one in order.
    return {
      terminate: false,
      nextQuestionId: anyRemainingSkips
        ? (parsed.next_question_id ?? null)
        : (remaining[0]?.id ?? null),
    };
  })();

  try {
    const result = await Promise.race([classify, deadline]);
    if (result === null) {
      console.error(
        '[screenerRuntime] classification exceeded',
        CLASSIFY_DEADLINE_MS,
        'ms for',
        justAnswered.id,
        '-- continuing without terminating'
      );
      return fallback;
    }
    return result;
  } catch (err) {
    // A failed classification must not end someone's screener either.
    console.error('[screenerRuntime] classification failed for', justAnswered.id, err);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
