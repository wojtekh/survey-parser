import { NextResponse } from 'next/server';
import { appendResponse, resolveSpreadsheetId } from '@/lib/googleSheets';
import { checkAgentSecret } from '@/lib/checkAgentSecret';

export const runtime = 'nodejs';

// POST /api/agent/record-answer
// { conversation_id, spreadsheet_id, question, answer }  -- outbound
// { conversation_id, phone_number, question, answer }     -- inbound
//
// For surveys with real branching/skip/termination logic, driven by a
// Dograh Knowledge Base document rather than our own flat "questions" tab
// (see submit-answer route, which assumes a fixed known question list --
// that doesn't hold here since the agent decides the order and can skip
// questions per the source document's own logic).
//
// Unlike submit-answer, the question text is NOT derived server-side --
// it's whatever the LLM says it just asked, trusted as-is. There's no
// canonical list to check it against here.
//
// questionIndex here is a server timestamp (ms since epoch), not a running
// count. This used to be a getAnsweredCount() read (a full Sheets API
// round-trip over up to 100k rows) done before every append -- purely
// cosmetic ordering, but it doubled this endpoint's latency and pushed it
// past Dograh's 5s function-call timeout on a real call (the append itself
// succeeded, but arrived ~180ms after Dograh had already given up on the
// tool call and torn down the pipeline). Dropping it to a single Sheets
// API call (just the append) keeps real margin under that timeout. Rows
// still sort correctly by this column; it's just no longer a 0-based count.
export async function POST(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await request.json();
  const conversationId: string | undefined = body.conversation_id;
  const rawSpreadsheetId: string | undefined = body.spreadsheet_id;
  const phoneNumber: string | undefined = body.phone_number;
  const question: string | undefined = body.question;
  const answer: string | undefined = body.answer;

  // Diagnostic: log exactly what Dograh actually sent (not secret material,
  // just the relevant fields) whenever validation fails, so a bad template
  // substitution upstream (e.g. {{workflow_run_id}} rendering empty on a
  // particular call type) shows up here instead of only as a vague error
  // the LLM has to improvise around mid-call.
  if (!conversationId || (!rawSpreadsheetId && !phoneNumber) || !question || !answer) {
    console.log('[record-answer] validation failed, received body:', {
      conversation_id: conversationId,
      spreadsheet_id: rawSpreadsheetId,
      phone_number: phoneNumber,
      question,
      answer,
    });
  }

  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'Missing conversation_id.' }, { status: 400 });
  }
  if (!rawSpreadsheetId && !phoneNumber) {
    return NextResponse.json({ error: 'Missing spreadsheet_id or phone_number.' }, { status: 400 });
  }
  if (!question || typeof question !== 'string') {
    return NextResponse.json({ error: 'Missing question.' }, { status: 400 });
  }
  if (!answer || typeof answer !== 'string') {
    return NextResponse.json({ error: 'Missing answer.' }, { status: 400 });
  }

  try {
    const spreadsheetId = await resolveSpreadsheetId({
      spreadsheetId: rawSpreadsheetId,
      phoneNumber,
    });

    // NOT converted to the wide responses format, deliberately.
    //
    // This route never receives a question id -- the agent sends the question
    // TEXT, whatever it believes it asked. Placing that in a column would mean
    // fuzzy-matching text back to a question, which is the exact drift
    // get_next_screener_question was built to remove. Better to stop than to
    // guess a column and write an answer under the wrong heading.
    return NextResponse.json(
      {
        error:
          'record_answer cannot write to this survey. Its responses tab has one column per question, and this tool does not send a question id -- only the question text, which cannot be matched to a column reliably. Use get_next_screener_question instead; it returns the id to send back.',
      },
      { status: 410 }
    );

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to record answer.' },
      { status: 502 }
    );
  }
}
