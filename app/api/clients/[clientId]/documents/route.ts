import { NextResponse } from 'next/server';
import { getClient } from '@/lib/clientsDb';
import {
  decryptSecret,
  rememberDocument,
  addDocumentsBatch,
  listAgentDocuments,
  deleteAgentDocument,
} from '@/lib/cognee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function findAgent(client: Awaited<ReturnType<typeof getClient>>, agentName: string) {
  return client?.agents.find((a) => a.name === agentName) ?? null;
}

// GET /api/clients/:clientId/documents?agent_name=X -- list documents
// ingested into one agent's knowledge base.
export async function GET(request: Request, { params }: { params: { clientId: string } }) {
  const agentName = new URL(request.url).searchParams.get('agent_name');
  if (!agentName) {
    return NextResponse.json({ error: 'Missing agent_name query param.' }, { status: 400 });
  }

  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }
  const agent = findAgent(client, agentName);
  if (!agent) {
    return NextResponse.json({ error: `No agent named "${agentName}" on this client.` }, { status: 404 });
  }

  try {
    const apiKey = decryptSecret(agent.apiKeyEnc);
    const documents = await listAgentDocuments(apiKey);
    return NextResponse.json({ documents });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to list documents.' },
      { status: 502 }
    );
  }
}

// POST /api/clients/:clientId/documents  (multipart/form-data: file (one or more), agent_name)
//
// One file -- remember() (ingest + build graph in one call). More than one
// file in the same request -- add() each, then a single cognify() over the
// batch, for more consistent cross-document entity linking than N separate
// remember() calls. See client-onboarding-plan.md's ingestion-design
// section for why the two paths differ.
export async function POST(request: Request, { params }: { params: { clientId: string } }) {
  const form = await request.formData().catch(() => null);
  const files = form?.getAll('file').filter((f): f is File => f instanceof File) ?? [];
  const agentName = form?.get('agent_name');

  if (files.length === 0) {
    return NextResponse.json({ error: 'Missing file(s).' }, { status: 400 });
  }
  if (typeof agentName !== 'string' || !agentName.trim()) {
    return NextResponse.json({ error: 'Missing agent_name.' }, { status: 400 });
  }

  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }

  const agent = findAgent(client, agentName);
  if (!agent) {
    return NextResponse.json(
      { error: `No agent named "${agentName}" on this client. Provision it first.` },
      { status: 404 }
    );
  }

  try {
    const apiKey = decryptSecret(agent.apiKeyEnc);
    if (files.length === 1) {
      await rememberDocument(apiKey, files[0]);
    } else {
      await addDocumentsBatch(apiKey, files);
    }
    return NextResponse.json({ ok: true, count: files.length });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to upload document(s).' },
      { status: 502 }
    );
  }
}

// DELETE /api/clients/:clientId/documents  { agent_name, dataset_id, data_id }
export async function DELETE(request: Request, { params }: { params: { clientId: string } }) {
  const body = await request.json().catch(() => ({}));
  const { agent_name: agentName, dataset_id: datasetId, data_id: dataId } = body;

  if (!agentName || !datasetId || !dataId) {
    return NextResponse.json(
      { error: 'Missing agent_name, dataset_id, or data_id.' },
      { status: 400 }
    );
  }

  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }
  const agent = findAgent(client, agentName);
  if (!agent) {
    return NextResponse.json({ error: `No agent named "${agentName}" on this client.` }, { status: 404 });
  }

  try {
    const apiKey = decryptSecret(agent.apiKeyEnc);
    await deleteAgentDocument(apiKey, datasetId, dataId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete document.' },
      { status: 502 }
    );
  }
}
