import { NextResponse } from 'next/server';
import { getPrompts, writePrompts, normalizeSpreadsheetId } from '@/lib/googleSheets';
import { buildAgentDefinition } from '@/lib/generateAgentPrompts';
import { createAgent, updateAgent, archiveAgent, DograhApiError } from '@/lib/dograh';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/surveys/:spreadsheetId/agent  { name }
//
// Push this survey's saved prompts to Dograh. Creates the agent the first
// time and updates the same agent every time after, because the id is stored
// back into the survey's own `prompts` tab.
//
// That storage is the whole point. Without it every save would mint another
// near-identical agent -- the same problem sheets/push still has, avoidable
// here only because Dograh exposes PUT /workflow/{id}.
//
// Prompts must be saved first (PUT ./prompts). This route deliberately does
// not accept prompt text: the thing pushed to Dograh should be exactly the
// thing on record for the survey, never a copy that drifted in a browser tab.
export async function POST(
  request: Request,
  { params }: { params: { spreadsheetId: string } }
) {
  const spreadsheetId = normalizeSpreadsheetId(params.spreadsheetId);
  const body = await request.json().catch(() => ({}));

  let record;
  try {
    record = await getPrompts(spreadsheetId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read the saved prompts.' },
      { status: 502 }
    );
  }

  if (!record) {
    return NextResponse.json(
      { error: 'Save the prompts for this survey before pushing them to Dograh.' },
      { status: 400 }
    );
  }

  const name =
    typeof body.name === 'string' && body.name.trim() ? body.name.trim() : 'Screener Agent';
  const definition = buildAgentDefinition({
    name,
    prompts: record,
    toolUuid: record.toolUuid,
  });

  const existingId = record.dograhWorkflowId;

  // --- update path: the id is already known, nothing new is created ---
  if (typeof existingId === 'number') {
    try {
      await updateAgent(existingId, definition);
    } catch (err) {
      return NextResponse.json(
        {
          error:
            err instanceof Error
              ? err.message
              : `Failed to update Dograh agent ${existingId}.`,
          ...(err instanceof DograhApiError && err.status === 404
            ? {
                hint: `Agent ${existingId} no longer exists in Dograh. Clear it from this survey's prompts tab to create a fresh one.`,
              }
            : {}),
        },
        { status: 502 }
      );
    }

    const updated = { ...record, dograhPushedAt: new Date().toISOString() };
    await writePrompts(spreadsheetId, updated).catch(() => {});
    return NextResponse.json({
      ok: true,
      action: 'updated',
      workflowId: existingId,
      workflowUuid: record.dograhWorkflowUuid ?? null,
    });
  }

  // --- create path: an agent now exists in Dograh that this app must not lose ---
  let created;
  try {
    created = await createAgent(definition);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create the Dograh agent.' },
      { status: 502 }
    );
  }

  try {
    await writePrompts(spreadsheetId, {
      ...record,
      dograhWorkflowId: created.id,
      dograhWorkflowUuid: created.workflowUuid,
      dograhPushedAt: new Date().toISOString(),
    });
  } catch (err) {
    // The agent exists but we could not record which one it is. Left alone,
    // the next push would create a second identical agent. Archive it and
    // report the original failure -- same rollback shape as sheets/push.
    let archived = true;
    try {
      await archiveAgent(created.id);
    } catch (archiveErr) {
      archived = false;
      console.error('[surveys/agent] rollback: could not archive agent', created.id, archiveErr);
    }
    return NextResponse.json(
      {
        error:
          (err instanceof Error ? err.message : 'Failed to record the new agent id.') +
          (archived
            ? ` The agent that was just created (id ${created.id}) has been archived, so nothing was left behind. Try again.`
            : ` The agent that was just created (id ${created.id}) could NOT be archived -- archive it by hand in Dograh before retrying, or the next push will make a duplicate.`),
        workflowId: created.id,
        rolledBack: archived,
      },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    action: 'created',
    workflowId: created.id,
    workflowUuid: created.workflowUuid,
  });
}
