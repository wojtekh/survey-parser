import type { ParsedScreener } from './generateScreener';

// Pure formatter: ParsedScreener -> the same plain-text script shape used
// for the hand-written AGO screener (dograh/ago-screener-script.txt).
// Meant to be pasted directly into a Dograh Knowledge Base document (Full
// Document mode) and read alongside a "Run Screener" agent node prompt.
//
// Kept as a separate render step (rather than generating this text directly
// from the model) so the structured ParsedScreener JSON can be edited in the
// review UI first -- every edit there is reflected here automatically.
export function renderScreenerScript(screener: ParsedScreener): string {
  const lines: string[] = [];

  lines.push(screener.title.toUpperCase() + ' -- VOICE AGENT SCRIPT');
  lines.push(
    '(Restructured for sequential execution. Follow every numbered question IN ORDER.'
  );
  lines.push(
    'Do not skip a question unless its own "SKIP IF" rule applies. Do not invent,'
  );
  lines.push('merge, or substitute any question that is not listed below.)');
  lines.push('');

  lines.push('='.repeat(64));
  lines.push('SECTION 0 -- OPENING');
  lines.push('='.repeat(64));
  lines.push('');

  if (screener.openings.length > 1) {
    lines.push(
      '[INTERNAL] There is more than one opening variant below. Use whichever one matches this call; if unclear, use the one marked "Default".'
    );
    lines.push('');
  }

  for (const opening of screener.openings) {
    lines.push(`OPENING -- ${opening.condition.toUpperCase()}:`);
    lines.push(`"${opening.script}"`);
    lines.push('');
    lines.push(`SKIP IF DECLINED -> Say: "${opening.decline_response}" Then END CALL.`);
    lines.push('');
  }

  lines.push('='.repeat(64));
  lines.push('SECTION 1 -- QUESTIONS (ask every one, in order)');
  lines.push('='.repeat(64));
  lines.push('');

  for (const q of screener.questions) {
    lines.push(`${q.id}. "${q.text}"`);
    if (q.skip_if) {
      lines.push(`    SKIP IF: ${q.skip_if}`);
    }
    if (q.terminate_if) {
      lines.push(`    TERMINATE IF: ${q.terminate_if}`);
    }
    if (q.internal_note) {
      lines.push(`    [INTERNAL -- do not say to caller] ${q.internal_note}`);
    }
    if (q.needs_review) {
      lines.push(`    [!! FLAGGED FOR REVIEW: ${q.review_note ?? 'uncertain extraction'}]`);
    }
    lines.push('');
  }

  lines.push('='.repeat(64));
  lines.push('SECTION 2 -- CLOSING');
  lines.push('='.repeat(64));
  lines.push('');
  lines.push(`"${screener.closing.invitation_script}"`);
  lines.push('');
  if (screener.closing.accept_response) {
    lines.push(`IF YES -> "${screener.closing.accept_response}"`);
  }
  if (screener.closing.decline_response) {
    lines.push(`IF NO -> "${screener.closing.decline_response}"`);
  }
  lines.push('');

  if (screener.flags.length > 0) {
    lines.push('='.repeat(64));
    lines.push('DOCUMENT-LEVEL FLAGS (resolve before relying on this script)');
    lines.push('='.repeat(64));
    for (const flag of screener.flags) {
      lines.push(`- ${flag}`);
    }
    lines.push('');
  }

  lines.push(
    `END OF SCRIPT -- every question above (${screener.questions[0]?.id ?? 'Q1'}-${
      screener.questions[screener.questions.length - 1]?.id ?? 'Qn'
    }, plus the opening and closing) must be asked in order unless its own SKIP IF / TERMINATE IF rule says otherwise. Never ask a question not listed above.`
  );

  return lines.join('\n');
}
