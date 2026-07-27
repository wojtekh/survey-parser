import { NextResponse } from 'next/server';
import { getClient } from '@/lib/googleSheets';

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
