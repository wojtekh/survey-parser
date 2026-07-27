import { NextResponse } from 'next/server';
import { recordConfirmedAnswer, resolveSpreadsheetId } from '@/lib/googleSheets';
import { validateField, type FieldType } from '@/lib/validation';
import { checkAgentSecret } from '@/lib/checkAgentSecret';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_FIELD_TYPES: FieldType[] = ['email', 'phone', 'date', 'text'];

// POST /api/agent/validate-field
// { conversation_id, spreadsheet_id, field_key, field_type, value }  -- outbound
// { conversation_id, phone_number, field_key, field_type, value }     -- inbound
//
// Part of the hybrid gathered_context survey flow: most questions are
// captured passively via Dograh's own extraction and only hit the server
// once, in a single batch, at the end of the call (see sync-call route).
// This route is the exception -- for fields tagged "validated" (email,
// phone, date so far), the agent calls this right after the caller answers,
// so a clearly malformed answer can be caught and re-asked on the spot,
// which passive extraction alone can't do (gathered_context isn't visible
// to the agent mid-call, so it has no way to react to a bad value without
// an explicit round trip like this one).
//
// On success, the normalized value is cached in memory keyed by
// conversation_id, so sync-call's end-of-call batch write can prefer it
// over whatever gathered_context independently extracted for the same
// field -- confirmed-and-normalized beats passively-inferred.
export async function POST(request: Request) {
  if (!checkAgentSecret(request)) {
    return NextResponse.json({ error: 'Unauthorized.' }, { status: 401 });
  }

  const body = await request.json();
  const conversationId: string | undefined = body.conversation_id;
  const rawSpreadsheetId: string | undefined = body.spreadsheet_id;
  const phoneNumber: string | undefined = body.phone_number;
  const fieldKey: string | undefined = body.field_key;
  const fieldType: string | undefined = body.field_type;
  const value: string | undefined = body.value;

  if (!conversationId || typeof conversationId !== 'string') {
    return NextResponse.json({ error: 'Missing conversation_id.' }, { status: 400 });
  }
  if (!rawSpreadsheetId && !phoneNumber) {
    return NextResponse.json({ error: 'Missing spreadsheet_id or phone_number.' }, { status: 400 });
  }
  if (!fieldKey || typeof fieldKey !== 'string') {
    return NextResponse.json({ error: 'Missing field_key.' }, { status: 400 });
  }
  if (!fieldType || !VALID_FIELD_TYPES.includes(fieldType as FieldType)) {
    return NextResponse.json(
      { error: `Missing or invalid field_type. Must be one of: ${VALID_FIELD_TYPES.join(', ')}.` },
      { status: 400 }
    );
  }
  if (!value || typeof value !== 'string') {
    return NextResponse.json({ error: 'Missing value.' }, { status: 400 });
  }

  try {
    const spreadsheetId = await resolveSpreadsheetId({
      spreadsheetId: rawSpreadsheetId,
      phoneNumber,
    });

    const result = validateField(fieldType as FieldType, value);

    if (result.valid && result.normalizedValue) {
      recordConfirmedAnswer(spreadsheetId, conversationId, fieldKey, result.normalizedValue);
    }

    return NextResponse.json({
      valid: result.valid,
      normalized_value: result.normalizedValue,
      reason: result.reason,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to validate field.' },
      { status: 502 }
    );
  }
}
