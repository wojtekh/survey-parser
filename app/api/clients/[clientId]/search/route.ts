import { NextResponse } from 'next/server';
import { getClient } from '@/lib/clientsDb';
import { decryptSecret, searchKnowledgeBase } from '@/lib/cognee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/clients/:clientId/search  { agent_name, query, search_type? }
//
// Queries the client's shared knowledge base through whichever agent's key
// is passed (all of a client's agents share one Cognee identity -- see
// lib/cognee.ts -- so any of them works). This is the smoke-test/manual-
// check path for "is anything actually retrievable" -- Dograh's own MCP
// Tool node is the live-call path, not this route.
export async function POST(request: Request, { params }: { params: { clientId: string } }) {
  const body = await request.json().catch(() => ({}));
  const agentName: unknown = body.agent_name;
  const query: unknown = body.query;
  const searchType: unknown = body.search_type;

  if (typeof agentName !== 'string' || !agentName.trim()) {
    return NextResponse.json({ error: 'Missing agent_name.' }, { status: 400 });
  }
  if (typeof query !== 'string' || !query.trim()) {
    return NextResponse.json({ error: 'Missing query.' }, { status: 400 });
  }

  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }
  const agent = client.agents.find((a) => a.name === agentName);
  if (!agent) {
    return NextResponse.json({ error: `No agent named "${agentName}" on this client.` }, { status: 404 });
  }

  try {
    const apiKey = decryptSecret(agent.apiKeyEnc);
    const type = searchType === 'CHUNKS' || searchType === 'SUMMARIES' ? searchType : 'GRAPH_COMPLETION';
    const results = await searchKnowledgeBase(apiKey, query.trim(), type);
    return NextResponse.json({ results });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to search the knowledge base.' },
      { status: 502 }
    );
  }
}
