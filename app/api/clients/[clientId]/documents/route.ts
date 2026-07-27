import { NextResponse } from 'next/server';
import { getClient } from '@/lib/clientsDb';
import { decryptSecret, rememberDocument } from '@/lib/cognee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/clients/:clientId/documents  (multipart/form-data: file, agent_name)
//
// Uploads one document into a specific agent's own knowledge base (ingest +
// build the graph in one call). Works the same whether this is the first
// starter document for a freshly-provisioned client or a later top-up --
// see client-onboarding-plan.md for when a batch upload should use
// add()+cognify() instead (not built yet; this route covers the common
// one-file-at-a-time case).
export async function POST(request: Request, { params }: { params: { clientId: string } }) {
  const form = await request.formData().catch(() => null);
  const file = form?.get('file');
  const agentName = form?.get('agent_name');

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file.' }, { status: 400 });
  }
  if (typeof agentName !== 'string' || !agentName.trim()) {
    return NextResponse.json({ error: 'Missing agent_name.' }, { status: 400 });
  }

  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }

  const agent = client.agents.find((a) => a.name === agentName);
  if (!agent) {
    return NextResponse.json(
      { error: `No agent named "${agentName}" on this client. Provision it first.` },
      { status: 404 }
    );
  }

  try {
    const apiKey = decryptSecret(agent.apiKeyEnc);
    await rememberDocument(apiKey, file);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to upload document.' },
      { status: 502 }
    );
  }
}
