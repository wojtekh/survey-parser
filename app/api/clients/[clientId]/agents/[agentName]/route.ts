import { NextResponse } from 'next/server';
import { getClient, removeAgentFromClient } from '@/lib/clientsDb';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// DELETE /api/clients/:clientId/agents/:agentName
//
// Removes one voice agent's local record from the client. Deliberately does
// NOT touch Cognee -- every agent on a client shares one Cognee identity
// (see lib/cognee.ts), so revoking it here would take down every other
// agent's knowledge-base access too. The shared identity is only revoked
// when the whole client is deleted (see [clientId]/route.ts).
export async function DELETE(
  _request: Request,
  { params }: { params: { clientId: string; agentName: string } }
) {
  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }

  const agent = client.agents.find((a) => a.name === params.agentName);
  if (!agent) {
    return NextResponse.json({ error: 'No such agent on this client.' }, { status: 404 });
  }

  try {
    const updated = await removeAgentFromClient(params.clientId, params.agentName);
    return NextResponse.json({ client: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update client record.' },
      { status: 502 }
    );
  }
}
