import { NextResponse } from 'next/server';
import { createClient, listClients } from '@/lib/googleSheets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET /api/clients -- every client ever created, from the index sheet's
// "clients" tab.
export async function GET() {
  try {
    const clients = await listClients();
    return NextResponse.json({ clients });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to load clients.' },
      { status: 502 }
    );
  }
}

// POST /api/clients  { name, contact_email, contact_phone, kb_enabled }
// Always just writes the basic client record -- no Cognee call happens
// here, whether or not kb_enabled is set. Provisioning the knowledge base
// is a separate, independently-retriable step (POST .../provision) so a
// Cognee hiccup can never corrupt or block this part. See
// client-onboarding-plan.md for why.
export async function POST(request: Request) {
  const body = await request.json();
  const name: string | undefined = body.name;
  const contactEmail: string | undefined = body.contact_email;
  const contactPhone: string | undefined = body.contact_phone;
  const kbEnabled: boolean = Boolean(body.kb_enabled);

  if (!name || typeof name !== 'string' || !name.trim()) {
    return NextResponse.json({ error: 'Missing client name.' }, { status: 400 });
  }

  try {
    const client = await createClient({
      name: name.trim(),
      contactEmail: (contactEmail ?? '').trim(),
      contactPhone: (contactPhone ?? '').trim(),
      kbEnabled,
    });
    return NextResponse.json({ client });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to create client.' },
      { status: 502 }
    );
  }
}
