import { NextResponse } from 'next/server';
import {
  createSurveySpreadsheet,
  writeQuestions,
  writeScreener,
  addSurveyToIndex,
  removeSurveyFromIndex,
  trashSpreadsheet,
} from '@/lib/googleSheets';

export const runtime = 'nodejs';

/**
 * Undo a push that failed partway. Called only from the catch below, and
 * only once a spreadsheet actually exists.
 *
 * Why this is needed: createSurveySpreadsheet makes a real object in Drive,
 * and the three steps after it can each fail. Without cleanup, a failure at
 * addSurveyToIndex leaves a spreadsheet that has questions in it but no
 * index row -- and since the UI list reads from the index sheet, that sheet
 * is invisible. The user can't see it and can't delete it. It stays in
 * Drive forever, and a retry adds another one next to it.
 *
 * Order matters. Drop the index row first, then trash the spreadsheet. If
 * only the first half runs, the leftover is an untracked sheet in Drive --
 * annoying but harmless. The other order risks an index row pointing at a
 * trashed sheet, which is a dead link the UI shows and the user can't fix.
 * Risk the annoying leftover, not the dead link.
 *
 * removeSurveyFromIndex is already idempotent (a no-op when the row isn't
 * there), so this is safe whether or not indexing got that far. No need to
 * track how far the push reached.
 *
 * Each step swallows its own error on purpose. A failed cleanup must never
 * replace the real error that caused it. The caller reports the original
 * error, plus whether the cleanup finished.
 */
async function rollbackPartialPush(spreadsheetId: string): Promise<boolean> {
  let clean = true;

  try {
    await removeSurveyFromIndex(spreadsheetId);
  } catch (err) {
    clean = false;
    console.error('[sheets/push] rollback: could not remove index row for', spreadsheetId, err);
  }

  try {
    // Drive Trash, not a permanent delete -- recoverable if this ever fires
    // on a sheet someone did want.
    await trashSpreadsheet(spreadsheetId);
  } catch (err) {
    clean = false;
    console.error('[sheets/push] rollback: could not trash spreadsheet', spreadsheetId, err);
  }

  return clean;
}

// POST /api/sheets/push  { questions: string[], name: string, screener?: object }
//
// Multi-survey: every push creates a brand-new spreadsheet (not reused
// across surveys), writes the questions in, and logs it in the index sheet
// so there's always a record of every survey's link. Returns the new
// spreadsheet's ID (this IS the survey identifier from here on -- no
// separate ID to track) and URL.
//
// `screener`, if present, is the full edited ParsedScreener object from a
// screener-type parse -- written to its own "screener" tab as JSON so the
// /api/agent/next-screener-question tool can resolve skip/terminate logic
// server-side at call time. `questions` (the flattened text list) is still
// written to the "questions" tab either way, purely as a human-readable
// reference -- it's not what the deterministic tool reads.
//
// No separate "share with me" step: the Google client impersonates
// USER_GOOGLE_EMAIL via domain-wide delegation (see lib/googleSheets.ts),
// so every new spreadsheet is already owned by that account directly.
export async function POST(request: Request) {
  const body = await request.json();
  const questions = body.questions;
  const screener = body.screener;
  const name: string = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Untitled survey';

  if (!Array.isArray(questions) || questions.some((q) => typeof q !== 'string')) {
    return NextResponse.json({ error: 'Expected { questions: string[], name: string }.' }, { status: 400 });
  }
  if (questions.length === 0) {
    return NextResponse.json({ error: 'No questions to write.' }, { status: 400 });
  }

  // Tracked outside the try so the catch can undo a partial push. Null until
  // the spreadsheet exists; from that point on, any failure needs cleanup.
  let createdId: string | null = null;

  try {
    const { spreadsheetId, url } = await createSurveySpreadsheet(name);
    createdId = spreadsheetId;

    await writeQuestions(spreadsheetId, questions);

    if (screener) {
      await writeScreener(spreadsheetId, screener);
    }

    await addSurveyToIndex({
      spreadsheetId,
      name,
      url,
      createdAt: new Date().toISOString(),
    });

    return NextResponse.json({ ok: true, spreadsheetId, url, count: questions.length });
  } catch (err) {
    const original =
      err instanceof Error ? err.message : 'Failed to create/write the survey sheet.';

    // Failed before anything was created -- nothing to undo.
    if (!createdId) {
      return NextResponse.json({ error: original }, { status: 502 });
    }

    const clean = await rollbackPartialPush(createdId);

    return NextResponse.json(
      {
        error: clean
          ? `${original} The half-created sheet was rolled back, so nothing was left behind. Try again.`
          : `${original} The half-created sheet could NOT be fully rolled back. Spreadsheet ${createdId} may still be in Google Drive -- delete it by hand.`,
        rolledBack: clean,
      },
      { status: 502 }
    );
  }
}
