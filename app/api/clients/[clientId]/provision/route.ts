import { NextResponse } from 'next/server';
import { getClient, updateClient } from '@/lib/clientsDb';
import { provisionClientKnowledgeBase } from '@/lib/cognee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/clients/:clientId/provision  { agent_names: string[] }
//
// Does the actual Cognee work: registers (or reuses) this client's own
// Cognee user, then mints an agent identity for each requested agent name
// that doesn't already exist for this client. Independently retriable --
// safe to call again after a failure (nothing is duplicated), and safe to
// call later with additional agent names to grow an already-provisioned
// client without touching its existing agents.
export async function POST(request: Request, { params }: { params: { clientId: string } }) {
  const body = await request.json().catch(() => ({}));
  const agentNames: unknown = body.agent_names;

  if (!Array.isArray(agentNames) || agentNames.length === 0 || !agentNames.every((n) => typeof n === 'string' && n.trim())) {
    return NextResponse.json({ error: 'Missing or invalid agent_names (expected a non-empty array of strings).' }, { status: 400 });
  }
  const names = agentNames.map((n) => (n as string).trim());

  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }
  if (!client.kbEnabled) {
    return NextResponse.json(
      { error: 'This client was not marked for a knowledge base. Enable it on the client record first.' },
      { status: 400 }
    );
  }

  try {
    const result = await provisionClientKnowledgeBase({
      clientId: client.clientId,
      agentNames: names,
      existingCogneeUserEmail: client.cogneeUserEmail,
      existingCogneePasswordEnc: client.cogneePasswordEnc,
      existingAgents: client.agents,
    });

    const updated = {
      ...client,
      kbStatus: 'provisioned' as const,
      cogneeUserEmail: result.cogneeUserEmail,
      cogneePasswordEnc: result.cogneePasswordEnc,
      agents: result.agents,
      lastError: null,
    };
    await updateClient(updated);
    return NextResponse.json({ client: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to provision knowledge base.';
    // Best-effort status flag so the UI can show "retry" -- if even this
    // write fails, the original error above is still what gets returned.
    await updateClient({ ...client, kbStatus: 'error', lastError: message }).catch(() => {});
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
