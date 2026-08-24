import { NextResponse } from 'next/server';
import { extractDocumentText } from '@/lib/parseDocument';
import { generateQuestionsFromDocument } from '@/lib/generateQuestions';
import { generateScreenerFromDocument } from '@/lib/generateScreener';
import { MAX_UPLOAD_BYTES, MAX_DOCUMENT_CHARS, formatBytes } from '@/lib/limits';

export const runtime = 'nodejs';
export const maxDuration = 120;

export type SurveyType = 'simple' | 'screener';

// POST /api/parse
// multipart/form-data: { file: File, name?: string, type?: 'simple' | 'screener' }
// Upload -> parse, nothing persisted server-side. The response is the full
// result; it's up to whatever consumes this later (a Sheet-writing
// automation, a copy/paste into BuildShip/n8n) to store it.
//
// type='simple' (default): flat linear survey, one plain question per line
// -- see generateQuestionsFromDocument. type='screener': recruitment/
// qualifier document with real skip/termination logic -- see
// generateScreenerFromDocument, which returns a structured, editable
// question list instead of a flat one.
export async function POST(request: Request) {
  // Check the declared size BEFORE formData(), because formData() is what
  // buffers the whole body into memory -- checking file.size afterwards is
  // already too late to stop a huge upload from doing damage.
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `That upload is ${formatBytes(declaredLength)}. The limit is ${formatBytes(
          MAX_UPLOAD_BYTES
        )}. Upload a smaller document, or split it.`,
      },
      { status: 413 }
    );
  }

  const formData = await request.formData();
  const file = formData.get('file');
  const name = formData.get('name');
  const typeField = formData.get('type');
  const surveyType: SurveyType = typeField === 'screener' ? 'screener' : 'simple';
  const surveyName = typeof name === 'string' && name.trim() ? name.trim() : 'Untitled survey';

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file upload.' }, { status: 400 });
  }

  // Second guard, for a chunked upload that sent no content-length header.
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      {
        error: `"${file.name}" is ${formatBytes(file.size)}. The limit is ${formatBytes(
          MAX_UPLOAD_BYTES
        )}. Upload a smaller document, or split it.`,
      },
      { status: 413 }
    );
  }

  const buffer = Buffer.from(await file.arrayBuffer());

  let extracted;
  try {
    extracted = await extractDocumentText(buffer, file.name);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to read document.' },
      { status: 400 }
    );
  }

  if (!extracted.content.trim()) {
    return NextResponse.json(
      { error: 'No readable text found in that document.' },
      { status: 400 }
    );
  }

  // A small file can still hold a very long document. This is the cap that
  // actually protects the model call -- both the context window and the bill.
  if (extracted.content.length > MAX_DOCUMENT_CHARS) {
    return NextResponse.json(
      {
        error: `"${file.name}" holds about ${Math.round(
          extracted.content.length / 1000
        )}k characters of text. The limit is ${Math.round(
          MAX_DOCUMENT_CHARS / 1000
        )}k. Split the survey into smaller documents and parse them one at a time.`,
      },
      { status: 413 }
    );
  }

  try {
    if (surveyType === 'screener') {
      const parsed = await generateScreenerFromDocument(
        extracted.content,
        extracted.format,
        surveyName
      );
      return NextResponse.json({ surveyType, result: parsed, sourceFilename: file.name });
    }

    const parsed = await generateQuestionsFromDocument(extracted.content, extracted.format, surveyName);
    return NextResponse.json({ surveyType, result: parsed, sourceFilename: file.name });
  } catch (err) {
    return NextResponse.json(
      {
        error:
          err instanceof Error ? err.message : 'Failed to generate questions from that document.',
      },
      { status: 502 }
    );
  }
}
