import { NextResponse } from 'next/server';
import { createSurveySpreadsheet, writeQuestions, addSurveyToIndex } from '@/lib/googleSheets';

export const runtime = 'nodejs';

// POST /api/sheets/push  { questions: string[], name: string }
//
// Multi-survey: every push creates a brand-new spreadsheet (not reused
// across surveys), writes the questions in, and logs it in the index sheet
// so there's always a record of every survey's link. Returns the new
// spreadsheet's ID (this IS the survey identifier from here on -- no
// separate ID to track) and URL.
//
// No separate "share with me" step: the Google client impersonates
// USER_GOOGLE_EMAIL via domain-wide delegation (see lib/googleSheets.ts),
// so every new spreadsheet is already owned by that account directly.
export async function POST(request: Request) {
  const body = await request.json();
  const questions = body.questions;
  const name: string = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled survey';

  if (!Array.isArray(questions) || questions.some((q) => typeof q !== 'string')) {
    return NextResponse.json({ error: 'Expected { questions: string[], name: string }.' }, { status: 400 });
  }
  if (questions.length === 0) {
    return NextResponse.json({ error: 'No questions to write.' }, { status: 400 });
  }

  try {
    const { spreadsheetId, url } = await createSurveySpreadsheet(name);

    await writeQuestions(spreadsheetId, questions);

    await addSurveyToIndex({
      spreadsheetId,
      name,
      url,
      createdAt: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true, spreadsheetId, url, count: questions.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create/write the survey sheet.' },
      { status: 502 }
    );
  }
}
