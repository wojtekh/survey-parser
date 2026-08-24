'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { ParsedScreener, ScreenerQuestion, ScreenerOpening } from '@/lib/generateScreener';
import { renderScreenerScript } from '@/lib/renderScreenerScript';
import { MAX_UPLOAD_BYTES, formatBytes } from '@/lib/limits';

/**
 * Read a JSON API response, or throw a message a human can act on.
 *
 * Every handler below used to call res.json() BEFORE checking res.ok. That
 * works while the server answers in JSON. It breaks the moment something
 * upstream answers with an HTML error page instead -- a proxy timeout, a
 * crashed container, a 413 from a reverse proxy. res.json() then throws
 * first, and the user reads "Unexpected token '<'" instead of what went
 * wrong. So: read the body as text, check the status, and only then try to
 * parse it.
 */
async function readJson(res: Response, fallback: string): Promise<any> {
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON. An HTML error page, or an empty body. Handled below.
  }

  if (!res.ok) {
    if (typeof body?.error === 'string') throw new Error(body.error);
    if (res.status === 408 || res.status === 504) {
      throw new Error('The server took too long and timed out. Try a smaller document.');
    }
    if (res.status === 413) {
      throw new Error('That upload is too large for the server to accept.');
    }
    throw new Error(`${fallback} (HTTP ${res.status})`);
  }

  if (body === null) {
    throw new Error(`${fallback} The server sent a response this page could not read.`);
  }
  return body;
}

/**
 * The "Survey created" box, shared by the simple and screener results.
 *
 * The spreadsheet id is the one thing you have to carry out of this screen by
 * hand -- it goes into a Dograh preset parameter. It used to sit mid-sentence
 * inside a paragraph of explanation, which made it fiddly to select and easy
 * to lose. Now it leads, in its own field, with a copy button. The prose sits
 * underneath and says only what the id is for.
 */
function SurveyCreatedPanel({
  url,
  spreadsheetId,
  note,
}: {
  url: string;
  spreadsheetId: string | null;
  note: ReactNode;
}) {
  const [idCopied, setIdCopied] = useState(false);

  function copyId() {
    if (!spreadsheetId) return;
    navigator.clipboard.writeText(spreadsheetId);
    setIdCopied(true);
    setTimeout(() => setIdCopied(false), 1500);
  }

  return (
    <div className="flags-panel" style={{ borderColor: '#a8d8b0', background: '#f0faf1' }}>
      <h3 style={{ color: '#1f8a3f' }}>Survey created</h3>

      {spreadsheetId && (
        <>
          <div
            style={{
              fontSize: 11,
              textTransform: 'uppercase',
              letterSpacing: '0.04em',
              color: 'var(--text-secondary)',
              marginBottom: 4,
            }}
          >
            spreadsheet_id
          </div>
          <div className="row" style={{ gap: 8, alignItems: 'center', marginBottom: 10 }}>
            <code
              style={{
                flex: 1,
                fontSize: 14,
                padding: '8px 10px',
                background: '#fff',
                border: '1px solid #a8d8b0',
                borderRadius: 6,
                wordBreak: 'break-all',
                // Select the whole id on a single click -- it's one opaque
                // token, so a partial selection is never what anyone wants.
                userSelect: 'all',
              }}
            >
              {spreadsheetId}
            </code>
            <button className="btn" onClick={copyId} style={{ whiteSpace: 'nowrap' }}>
              {idCopied ? 'Copied!' : 'Copy ID'}
            </button>
          </div>
        </>
      )}

      <p style={{ margin: '0 0 8px', fontSize: 13 }}>
        <a href={url} target="_blank" rel="noreferrer">
          Open the sheet
        </a>
      </p>

      <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>{note}</p>
    </div>
  );
}

type SurveyType = 'simple' | 'screener';

interface ParsedResult {
  title: string;
  questions: string[];
  flags: string[];
}

interface SurveyIndexEntry {
  spreadsheetId: string;
  name: string;
  url: string;
  createdAt: string;
}

interface InboundMapping {
  phoneNumber: string;
  spreadsheetId: string;
  updatedAt: string;
}

