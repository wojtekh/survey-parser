import Anthropic from '@anthropic-ai/sdk';

// Structured extraction for recruitment/qualifier screeners -- documents with
// real skip/termination logic (moderator's guides, recruiting scripts),
// unlike the flat linear surveys generateQuestions.ts handles. This format
// mirrors the hand-written restructuring done for the AGO Focus Groups
// Screener: an explicit, numbered, sequential checklist with skip/terminate
// conditions attached to each question, moderator-only notes kept separate
// from what's actually spoken, and everything uncertain flagged rather than
// guessed at silently.
//
// Consumed two ways downstream: rendered to a plain-text script (see
// lib/renderScreenerScript.ts) for Dograh's Knowledge Base, and/or edited
// directly in the review UI before export.

export interface ScreenerOpening {
  /** e.g. "Default" if there's only one, or a short description of when this
   * variant applies (e.g. "If calling an AGO donor/member"). */
  condition: string;
  /** The caller-facing opening script for this variant. */
  script: string;
  /** What to say if the caller declines right here, before qualifying
   * questions begin (often warmer/different wording than a mid-screener
   * termination). */
  decline_response: string;
}

export interface ScreenerQuestion {
  /** Sequential, stable identifier in source-document order: "Q1", "Q2", ... */
  id: string;
  /** Natural, speakable phrasing of the question. */
  text: string;
  /** Natural-language condition for skipping this question based on a prior
   * answer (e.g. "Q4 answer is No"), or null if it's always asked. */
  skip_if: string | null;
  /** Natural-language condition for ending the call after this question is
   * answered (e.g. "answer indicates the household has a conflict of
   * interest"), or null if this question never terminates the call. */
  terminate_if: string | null;
  /** Silent eligibility/quota logic tied to this question that must never be
   * spoken aloud (e.g. how the answer feeds a demographic quota), or null. */
  internal_note: string | null;
  /** True if extraction was uncertain about this question's boundaries,
   * wording, or logic. */
  needs_review: boolean;
  /** Required if needs_review is true: what's uncertain and why. */
  review_note: string | null;
}

export interface ScreenerClosing {
  /** The final invitation/incentive script, read once the caller has
   * qualified and reached the end of the questions without terminating. */
  invitation_script: string;
  /** What to say if the caller accepts the invitation. */
  accept_response: string;
  /** What to say if the caller declines the invitation. */
  decline_response: string;
}

export interface ParsedScreener {
  title: string;
  openings: ScreenerOpening[];
  questions: ScreenerQuestion[];
  closing: ScreenerClosing;
  /** Document-level ambiguities not tied to one specific question (e.g.
   * unclear which opening variant is the default, missing incentive amount
   * for one respondent group). */
  flags: string[];
}

