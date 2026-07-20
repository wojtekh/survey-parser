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

  const questionList = remaining
    .map(
      (q) =>
        `${q.id}: "${q.text}"${q.skip_if ? ` | skip_if: ${q.skip_if}` : ''}`
    )
    .join('\n');

  const historyText = [...history, justAnswered]
    .map((h) => `${h.id}: "${h.text}" -> caller answered: "${h.answer}"`)
    .join('\n');

  const prompt = `Conversation so far (question -> caller's answer), in order:
${historyText}

The caller just answered ${justAnswered.id}.
${justAnsweredQ?.terminate_if ? `${justAnswered.id}'s terminate condition: ${justAnsweredQ.terminate_if}` : `${justAnswered.id} has no terminate condition.`}

Remaining questions, in order, each with its skip condition if any:
${questionList || '(none -- this was the last question)'}

Task:
1. Does ${justAnswered.id}'s terminate condition apply, given the caller's answer and the conversation so far? If ${justAnswered.id} has no terminate condition, this is false.
2. If not terminating: walking forward through the remaining questions in order, skip any whose skip condition is satisfied by the conversation so far, and stop at the first one that is NOT skipped -- that is the next question to ask. If every remaining question would be skipped, or there are no remaining questions, there is no next question.

Respond with ONLY this JSON, no commentary:
{"terminate": true or false, "next_question_id": "Q_ID or null"}`;

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

  return {
    terminate: Boolean(parsed.terminate),
    nextQuestionId: parsed.terminate ? null : (parsed.next_question_id ?? null),
  };
}
