import Anthropic from '@anthropic-ai/sdk';
import { searchKnowledgeBase } from '@/lib/cognee';

// Post-call self-improvement loop for a client's Cognee knowledge base.
//
// Two different failures look the same in a transcript (the agent didn't
// answer the caller) but need opposite fixes:
//   - retrieval_failure: the answer WAS in the knowledge base, the agent
//     just didn't surface it well. This is Cognee's own job to get better
//     at over time (feedback_weight / memify) -- see the REST-API caveat
//     below.
//   - knowledge_gap: the answer was never ingested. No amount of retrieval
//     tuning fixes this. Only a human adding a document does.
//
// evaluateTranscript() tells them apart by actually querying the client's
// KB for each candidate gap the transcript evaluator flags, rather than
// guessing from the transcript alone.

const EVAL_MAX_OUTPUT_TOKENS = 2000;

const SYSTEM_PROMPT = `You review a voice call transcript between an AI phone agent and a caller.

Decide two things:
1. "satisfied": did the caller's request get resolved? False if the caller
   ended confused, frustrated, was given wrong/incomplete information, or
   the agent admitted it didn't know something the caller needed.
2. "candidate_gaps": every distinct moment where the agent needed
   information it didn't have or got wrong -- one entry per distinct
   question, not per turn. Skip anything unrelated to a knowledge lookup
   (e.g. a scheduling failure, a bad phone line). Only flag real gaps --
   an agent correctly saying "let me transfer you" is not a gap.

Respond with ONLY a single JSON object, no markdown fences, no commentary:
{
  "satisfied": boolean,
  "candidate_gaps": [
    { "caller_question": "the caller's question, in their own words", "note": "what went wrong, one sentence" }
  ]
}`;

export interface CandidateGap {
  callerQuestion: string;
  note: string;
}

export interface TranscriptEvaluation {
  satisfied: boolean;
  candidateGaps: CandidateGap[];
}

/** Accepts either a flat string transcript or an array of {role, text} turns -- see the call-review route's header comment for why the shape isn't nailed down yet. */
export type TranscriptInput = string | { role: string; text: string }[];

function flattenTranscript(transcript: TranscriptInput): string {
  if (typeof transcript === 'string') return transcript;
  return transcript.map((turn) => `${turn.role}: ${turn.text}`).join('\n');
}

async function evaluateWithModel(transcriptText: string): Promise<TranscriptEvaluation> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env before running call review.');
  }
  const client = new Anthropic({ apiKey });

  const message = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: EVAL_MAX_OUTPUT_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: `Transcript:\n\n${transcriptText}` },
      { role: 'assistant', content: '{' },
    ],
  });

  if (message.stop_reason === 'max_tokens') {
    throw new Error(`Transcript evaluation exceeded the ${EVAL_MAX_OUTPUT_TOKENS}-token output budget.`);
  }

  const textBlock = message.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Model returned no text content while evaluating the transcript.');
  }

  const rawText = '{' + textBlock.text;
  let parsed: { satisfied: boolean; candidate_gaps: { caller_question: string; note: string }[] };
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw new Error(`Transcript evaluation returned invalid JSON. First 300 chars: ${rawText.slice(0, 300)}`);
  }

  return {
    satisfied: parsed.satisfied,
    candidateGaps: (parsed.candidate_gaps ?? []).map((g) => ({
      callerQuestion: g.caller_question,
      note: g.note,
    })),
  };
}

export interface ClassifiedGap extends CandidateGap {
  type: 'knowledge_gap' | 'retrieval_failure';
}

export interface CallReviewResult {
  satisfied: boolean;
  gaps: ClassifiedGap[];
}

/**
 * For each candidate gap the model flagged, re-query the client's own KB
 * (CHUNKS -- raw retrieval, no synthesis) to check whether the information
 * was actually there. Non-empty chunks back means the agent had access to
 * the answer and didn't use it well (retrieval_failure); nothing back means
 * it was never ingested (knowledge_gap). A heuristic, not a certainty --
 * good enough to route the alert correctly, not a substitute for a human
 * reading the transcript on a borderline case.
 */
async function classifyGap(agentApiKey: string, gap: CandidateGap): Promise<ClassifiedGap> {
  const results = await searchKnowledgeBase(agentApiKey, gap.callerQuestion, 'CHUNKS');
  const hasContent = results.some((r) => {
    const text = typeof r.searchResult === 'string' ? r.searchResult : JSON.stringify(r.searchResult ?? '');
    return text.trim().length > 0;
  });
  return { ...gap, type: hasContent ? 'retrieval_failure' : 'knowledge_gap' };
}

export async function evaluateTranscript(
  transcript: TranscriptInput,
  agentApiKey: string
): Promise<CallReviewResult> {
  const transcriptText = flattenTranscript(transcript);
  const evaluation = await evaluateWithModel(transcriptText);

  const gaps = await Promise.all(evaluation.candidateGaps.map((gap) => classifyGap(agentApiKey, gap)));

  return { satisfied: evaluation.satisfied, gaps };
}

/** Best effort -- a broken/unset webhook must never fail the call-review request itself. */
export async function sendSlackAlert(webhookUrl: string, text: string): Promise<void> {
  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error('[callReview] Slack alert failed to send:', err instanceof Error ? err.message : err);
  }
}
