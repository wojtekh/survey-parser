import { NextResponse } from 'next/server';
import { checkAgentSecret } from '@/lib/checkAgentSecret';
import { getClient, getService } from '@/lib/clientsDb';
import { decryptSecret } from '@/lib/cognee';
import { evaluateTranscript, sendSlackAlert, TranscriptInput } from '@/lib/callReview';
import { appendKbGap } from '@/lib/googleSheets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/agent/call-review
// { conversation_id, client_id, agent_name, transcript }
//
// The self-improvement half of the KB loop (see lib/callReview.ts): fired
// once per call, from a Dograh Webhook Node placed right before End Call --
// same mechanism as sync-call (see that route's header comment), not a tool
// the agent decides to call.
//
// UNVERIFIED against a live Dograh deployment (docs.dograh.com was not
// reachable to confirm this while writing it -- see dograh/README_TOOLS.md's
// "Call review" section for what to check before trusting this in
// production, same spirit as lib/dograh.ts's own ASSUMED markers):
//   - Whether Dograh exposes the full transcript as a template variable at
//     all (a Webhook Node's body_template can reference
//     {{initial_context.*}} / {{gathered_context.*}}, but "the full
//     transcript" is described in Dograh's marketing docs as a
//     platform/dashboard feature, not confirmed as a templatable field).
//   - If it doesn't, this route will need a second Dograh API call instead
//     (fetch the transcript by workflow_run_id, which Dograh does expose in
//     initial_context per dograh-hq/dograh PR #774) -- not implemented here
//     since the fetch endpoint's shape is unconfirmed.
//
// `client_id`/`agent_name` are NOT inferable from anything Dograh sends
// today -- unlike spreadsheet_id (surveys) there is no existing mapping
// from a Dograh workflow to a KB client in this app. They must be added as
// new Preset Parameters on this agent's Webhook Node, same pattern as
// spreadsheet_id (see dograh/README_TOOLS.md).
export async function POST(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const conversationId: unknown = body.conversation_id;
  const clientId: unknown = body.client_id;
  const agentName: unknown = body.agent_name;
  const transcript: unknown = body.transcript;

  if (typeof clientId !== 'string' || !clientId.trim()) {
    return NextResponse.json({ error: 'Missing client_id.' }, { status: 400 });
  }
  if (typeof agentName !== 'string' || !agentName.trim()) {
    return NextResponse.json({ error: 'Missing agent_name.' }, { status: 400 });
  }
  if (!transcript || (typeof transcript !== 'string' && !Array.isArray(transcript))) {
    return NextResponse.json({ error: 'Missing transcript (string or array of {role, text} turns).' }, { status: 400 });
  }
  const convId = typeof conversationId === 'string' && conversationId.trim() ? conversationId.trim() : 'unknown';

  const client = await getClient(clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }
  const agent = client.agents.find((a) => a.name === agentName);
  if (!agent) {
    return NextResponse.json({ error: `No agent named "${agentName}" on this client.` }, { status: 404 });
  }

  try {
    const apiKey = decryptSecret(agent.apiKeyEnc);
    const result = await evaluateTranscript(transcript as TranscriptInput, apiKey);

    for (const gap of result.gaps) {
      await appendKbGap({
        clientId,
        agentName,
        conversationId: convId,
        type: gap.type,
        callerQuestion: gap.callerQuestion,
        note: gap.note,
        satisfied: result.satisfied,
      });
    }

    const callReviewService = await getService(clientId, 'call_review');
    const slackWebhookUrl = callReviewService?.data?.slackWebhookUrl;
    if (slackWebhookUrl && (!result.satisfied || result.gaps.length > 0)) {
      const knowledgeGaps = result.gaps.filter((g) => g.type === 'knowledge_gap');
      const lines = [
        `*Call review* -- ${client.name} / ${agentName} (call ${convId})`,
        `Caller satisfied: ${result.satisfied ? 'yes' : 'no'}`,
        ...result.gaps.map((g) => `- [${g.type}] "${g.callerQuestion}" -- ${g.note}`),
      ];
      if (knowledgeGaps.length > 0) {
        lines.push(`${knowledgeGaps.length} knowledge gap(s) need a document added to the knowledge base.`);
      }
      await sendSlackAlert(slackWebhookUrl, lines.join('\n'));
    }

    return NextResponse.json({ ok: true, satisfied: result.satisfied, gaps: result.gaps });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to review call.' },
      { status: 502 }
    );
  }
}
