import { NextResponse } from 'next/server';
import { getClient, removeAgentFromClient } from '@/lib/clientsDb';
import { deleteCogneeAgent } from '@/lib/cognee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// DELETE /api/clients/:clientId/agents/:agentId
//
// Revokes one agent's Cognee identity and removes it from the client's
// agent list. Deliberately does NOT delete the agent's documents/dataset --
// per Wojtek's call, a knowledge base may end up shared across agents (via
// a future tenant-level grant), so removing one agent must never take
// another agent's shared data down with it.
export async function DELETE(
  _request: Request,
  { params }: { params: { clientId: string; agentId: string } }
) {
  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }

  const agent = client.agents.find((a) => a.agentId === params.agentId);
  if (!agent) {
    return NextResponse.json({ error: 'No such agent on this client.' }, { status: 404 });
  }
  if (!client.cogneeUserEmail || !client.cogneePasswordEnc) {
    return NextResponse.json(
      { error: "This client has no Cognee user on record -- can't revoke the agent." },
      { status: 400 }
    );
  }

  try {
    await deleteCogneeAgent(client.cogneeUserEmail, client.cogneePasswordEnc, params.agentId);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to revoke agent in Cognee.' },
      { status: 502 }
    );
  }

  try {
    const updated = await removeAgentFromClient(params.clientId, params.agentId);
    return NextResponse.json({ client: updated });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          (err instanceof Error ? err.message : 'Failed to update client record.') +
          ' -- the agent WAS revoked in Cognee, but the client record still lists it. Safe to retry: Cognee will just report the agent already gone.',
      },
      { status: 502 }
    );
  }
}