export default function Home() {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [surveyType, setSurveyType] = useState<SurveyType>('simple');
  const [status, setStatus] = useState<'idle' | 'parsing' | 'error' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);

  // Simple-survey result state (unchanged behavior).
  const [result, setResult] = useState<ParsedResult | null>(null);
  const [view, setView] = useState<'list' | 'json'>('list');
  const [copied, setCopied] = useState(false);

  // Screener result state (editable).
  const [screener, setScreener] = useState<ParsedScreener | null>(null);
  const [scriptCopied, setScriptCopied] = useState(false);

  const [pushState, setPushState] = useState<'idle' | 'pushing' | 'pushed' | 'error'>('idle');
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushedUrl, setPushedUrl] = useState<string | null>(null);
  const [pushedId, setPushedId] = useState<string | null>(null);
  const [surveys, setSurveys] = useState<SurveyIndexEntry[] | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  // Set when the survey list itself fails to load. Kept separate from
  // deleteError so a failed LOAD can never be mistaken for an empty list --
  // that confusion is the whole bug this replaces.
  const [surveysError, setSurveysError] = useState<string | null>(null);

  // Inbound number -> survey mappings ("one number, reassigned per
  // survey" -- and now, since Dograh's inbound tools resolve spreadsheet_id
  // from phone_number server-side, reassigning is purely an edit here, no
  // Dograh tool config ever needs touching).
  const [inboundMappings, setInboundMappings] = useState<InboundMapping[] | null>(null);
  const [newNumber, setNewNumber] = useState('');
  const [newNumberSurveyId, setNewNumberSurveyId] = useState('');
  const [savingNumber, setSavingNumber] = useState<string | null>(null); // phoneNumber being saved/removed
  const [inboundError, setInboundError] = useState<string | null>(null);
  /** Same idea as surveysError, for the inbound-number list. */
  const [inboundLoadError, setInboundLoadError] = useState<string | null>(null);

  // Both loaders used to end in `.catch(() => [])`, which rendered a failed
  // load as an empty list -- indistinguishable from "you have none yet".
  // A load that fails now says so.
  async function loadInboundMappings() {
    try {
      const res = await fetch('/api/inbound-numbers');
      const body = await readJson(res, 'Could not load the inbound numbers.');
      setInboundMappings(body.mappings ?? []);
      setInboundLoadError(null);
    } catch (err) {
      setInboundMappings([]);
      setInboundLoadError(
        err instanceof Error ? err.message : 'Could not load the inbound numbers.'
      );
    }
  }

  async function saveInboundMapping(phoneNumber: string, spreadsheetId: string) {
    if (!phoneNumber.trim() || !spreadsheetId) return;
    setSavingNumber(phoneNumber);
    setInboundError(null);
    try {
      const res = await fetch('/api/inbound-numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phoneNumber.trim(), spreadsheet_id: spreadsheetId }),
      });
      await readJson(res, 'Failed to save mapping.');
      loadInboundMappings();
      setNewNumber('');
      setNewNumberSurveyId('');
    } catch (err) {
      setInboundError(err instanceof Error ? err.message : 'Failed to save mapping.');
    } finally {
      setSavingNumber(null);
    }
  }

  async function removeInboundNumber(phoneNumber: string) {
    if (!window.confirm(`Unmap ${phoneNumber}? Inbound calls to this number will fail until it's reassigned.`)) {
      return;
    }
    setSavingNumber(phoneNumber);
    setInboundError(null);
    try {
      const res = await fetch(`/api/inbound-numbers/${encodeURIComponent(phoneNumber)}`, {
        method: 'DELETE',
      });
      await readJson(res, 'Failed to remove mapping.');
      setInboundMappings((prev) => (prev ? prev.filter((m) => m.phoneNumber !== phoneNumber) : prev));
    } catch (err) {
      setInboundError(err instanceof Error ? err.message : 'Failed to remove mapping.');
    } finally {
      setSavingNumber(null);
    }
  }

  async function deleteSurvey(spreadsheetId: string, name: string) {
    if (
      !window.confirm(
        `Delete "${name}"? This removes it from the list and moves its Google Sheet to Trash.`
      )
    ) {
      return;
    }

    setDeletingId(spreadsheetId);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/surveys/${encodeURIComponent(spreadsheetId)}`, {
        method: 'DELETE',
      });
      await readJson(res, 'Failed to delete survey.');
      setSurveys((prev) => (prev ? prev.filter((s) => s.spreadsheetId !== spreadsheetId) : prev));
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete survey.');
    } finally {
      setDeletingId(null);
    }
  }

  async function loadSurveys() {
    try {
      const res = await fetch('/api/surveys');
      const body = await readJson(res, 'Could not load your surveys.');
      setSurveys(body.surveys ?? []);
      setSurveysError(null);
    } catch (err) {
      setSurveys([]);
      setSurveysError(err instanceof Error ? err.message : 'Could not load your surveys.');
    }
  }

  useEffect(() => {
    loadSurveys();
    loadInboundMappings();
  }, []);

  function resetResults() {
    setResult(null);
    setScreener(null);
    setPushState('idle');
    setPushedUrl(null);
    setPushedId(null);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;

    // Fail fast, so an oversized file doesn't cost a long upload first.
    // The server enforces the same limit again on arrival -- that check is
    // the real one, this is only a courtesy.
    if (file.size > MAX_UPLOAD_BYTES) {
      setError(
        `"${file.name}" is ${formatBytes(file.size)}. The limit is ${formatBytes(
          MAX_UPLOAD_BYTES
        )}. Choose a smaller document, or split it.`
      );
      setStatus('error');
      return;
    }

    setStatus('parsing');
    setError(null);
    resetResults();

    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', name.trim());
    formData.append('type', surveyType);

    try {
      const res = await fetch('/api/parse', { method: 'POST', body: formData });
      const body = await readJson(res, 'Could not parse that document.');
      if (body.surveyType === 'screener') {
        setScreener(body.result as ParsedScreener);
      } else {
        setResult(body.result as ParsedResult);
      }
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setStatus('error');
    }
  }

  async function pushQuestionsToSheet(
    title: string,
    questions: string[],
    screenerToPersist?: ParsedScreener
  ) {
    setPushState('pushing');
    setPushError(null);

    try {
      const res = await fetch('/api/sheets/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questions,
          name: title,
          ...(screenerToPersist ? { screener: screenerToPersist } : {}),
        }),
      });
      const body = await readJson(res, 'Failed to push to Google Sheet.');
      setPushState('pushed');
      setPushedUrl(body.url);
      setPushedId(body.spreadsheetId);
      loadSurveys();
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Failed to push to Google Sheet.');
      setPushState('error');
    }
  }

  function copyJson() {
    if (!result) return;
    navigator.clipboard.writeText(JSON.stringify(result, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  // --- Screener editing helpers -------------------------------------------

  function updateQuestion(id: string, patch: Partial<ScreenerQuestion>) {
    setScreener((prev) =>
      prev
        ? { ...prev, questions: prev.questions.map((q) => (q.id === id ? { ...q, ...patch } : q)) }
        : prev
    );
  }

  function resolveFlag(id: string) {
    updateQuestion(id, { needs_review: false });
  }

  function updateOpening(index: number, patch: Partial<ScreenerOpening>) {
    setScreener((prev) =>
      prev
        ? {
            ...prev,
            openings: prev.openings.map((o, i) => (i === index ? { ...o, ...patch } : o)),
          }
        : prev
    );
  }

  function updateClosing(patch: Partial<ParsedScreener['closing']>) {
    setScreener((prev) => (prev ? { ...prev, closing: { ...prev.closing, ...patch } } : prev));
  }

  function copyScript() {
    if (!screener) return;
    navigator.clipboard.writeText(renderScreenerScript(screener));
    setScriptCopied(true);
    setTimeout(() => setScriptCopied(false), 1500);
  }

  function downloadScript() {
    if (!screener) return;
    const blob = new Blob([renderScreenerScript(screener)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${screener.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-script.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const unresolvedCount = screener ? screener.questions.filter((q) => q.needs_review).length : 0;

  return (
    <>
      <form className="card stack" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="name">Survey name (optional)</label>
          <input
            id="name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Panel Engagement & Interest Survey"
            disabled={status === 'parsing'}
          />
        </div>

        <div>
          <label htmlFor="surveyType">Survey type</label>
          <select
            id="surveyType"
            value={surveyType}
            onChange={(e) => setSurveyType(e.target.value as SurveyType)}
            disabled={status === 'parsing'}
          >
            <option value="simple">Simple survey (flat, linear questions)</option>
            <option value="screener">Recruitment / qualifier screener (skip & termination logic)</option>
          </select>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
            {surveyType === 'simple'
              ? 'Every question is asked in order, no branching. Good for satisfaction surveys, feedback forms, NPS.'
              : 'For moderator guides / recruiting scripts with real skip and disqualification logic. Produces an editable, numbered checklist instead of a flat list.'}
          </p>
        </div>

        <div>
          <label htmlFor="file">Source document</label>
          <input
            id="file"
            type="file"
            accept=".docx,.pdf,.txt,.md"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            disabled={status === 'parsing'}
            required
          />
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 6 }}>
            .docx, .pdf, .txt, or .md, up to {formatBytes(MAX_UPLOAD_BYTES)}. Tables in .docx
            are read as rating questions where appropriate.
          </p>
        </div>

        {error && <p className="error-text">{error}</p>}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="submit" className="btn btn-primary" disabled={status === 'parsing' || !file}>
            {status === 'parsing' ? 'Parsing…' : 'Parse document'}
          </button>
        </div>
      </form>

      {result && (
        <div className="stack">
          <div className="row">
            <h2 style={{ fontSize: 18, margin: 0 }}>
              {result.title} · {result.questions.length} question
              {result.questions.length === 1 ? '' : 's'}
            </h2>
            <div className="row" style={{ gap: 8, width: 'auto' }}>
              <button className="btn" onClick={copyJson}>
                {copied ? 'Copied!' : 'Copy JSON'}
              </button>
              <button
                className="btn btn-primary"
                onClick={() => pushQuestionsToSheet(result.title, result.questions)}
                disabled={pushState === 'pushing'}
              >
                {pushState === 'pushing'
                  ? 'Creating sheet…'
                  : pushState === 'pushed'
                    ? 'Pushed ✓'
                    : 'Push to new Google Sheet'}
              </button>
            </div>
          </div>

          {pushError && <p className="error-text">{pushError}</p>}

          {pushedUrl && (
            <SurveyCreatedPanel
              url={pushedUrl}
              spreadsheetId={pushedId}
              note={
                <>
                  Pass this as the survey&apos;s <code>initial_context</code> value when
                  triggering a Dograh call for it.
                </>
              }
            />
          )}

          {result.flags.length > 0 && (
            <div className="flags-panel">
              <h3>Flagged for review ({result.flags.length})</h3>
              <ul>
                {result.flags.map((flag, i) => (
                  <li key={i}>{flag}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="tabs">
            <div className={`tab ${view === 'list' ? 'active' : ''}`} onClick={() => setView('list')}>
              Question list
            </div>
            <div className={`tab ${view === 'json' ? 'active' : ''}`} onClick={() => setView('json')}>
              Raw JSON
            </div>
          </div>

          {view === 'list' ? (
            <div>
              {result.questions.map((q, i) => (
                <div key={i} className="question-item">
                  <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
                    <span className="type-badge">{i + 1}</span>
                  </div>
                  <div className="question-text" style={{ marginTop: 6 }}>
                    {q}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <pre className="json-view">{JSON.stringify(result, null, 2)}</pre>
          )}
        </div>
      )}

      {screener && (
        <div className="stack">
          <div className="row">
            <h2 style={{ fontSize: 18, margin: 0 }}>
              {screener.title} · {screener.questions.length} question
              {screener.questions.length === 1 ? '' : 's'}
            </h2>
            {unresolvedCount > 0 && (
              <span className="badge-danger">{unresolvedCount} flagged</span>
            )}
          </div>

          {unresolvedCount > 0 && (
            <div className="flags-panel">
              <h3>Resolve flagged questions before exporting</h3>
              <p style={{ margin: 0, fontSize: 13 }}>
                {unresolvedCount} question{unresolvedCount === 1 ? '' : 's'} below need a quick
                look -- extraction wasn&apos;t fully confident about them. Edit the field(s) in
                question, then click &quot;Mark resolved&quot; on that question.
              </p>
            </div>
          )}

          {screener.flags.length > 0 && (
            <div className="flags-panel">
              <h3>Document-level flags ({screener.flags.length})</h3>
              <ul>
                {screener.flags.map((flag, i) => (
                  <li key={i}>{flag}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="card stack">
            <h3 style={{ fontSize: 14, margin: 0 }}>Opening{screener.openings.length > 1 ? 's' : ''}</h3>
            {screener.openings.map((opening, i) => (
              <div key={i} className="stack" style={{ gap: 8 }}>
                <span className="type-badge" style={{ width: 'fit-content' }}>
                  {opening.condition}
                </span>
                <div className="field-group">
                  <label className="field-label">Script</label>
                  <textarea
                    rows={3}
                    value={opening.script}
                    onChange={(e) => updateOpening(i, { script: e.target.value })}
                  />
                </div>
                <div className="field-group">
                  <label className="field-label">If caller declines here</label>
                  <textarea
                    rows={2}
                    value={opening.decline_response}
                    onChange={(e) => updateOpening(i, { decline_response: e.target.value })}
                  />
                </div>
              </div>
            ))}
          </div>

          <div className="stack" style={{ gap: 10 }}>
            {screener.questions.map((q) => (
              <div
                key={q.id}
                className={`screener-question ${q.needs_review ? 'needs-review' : ''}`}
              >
                <div className="row" style={{ alignItems: 'flex-start' }}>
                  <span className="type-badge">{q.id}</span>
                  {q.needs_review && <span className="badge-danger">Needs review</span>}
                </div>

                <div className="field-group">
                  <label className="field-label">Question</label>
                  <textarea
                    rows={2}
                    value={q.text}
                    onChange={(e) => updateQuestion(q.id, { text: e.target.value })}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label">Skip if</label>
                  <textarea
                    rows={1}
                    placeholder="(never skipped)"
                    value={q.skip_if ?? ''}
                    onChange={(e) => updateQuestion(q.id, { skip_if: e.target.value || null })}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label">Terminate if</label>
                  <textarea
                    rows={1}
                    placeholder="(never terminates)"
                    value={q.terminate_if ?? ''}
                    onChange={(e) => updateQuestion(q.id, { terminate_if: e.target.value || null })}
                  />
                </div>

                <div className="field-group">
                  <label className="field-label">Internal note (never spoken)</label>
                  <textarea
                    rows={1}
                    placeholder="(none)"
                    value={q.internal_note ?? ''}
                    onChange={(e) => updateQuestion(q.id, { internal_note: e.target.value || null })}
                  />
                </div>

                {q.needs_review && (
                  <>
                    <div className="review-note">{q.review_note ?? 'Uncertain extraction.'}</div>
                    <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
                      <button className="btn" onClick={() => resolveFlag(q.id)}>
                        Mark resolved
                      </button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>

          <div className="card stack">
            <h3 style={{ fontSize: 14, margin: 0 }}>Closing</h3>
            <div className="field-group">
              <label className="field-label">Invitation script</label>
              <textarea
                rows={3}
                value={screener.closing.invitation_script}
                onChange={(e) => updateClosing({ invitation_script: e.target.value })}
              />
            </div>
            <div className="field-group">
              <label className="field-label">If caller accepts</label>
              <textarea
                rows={2}
                value={screener.closing.accept_response}
                onChange={(e) => updateClosing({ accept_response: e.target.value })}
              />
            </div>
            <div className="field-group">
              <label className="field-label">If caller declines</label>
              <textarea
                rows={2}
                value={screener.closing.decline_response}
                onChange={(e) => updateClosing({ decline_response: e.target.value })}
              />
            </div>
          </div>

          {pushError && <p className="error-text">{pushError}</p>}

          {pushedUrl && (
            <SurveyCreatedPanel
              url={pushedUrl}
              spreadsheetId={pushedId}
              note={
                <>
                  Use this as the <code>get_next_screener_question</code> preset parameter (see
                  dograh/tools-setup.md). The skip and terminate logic lives in the sheet&apos;s{' '}
                  <strong>screener</strong> tab and is resolved server-side. The script below is
                  the agent&apos;s Knowledge Base document.
                </>
              }
            />
          )}

          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button className="btn" onClick={copyScript} disabled={unresolvedCount > 0}>
              {scriptCopied ? 'Copied!' : 'Copy script'}
            </button>
            <button className="btn" onClick={downloadScript} disabled={unresolvedCount > 0}>
              Download .txt
            </button>
            <button
              className="btn btn-primary"
              onClick={() =>
                pushQuestionsToSheet(
                  screener.title,
                  screener.questions.map((q) => q.text),
                  screener
                )
              }
              disabled={unresolvedCount > 0 || pushState === 'pushing'}
            >
              {pushState === 'pushing'
                ? 'Creating sheet…'
                : pushState === 'pushed'
                  ? 'Pushed ✓'
                  : 'Push to new Google Sheet'}
            </button>
          </div>
          {unresolvedCount > 0 && (
            <p style={{ fontSize: 12, color: 'var(--text-secondary)', textAlign: 'right' }}>
              Resolve all flagged questions above to enable export/push.
            </p>
          )}
        </div>
      )}

      <div className="stack">
        <h2 style={{ fontSize: 16, margin: 0 }}>Past surveys</h2>
        {surveysError ? (
          <p className="error-text">{surveysError}</p>
        ) : surveys === null ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading…</p>
        ) : surveys.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            None yet — push a parsed document above to create the first one.
          </p>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {surveys.map((s) => (
              <div key={s.spreadsheetId} className="question-item row">
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{s.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {s.spreadsheetId} · {s.createdAt ? new Date(s.createdAt).toLocaleString() : ''}
                  </div>
                </div>
                <div className="row" style={{ gap: 8, width: 'auto' }}>
                  <a href={s.url} target="_blank" rel="noreferrer" className="btn">
                    Open sheet
                  </a>
                  <button
                    className="btn"
                    style={{ color: 'var(--danger)' }}
                    disabled={deletingId === s.spreadsheetId}
                    onClick={() => deleteSurvey(s.spreadsheetId, s.name)}
                  >
                    {deletingId === s.spreadsheetId ? 'Deleting…' : 'Delete'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        {deleteError && <p className="error-text">{deleteError}</p>}
      </div>

      <div className="stack">
        <h2 style={{ fontSize: 16, margin: 0 }}>Inbound numbers</h2>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: 0 }}>
          Which survey each inbound phone number is currently pointed at. Reassigning a number
          to a new survey is just changing it here -- no Dograh tool config needs touching, as
          long as the inbound tools use <code>phone_number</code> (
          <code>{'{{initial_context.called_number}}'}</code>) as their Preset Parameter instead
          of a literal spreadsheet_id.
        </p>

        {inboundError && <p className="error-text">{inboundError}</p>}

        {inboundLoadError ? (
          <p className="error-text">{inboundLoadError}</p>
        ) : inboundMappings === null ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading…</p>
        ) : inboundMappings.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            No numbers mapped yet -- add one below.
          </p>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {inboundMappings.map((m) => {
              const survey = surveys?.find((s) => s.spreadsheetId === m.spreadsheetId);
              const busy = savingNumber === m.phoneNumber;
              return (
                <div key={m.phoneNumber} className="question-item row">
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 14 }}>{m.phoneNumber}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                      {survey ? survey.name : m.spreadsheetId}
                      {m.updatedAt ? ` · updated ${new Date(m.updatedAt).toLocaleString()}` : ''}
                    </div>
                  </div>
                  <div className="row" style={{ gap: 8, width: 'auto' }}>
                    <select
                      value={m.spreadsheetId}
                      disabled={busy || !surveys}
                      onChange={(e) => saveInboundMapping(m.phoneNumber, e.target.value)}
                      style={{ width: 220 }}
                    >
                      {surveys?.map((s) => (
                        <option key={s.spreadsheetId} value={s.spreadsheetId}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn"
                      style={{ color: 'var(--danger)' }}
                      disabled={busy}
                      onClick={() => removeInboundNumber(m.phoneNumber)}
                    >
                      {busy ? '…' : 'Unmap'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        <div className="card row" style={{ gap: 8 }}>
          <input
            type="text"
            placeholder="Phone number, e.g. +14165551234"
            value={newNumber}
            onChange={(e) => setNewNumber(e.target.value)}
            style={{ flex: 1 }}
          />
          <select
            value={newNumberSurveyId}
            onChange={(e) => setNewNumberSurveyId(e.target.value)}
            style={{ width: 220 }}
          >
            <option value="">Select a survey…</option>
            {surveys?.map((s) => (
              <option key={s.spreadsheetId} value={s.spreadsheetId}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            className="btn btn-primary"
            disabled={!newNumber.trim() || !newNumberSurveyId || savingNumber === newNumber}
            onClick={() => saveInboundMapping(newNumber, newNumberSurveyId)}
          >
            {savingNumber === newNumber ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </>
  );
}
