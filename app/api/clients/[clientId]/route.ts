import { NextResponse } from 'next/server';
import { getClient, updateClient, deleteClientRecord } from '@/lib/clientsDb';
import { deleteAllCogneeAgents } from '@/lib/cognee';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/clients/:clientId -- a single client's record, including
// provisioning status and (encrypted) agent identities.
export async function GET(_request: Request, { params }: { params: { clientId: string } }) {
  try {
    const client = await getClient(params.clientId);
    if (!client) {
      return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
    }
    return NextResponse.json({ client });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load client.' },
      { status: 502 }
    );
  }
}

// PATCH /api/clients/:clientId  { name?, contact_email?, contact_phone?, kb_enabled? }
//
// Edits the client's basic record. Does not touch Cognee -- flipping
// kb_enabled on here only changes whether the "Provision Knowledge Base"
// action is offered; it doesn't provision or deprovision anything itself.
export async function PATCH(request: Request, { params }: { params: { clientId: string } }) {
  const body = await request.json().catch(() => ({}));

  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }

  const updated = {
    ...client,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : client.name,
    contactEmail: typeof body.contact_email === 'string' ? body.contact_email.trim() : client.contactEmail,
    contactPhone: typeof body.contact_phone === 'string' ? body.contact_phone.trim() : client.contactPhone,
    kbEnabled: typeof body.kb_enabled === 'boolean' ? body.kb_enabled : client.kbEnabled,
  };

  try {
    await updateClient(updated);
    return NextResponse.json({ client: updated });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to update client.' },
      { status: 502 }
    );
  }
}

// DELETE /api/clients/:clientId
//
// Cascade-deletes: revokes every one of the client's agent identities in
// Cognee first, then removes the client row -- only once all agents are
// gone. If any agent fails to revoke, the client row is left in place
// (not partially deleted) so this is safely retriable, same philosophy as
// the provision route. A client with no Cognee agents (kbEnabled=false, or
// kbEnabled=true but never provisioned) skips straight to the row delete.
export async function DELETE(_request: Request, { params }: { params: { clientId: string } }) {
  const client = await getClient(params.clientId).catch(() => null);
  if (!client) {
    return NextResponse.json({ error: 'Client not found.' }, { status: 404 });
  }

  if (client.agents.length > 0 && client.cogneeUserEmail && client.cogneePasswordEnc) {
    try {
      const { failed } = await deleteAllCogneeAgents(
        client.cogneeUserEmail,
        client.cogneePasswordEnc,
        client.agents.map((a) => a.agentId)
      );
      if (failed.length > 0) {
        const message = `Could not revoke ${failed.length} of ${client.agents.length} agent(s): ${failed
          .map((f) => f.error)
          .join('; ')}. Client not deleted -- retry once resolved.`;
        await updateClient({ ...client, lastError: message }).catch(() => {});
        return NextResponse.json({ error: message }, { status: 502 });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to revoke Cognee agents.';
      await updateClient({ ...client, lastError: message }).catch(() => {});
      return NextResponse.json({ error: message }, { status: 502 });
    }
  }

  try {
    await deleteClientRecord(params.clientId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to delete client.' },
      { status: 502 }
    );
  }
}
