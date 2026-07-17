import { NextResponse } from 'next/server';
import { listSurveys } from '@/lib/googleSheets';

export const runtime = 'nodejs';

// GET /api/surveys -- every survey ever pushed, from the index sheet.
// This is "the way to store the survey link/reference" -- read straight
// off the index sheet, no separate database.
export async function GET() {
  try {
    const surveys = await listSurveys();
    return NextResponse.json({ surveys });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load survey list.' },
      { status: 502 }
    );
  }
}
