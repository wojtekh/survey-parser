import { NextResponse } from 'next/server';
import { extractDocumentText } from '@/lib/parseDocument';
import { generateQuestionsFromDocument } from '@/lib/generateQuestions';
import { generateScreenerFromDocument } from '@/lib/generateScreener';

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
  const formData = await request.formData();
  const file = formData.get('file');
  const name = formData.get('name');
  const typeField = formData.get('type');
  const surveyType: SurveyType = typeField === 'screener' ? 'screener' : 'simple';
  const surveyName = typeof name === 'string' && name.trim() ? name.trim() : 'Untitled survey';

  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file upload.' }, { status: 400 });
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
