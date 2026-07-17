import mammoth from 'mammoth';

/**
 * Extract text (with structure) from an uploaded document buffer.
 *
 * docx -> HTML via mammoth. Kept as HTML rather than plain text: mammoth
 * preserves <table> markup, which is what tells the AI parser "this is a
 * rating matrix" apart from a wall of checkbox options.
 *
 * pdf -> plain text via pdf-parse. Table structure degrades for PDFs since
 * there's no reliable structural signal the way docx has -- that's a real
 * limitation, flagged rather than silently guessed by the parser prompt.
 */
export async function extractDocumentText(
  buffer: Buffer,
  filename: string
): Promise<{ content: string; format: 'html' | 'text' }> {
  const lower = filename.toLowerCase();

  if (lower.endsWith('.docx')) {
    const result = await mammoth.convertToHtml({ buffer });
    return { content: result.value, format: 'html' };
  }

  if (lower.endsWith('.pdf')) {
    const pdfParse = (await import('pdf-parse')).default;
    const result = await pdfParse(buffer);
    return { content: result.text, format: 'text' };
  }

  if (lower.endsWith('.txt') || lower.endsWith('.md')) {
    return { content: buffer.toString('utf-8'), format: 'text' };
  }

  throw new Error(
    `Unsupported file type for "${filename}". Supported: .docx, .pdf, .txt, .md`
  );
}
