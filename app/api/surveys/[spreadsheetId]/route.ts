import { NextResponse } from 'next/server';
import {
  removeSurveyFromIndex,
  trashSpreadsheet,
  normalizeSpreadsheetId,
  getAllQuestions,
  getScreenerRawOptional,
  getPrompts,
} from '@/lib/googleSheets';
import type { ParsedScreener } from '@/lib/generateScreener';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/surveys/:spreadsheetId
//
// Everything needed to reopen a survey that was pushed in an earlier session.
// Until this existed, a parsed survey and its agent prompts were only visible
// in the React state of whichever tab pushed them -- reload, and the only way
// back was to re-parse the document, which costs another model call AND
// creates a second spreadsheet (sheets/push always creates a new one).
//
// Nothing new is stored to make this work. The questions, the screener and
// the prompts were already sitting in their own tabs; there was simply no
// route that read them back.
export async function GET(
  _request: Request,
  { params }: { params: { spreadsheetId: string } }
) {
  const spreadsheetId = normalizeSpreadsheetId(params.spreadsheetId);

  try {
    const [questions, screenerRaw, prompts] = await Promise.all([
      getAllQuestions(spreadsheetId),
      getScreenerRawOptional(spreadsheetId),
      getPrompts(spreadsheetId),
    ]);

    let screener: ParsedScreener | null = null;
    if (screenerRaw) {
      try {
        screener = JSON.parse(screenerRaw) as ParsedScreener;
      } catch {
        // Say so rather than rendering a screener-shaped blank. The raw cell
        // is still in the sheet and recoverable by hand.
        return NextResponse.json(
          {
            error:
              "This survey's screener tab holds something that isn't valid JSON. Open the sheet's \"screener\" tab to see what's in cell A1.",
          },
          { status: 502 }
        );
      }
    }

    return NextResponse.json({
      spreadsheetId,
      questions,
      screener,
      hasPrompts: prompts !== null,
      promptsUpdatedAt: prompts?.updatedAt ?? null,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load this survey.' },
      { status: 502 }
    );
  }
}

// DELETE /api/surveys/:spreadsheetId
// Removes the survey from the index sheet's "surveys" tab AND moves its
// own spreadsheet (questions/responses/screener data) to Drive Trash --
// recoverable there for a while, not an instant permanent delete.
export async function DELETE(
  _request: Request,
  { params }: { params: { spreadsheetId: string } }
) {
  const spreadsheetId = normalizeSpreadsheetId(params.spreadsheetId);

  try {
    await removeSurveyFromIndex(spreadsheetId);
    await trashSpreadsheet(spreadsheetId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete survey.' },
      { status: 502 }
    );
  }
}
