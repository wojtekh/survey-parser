'use client';

import { useEffect, useState, FormEvent } from 'react';

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

export default function Home() {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<'idle' | 'parsing' | 'error' | 'done'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ParsedResult | null>(null);
  const [view, setView] = useState<'list' | 'json'>('list');
  const [copied, setCopied] = useState(false);
  const [pushState, setPushState] = useState<'idle' | 'pushing' | 'pushed' | 'error'>('idle');
  const [pushError, setPushError] = useState<string | null>(null);
  const [pushedUrl, setPushedUrl] = useState<string | null>(null);
  const [pushedId, setPushedId] = useState<string | null>(null);
  const [surveys, setSurveys] = useState<SurveyIndexEntry[] | null>(null);

  function loadSurveys() {
    fetch('/api/surveys')
      .then((res) => res.json())
      .then((body) => setSurveys(body.surveys ?? []))
      .catch(() => setSurveys([]));
  }

  useEffect(() => {
    loadSurveys();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;

    setStatus('parsing');
    setError(null);
    setResult(null);
    setPushState('idle');
    setPushedUrl(null);
    setPushedId(null);

    const formData = new FormData();
    formData.append('file', file);
    formData.append('name', name.trim());

    try {
      const res = await fetch('/api/parse', { method: 'POST', body: formData });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Something went wrong.');
      setResult(body.result);
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setStatus('error');
    }
  }

  async function pushToSheet() {
    if (!result) return;
    setPushState('pushing');
    setPushError(null);

    try {
      const res = await fetch('/api/sheets/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ questions: result.questions, name: result.title }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to push to Google Sheet.');
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
            .docx, .pdf, .txt, or .md. Tables in .docx are read as rating questions where
            appropriate.
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
                onClick={pushToSheet}
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
            <div className="flags-panel" style={{ borderColor: '#a8d8b0', background: '#f0faf1' }}>
              <h3 style={{ color: '#1f8a3f' }}>Survey created</h3>
              <p style={{ margin: '0 0 8px', fontSize: 13 }}>
                <a href={pushedUrl} target="_blank" rel="noreferrer">
                  {pushedUrl}
                </a>
              </p>
              <p style={{ margin: 0, fontSize: 12, color: 'var(--text-secondary)' }}>
                Pass <code>spreadsheet_id={pushedId}</code> as this survey&apos;s{' '}
                <code>initial_context</code> value when triggering a Dograh call for it.
              </p>
            </div>
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

      <div className="stack">
        <h2 style={{ fontSize: 16, margin: 0 }}>Past surveys</h2>
        {surveys === null ? (
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
                <a href={s.url} target="_blank" rel="noreferrer" className="btn">
                  Open sheet
                </a>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
