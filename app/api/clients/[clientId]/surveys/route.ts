import { NextResponse } from 'next/server';
import { getClient, getService, upsertService } from '@/lib/clientsDb';
import { listSurveys } from '@/lib/googleSheets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SERVICE_TYPE = 'survey';

function spreadsheetIds(data: Record<string, any> | undefined): string[] {
  return Array.isArray(data?.spreadsheetIds) ? data!.spreadsheetIds : [];
}

// GET /api/clients/:clientId/surveys -- the surveys linked to this client,
// and every other survey (so the UI can offer "link an existing one"
// without listing surveys already linked here).
export async function GET(_request: Request, { params }: { params: { clientId: string } }) {
  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }

  try {
    const [service, all] = await Promise.all([
      getService(params.clientId, SERVICE_TYPE),
      listSurveys(),
    ]);
    const linkedIds = new Set(spreadsheetIds(service?.data));
    const linked = all.filter((s) => linkedIds.has(s.spreadsheetId));
    const available = all.filter((s) => !linkedIds.has(s.spreadsheetId));
    return NextResponse.json({ linked, available });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load surveys.' },
      { status: 502 }
    );
  }
}

// POST /api/clients/:clientId/surveys  { spreadsheet_id }
// Links an existing survey to this client. Pure bookkeeping in SQLite --
// does not touch the survey's own spreadsheet or its index row.
export async function POST(request: Request, { params }: { params: { clientId: string } }) {
  const body = await request.json().catch(() => ({}));
  const spreadsheetId: unknown = body.spreadsheet_id;
  if (typeof spreadsheetId !== 'string' || !spreadsheetId.trim()) {
    return NextResponse.json({ error: 'Missing spreadsheet_id.' }, { status: 400 });
  }

  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }

  try {
    const current = await getService(params.clientId, SERVICE_TYPE);
    const ids = spreadsheetIds(current?.data);
    if (!ids.includes(spreadsheetId)) ids.push(spreadsheetId);

    await upsertService(params.clientId, SERVICE_TYPE, {
      enabled: true,
      status: 'provisioned',
      lastError: null,
      data: { spreadsheetIds: ids },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to link survey.' },
      { status: 502 }
    );
  }
}

// DELETE /api/clients/:clientId/surveys  { spreadsheet_id }
// Unlinks a survey from this client. Never deletes the survey itself or its
// spreadsheet -- see lib/googleSheets.ts removeSurveyFromIndex for that.
export async function DELETE(request: Request, { params }: { params: { clientId: string } }) {
  const body = await request.json().catch(() => ({}));
  const spreadsheetId: unknown = body.spreadsheet_id;
  if (typeof spreadsheetId !== 'string' || !spreadsheetId.trim()) {
    return NextResponse.json({ error: 'Missing spreadsheet_id.' }, { status: 400 });
  }

  try {
    const current = await getService(params.clientId, SERVICE_TYPE);
    const ids = spreadsheetIds(current?.data).filter((id) => id !== spreadsheetId);

    await upsertService(params.clientId, SERVICE_TYPE, {
      data: { spreadsheetIds: ids },
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to unlink survey.' },
      { status: 502 }
    );
  }
}
