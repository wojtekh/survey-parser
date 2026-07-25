import { NextResponse } from 'next/server';
import { listInboundMappings, setActiveSurveyForNumber, normalizeSpreadsheetId } from '@/lib/googleSheets';

export const runtime = 'nodejs';

// GET /api/inbound-numbers -- every phone_number -> spreadsheet_id mapping,
// from the index sheet's "inbound_numbers" tab.
export async function GET() {
  try {
    const mappings = await listInboundMappings();
    return NextResponse.json({ mappings });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load inbound number mappings.' },
      { status: 502 }
    );
  }
}

// POST /api/inbound-numbers  { phone_number, spreadsheet_id }
// Upsert -- creates the mapping if new, repoints it if it already exists.
// This is the entire "reassign a number to a new survey" operation; no
// Dograh tool config needs touching, since inbound tools read this
// mapping via phone_number at call time (see lib/googleSheets.ts
// resolveSpreadsheetId).
export async function POST(request: Request) {
  const body = await request.json();
  const phoneNumber: string | undefined = body.phone_number;
  const rawSpreadsheetId: string | undefined = body.spreadsheet_id;

  if (!phoneNumber || typeof phoneNumber !== 'string' || !phoneNumber.trim()) {
    return NextResponse.json({ error: 'Missing phone_number.' }, { status: 400 });
  }
  if (!rawSpreadsheetId || typeof rawSpreadsheetId !== 'string' || !rawSpreadsheetId.trim()) {
    return NextResponse.json({ error: 'Missing spreadsheet_id.' }, { status: 400 });
  }

  try {
    const spreadsheetId = normalizeSpreadsheetId(rawSpreadsheetId);
    await setActiveSurveyForNumber(phoneNumber.trim(), spreadsheetId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to set inbound number mapping.' },
      { status: 502 }
    );
  }
}
