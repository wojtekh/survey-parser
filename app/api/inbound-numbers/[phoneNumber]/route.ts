import { NextResponse } from 'next/server';
import { removeInboundMapping } from '@/lib/googleSheets';

export const runtime = 'nodejs';

// DELETE /api/inbound-numbers/:phoneNumber -- unmap a number entirely
// (it'll error on the next inbound call until reassigned).
export async function DELETE(
  _request: Request,
  { params }: { params: { phoneNumber: string } }
) {
  try {
    await removeInboundMapping(decodeURIComponent(params.phoneNumber));
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to remove inbound number mapping.' },
      { status: 502 }
    );
  }
}
