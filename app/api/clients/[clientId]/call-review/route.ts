import { NextResponse } from 'next/server';
import { getClient, getService, upsertService } from '@/lib/clientsDb';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET/PUT /api/clients/:clientId/call-review -- the optional Slack webhook
// that /api/agent/call-review posts a gap alert to. Its own client_services
// row ('call_review'), separate from 'knowledge_base', since it's a
// different concern (alerting, not KB provisioning) -- see clientsDb.ts's
// header comment on why new per-client settings go through the generic
// services API instead of new flat Client columns.
export async function GET(_request: Request, { params }: { params: { clientId: string } }) {
  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }
  const service = await getService(params.clientId, 'call_review');
  return NextResponse.json({ slackWebhookUrl: service?.data?.slackWebhookUrl ?? null });
}

export async function PUT(request: Request, { params }: { params: { clientId: string } }) {
  const body = await request.json().catch(() => ({}));
  const slackWebhookUrl: unknown = body.slack_webhook_url;

  if (slackWebhookUrl !== null && typeof slackWebhookUrl !== 'string') {
    return NextResponse.json({ error: 'slack_webhook_url must be a string or null.' }, { status: 400 });
  }

  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }

  const trimmed = typeof slackWebhookUrl === 'string' ? slackWebhookUrl.trim() : null;
  try {
    await upsertService(params.clientId, 'call_review', {
      enabled: !!trimmed,
      status: 'none',
      lastError: null,
      data: { slackWebhookUrl: trimmed || null },
    });
    return NextResponse.json({ slackWebhookUrl: trimmed || null });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to save call review settings.' },
      { status: 502 }
    );
  }
}
