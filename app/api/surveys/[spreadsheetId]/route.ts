import { NextResponse } from 'next/server';
import { removeSurveyFromIndex, trashSpreadsheet, normalizeSpreadsheetId } from '@/lib/googleSheets';

export const runtime = 'nodejs';

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
