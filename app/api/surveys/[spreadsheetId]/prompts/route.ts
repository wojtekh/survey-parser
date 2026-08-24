import { NextResponse } from 'next/server';
import {
  getPrompts,
  writePrompts,
  getScreenerRaw,
  normalizeSpreadsheetId,
  type AgentPromptRecord,
} from '@/lib/googleSheets';
import {
  generateAgentPrompts,
  buildAgentDefinition,
  DEFAULT_TOOL_NAME,
} from '@/lib/generateAgentPrompts';
import type { ParsedScreener } from '@/lib/generateScreener';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/surveys/:spreadsheetId/prompts
//
// Returns the saved prompts for this survey. If none were ever saved, returns
// freshly generated ones with saved=false, so the UI always has something to
// show and edit. Generating on read rather than on push keeps the two
// concerns apart: pushing a survey does not silently mint an agent config.
export async function GET(
  _request: Request,
  { params }: { params: { spreadsheetId: string } }
) {
  const spreadsheetId = normalizeSpreadsheetId(params.spreadsheetId);

  try {
    const saved = await getPrompts(spreadsheetId);
    if (saved) {
      return NextResponse.json({ saved: true, prompts: saved });
    }

    const screener = JSON.parse(await getScreenerRaw(spreadsheetId)) as ParsedScreener;
    const generated = generateAgentPrompts(screener, DEFAULT_TOOL_NAME);
    return NextResponse.json({
      saved: false,
      prompts: { ...generated, toolName: DEFAULT_TOOL_NAME, updatedAt: '' },
      suggestedName: screener.title,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load prompts.' },
      { status: 502 }
    );
  }
}

// PUT /api/surveys/:spreadsheetId/prompts  { start, agent, end, toolUuid?, name? }
//
// Saves the edited prompts and returns the Dograh create/definition body built
// from them, ready to POST. The body is returned rather than sent: there is no
// Dograh API client in this app yet, and handing back something reviewable is
// closer to what is actually wanted here than a silent remote create.
export async function PUT(
  request: Request,
  { params }: { params: { spreadsheetId: string } }
) {
  const spreadsheetId = normalizeSpreadsheetId(params.spreadsheetId);
  const body = await request.json().catch(() => null);

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  const fields = ['start', 'agent', 'end'] as const;
  for (const f of fields) {
    if (typeof body[f] !== 'string' || !body[f].trim()) {
      return NextResponse.json({ error: `Missing or empty "${f}" prompt.` }, { status: 400 });
    }
  }

  const record: AgentPromptRecord = {
    start: body.start,
    agent: body.agent,
    end: body.end,
    ...(typeof body.toolUuid === 'string' && body.toolUuid.trim()
      ? { toolUuid: body.toolUuid.trim() }
      : {}),
    toolName:
      typeof body.toolName === 'string' && body.toolName.trim()
        ? body.toolName.trim()
        : DEFAULT_TOOL_NAME,
    updatedAt: new Date().toISOString(),
  };

  try {
    await writePrompts(spreadsheetId, record);
    const definition = buildAgentDefinition({
      name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Screener Agent',
      prompts: record,
      toolUuid: record.toolUuid,
      toolName: record.toolName,
    });
    return NextResponse.json({ ok: true, prompts: record, definition });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save prompts.' },
      { status: 502 }
    );
  }
}
