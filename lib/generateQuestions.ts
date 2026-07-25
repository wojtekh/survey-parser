import Anthropic from '@anthropic-ai/sdk';

// Deliberately flat: one plain spoken question per string. Matches the
// "questions" tab of the reference template exactly (single column, no
// type/choices/id metadata) -- any scale or choice info gets folded
// naturally into the question text itself (e.g. "...female, male, gender
// diverse, or would you prefer not to say?"), the same way the reference
// template phrases its NPS-style questions ("On a scale of 0 to 10...").
export interface ParsedSurvey {
  title: string;
  questions: string[];
  flags: string[];
}

const SYSTEM_PROMPT = `You convert a source document (a survey/form written in prose, possibly with
tables) into a flat list of plain, speakable questions for a voice agent to
ask over the phone. The source documents are often messy: inconsistent
formatting, no question numbering, type signals in inconsistent places, and
sometimes genuinely broken logic. Your job is extraction PLUS honest
flagging of anything you're unsure about.

Rules:
1. Output ONE natural, speakable question per source question -- no
   question IDs, no separate type/choices fields. If the source question has
   a SHORT closed set of choices (roughly 8 or fewer -- radio buttons,
   "select all that apply", a short dropdown like gender or an income
   bracket), fold them naturally into the spoken question, e.g. "What
   gender do you identify as -- female, male, gender diverse, or would you
   prefer not to say?" If the source question has a LONG dropdown that's
   really just a big reference list rather than a meaningful small set of
   choices (country, city, occupation, or anything with roughly 9+ options),
   do NOT read the list aloud -- ask it as a plain open-ended question
   instead, e.g. a 195-country dropdown becomes simply "What country were
   you born in?"
2. If a ratings TABLE is present (rows = items, columns = a scale), turn
   each row into its own question with the scale folded in, e.g. "On a
   scale of 1 to 5, how motivating are cash payments when deciding to
   complete a survey?"
3. If a single line of source text bundles a choice AND a conditional
   follow-up ("I didn't buy anything, if not, why ___"), keep it as ONE
   natural question that a person could actually answer in conversation
   rather than two rigid branches -- e.g. "Did you consider buying anything
   in the last 30 days, and if not, why?" Voice conversations handle this
   kind of natural conditionality fine without explicit branching logic.
4. If the source document has a logic gap (e.g. asks for "province" but
   never "state" for a country where that would apply, or merges two
   questions that should be separate), fix it AND add a note to "flags"
   explaining what you changed and why. Never silently replicate broken
   logic without flagging it.
5. If you're genuinely unsure where a question's boundaries are (common in
   documents with no numbering) or how to phrase something naturally, make
   your best guess AND add a flag describing the uncertainty.
6. Question types with no reasonable voice equivalent (file upload,
   signature, image picker) should get a flag noting they need a non-voice
   follow-up instead of a spoken question.
7. Keep the total question count close to the source document -- don't
   split one question into many or merge unrelated questions together.
8. Do not invent survey content beyond the minimal structural fixes covered
   by rule 4.

Respond with ONLY a single JSON object, no markdown fences, no commentary:
{
  "title": "string",
  "questions": ["plain speakable question text", ...],
  "flags": ["short human-readable note", ...]
}`;

export async function generateQuestionsFromDocument(
  documentContent: string,
  format: 'html' | 'text',
  surveyName: string
): Promise<ParsedSurvey> {
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
      // Prefill the assistant turn with "{" -- this is the reliable way to
      // stop Claude from wrapping the response in a markdown code fence or
      // adding a preamble sentence despite the system prompt asking for raw
      // JSON. The model continues from "{" rather than starting fresh.
      { role: 'assistant', content: '{' },
    ],
  });

  const textBlock = message.content.find((block) => block.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Model returned no text content.');
  }

  // Prefill means the response continues from "{" without repeating it.
  const rawText = '{' + textBlock.text;

  let parsed: ParsedSurvey;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // Fallback for the rare case a fence or stray text still slipped in:
    // strip ```json fences and grab the outermost {...} block.
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

  return {
    title: parsed.title || surveyName,
    questions: parsed.questions,
    flags: Array.isArray(parsed.flags) ? parsed.flags : [],
  };
}