const SYSTEM_PROMPT = `You convert a messy source document (a recruiting/qualifier screener or
moderator's guide, often written in prose with quota tables and inconsistent
numbering) into an explicit, sequential, numbered checklist a voice agent can
execute exactly -- one caller-facing question at a time, with skip and
termination logic attached to each question as plain conditions.

These documents mix real questions to ask the caller with instructions meant
only for the interviewer/moderator (things like "RECORD", "Watch soft
quotas", "Best effort to mix", demographic breakdown tables, quota
percentages). You must tell these apart: only extract things actually meant
to be spoken to the caller as "questions" -- moderator-only logic becomes
"internal_note" on the relevant question instead, never a spoken question of
its own.

Rules:
1. Extract EVERY actual caller-facing question from the source document, in
   the same order they appear, as a numbered sequence "Q1", "Q2", .... Do not
   drop a question just because it has no termination logic attached --
   plain demographic questions (age of children, occupation, birthplace,
   etc.) must still be extracted even though nothing about them ends the
   call. Never invent a question that isn't in the source document.
2. For each question, work out from the surrounding text:
   - skip_if: a plain-language condition describing when to skip this
     question based on a specific prior answer (reference the prior
     question's content directly, e.g. "the caller said No to whether they've
     participated in a focus group before"). null if always asked.
   - terminate_if: a plain-language condition describing when answering this
     question should end the call (e.g. "IF NO: THANK AND TERMINATE", quota
     combinations that disqualify, "must have visited at least one of these
     in the past 12 months or terminate"). null if this question never ends
     the call on its own.
   - internal_note: any silent eligibility/quota/tracking logic tied to this
     question that must never be spoken aloud to the caller (e.g. how an
     answer feeds a demographic quota bucket). null if there's nothing like
     that.
3. If the source document has more than one distinct opening script (e.g.
   different intros for different recruiting pools/respondent groups),
   extract each as a separate item in "openings" with a short "condition"
   describing when it applies. If there's only one opening, still return it
   as a single-item array with condition "Default".
4. Extract the closing/invitation script (the final "would you like to
   participate" ask plus incentive details) into "closing", with the
   accept and decline responses.
5. If you are genuinely unsure about a question's exact boundary, its skip
   or terminate condition, or how to phrase it naturally, make your best
   reasonable guess AND set needs_review=true with a review_note explaining
   exactly what's uncertain. Never silently guess on something that changes
   who gets disqualified or what gets asked -- flag it instead.
6. If something is ambiguous at the document level rather than tied to one
   question (e.g. it's unclear which opening variant is the default, an
   incentive amount is missing for one respondent group, the document
   references a quota table you can't fully resolve), add a short note to
   the top-level "flags" array instead of a per-question review_note.
7. Keep every question's phrasing natural and speakable over the phone,
   without changing its meaning or the answer options it implies.
8. Do not add compliance/legal language, incentive amounts, or other
   specifics that aren't in the source document.

Respond with ONLY a single JSON object, no markdown fences, no commentary:
{
  "title": "string",
  "openings": [{ "condition": "string", "script": "string", "decline_response": "string" }, ...],
  "questions": [
    {
      "id": "Q1",
      "text": "string",
      "skip_if": "string or null",
      "terminate_if": "string or null",
      "internal_note": "string or null",
      "needs_review": false,
      "review_note": "string or null"
    }, ...
  ],
  "closing": { "invitation_script": "string", "accept_response": "string", "decline_response": "string" },
  "flags": ["short human-readable note", ...]
}`;

export async function generateScreenerFromDocument(
  documentContent: string,
  format: 'html' | 'text',
  surveyName: string
): Promise<ParsedScreener> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env before parsing.');
  }

  const client = new Anthropic({ apiKey });

  const userPrompt = `Survey name provided by the user: "${surveyName}"

Source document (${format === 'html' ? 'converted from docx, HTML preserves table structure' : 'plain text'}):

${documentContent}`;

  const message = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: userPrompt },
      // Same prefill trick as generateQuestions.ts -- forces raw JSON output
      // instead of a markdown-fenced or preambled response.
      { role: 'assistant', content: '{' },
    ],
  });

  const textBlock = message.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Model returned no text content.');
  }

  const rawText = '{' + textBlock.text;

  let parsed: ParsedScreener;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    const stripped = rawText.replace(/```json|```/g, '').trim();
    const match = stripped.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(
        `Model response was not valid JSON. First 300 chars: ${rawText.slice(0, 300)}`
      );
    }
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      throw new Error(
        `Model response was not valid JSON even after cleanup. First 300 chars: ${rawText.slice(0, 300)}`
      );
    }
  }

  if (!Array.isArray(parsed.questions)) {
    throw new Error('Model response was missing a valid "questions" array.');
  }
  if (!Array.isArray(parsed.openings) || parsed.openings.length === 0) {
    throw new Error('Model response was missing a valid "openings" array.');
  }
  if (!parsed.closing || typeof parsed.closing.invitation_script !== 'string') {
    throw new Error('Model response was missing a valid "closing" object.');
  }

  return {
    title: parsed.title || surveyName,
    openings: parsed.openings,
    questions: parsed.questions.map((q) => ({
      id: q.id,
      text: q.text,
      skip_if: q.skip_if ?? null,
      terminate_if: q.terminate_if ?? null,
      internal_note: q.internal_note ?? null,
      needs_review: Boolean(q.needs_review),
      review_note: q.review_note ?? null,
    })),
    closing: {
      invitation_script: parsed.closing.invitation_script,
      accept_response: parsed.closing.accept_response ?? '',
      decline_response: parsed.closing.decline_response ?? '',
    },
    flags: Array.isArray(parsed.flags) ? parsed.flags : [],
  };
}
