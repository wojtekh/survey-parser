'use client';

import { useEffect, useState } from 'react';

type Tab = 'new' | 'link' | 'inbound';

export interface SurveyEntry {
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

/**
 * "+ Add survey" on a client's Survey card. Three tabs onto what used to be
 * three separate top-level pages (New parse / Surveys / Inbound numbers) --
 * all scoped to this client now. See app/RailNav.tsx for why those pages
 * left the global nav.
 */
export default function AddSurveyModal({
  clientId,
  clientName,
  linkedSurveys,
  onClose,
  onChanged,
}: {
  clientId: string;
  clientName: string;
  linkedSurveys: SurveyEntry[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<Tab>('new');

  function done() {
    onChanged();
    onClose();
  }

  return (
    <div className="cw-modal-backdrop" onClick={onClose}>
      <div className="cw-modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ alignItems: 'flex-start' }}>
          <div>
            <h3 style={{ margin: 0 }}>Add a survey</h3>
            <div style={{ fontSize: 13, color: 'var(--cw-text-tertiary)', marginTop: 2 }}>{clientName}</div>
          </div>
          <button className="cw-icon-btn" onClick={onClose} type="button">
            ✕
          </button>
        </div>

        <div className="tabs" style={{ marginTop: 16 }}>
          <button type="button" className={`tab${tab === 'new' ? ' active' : ''}`} onClick={() => setTab('new')}>
            New parse
          </button>
          <button type="button" className={`tab${tab === 'link' ? ' active' : ''}`} onClick={() => setTab('link')}>
            Link existing
          </button>
          <button type="button" className={`tab${tab === 'inbound' ? ' active' : ''}`} onClick={() => setTab('inbound')}>
            Inbound numbers
          </button>
        </div>

        {tab === 'new' && <NewParseTab clientId={clientId} onDone={done} />}
        {tab === 'link' && <LinkExistingTab clientId={clientId} onDone={done} />}
        {tab === 'inbound' && <InboundNumbersTab linkedSurveys={linkedSurveys} />}
      </div>
    </div>
  );
}

function NewParseTab({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'simple' | 'screener'>('simple');
  const [file, setFile] = useState<File | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [parsed, setParsed] = useState<{ title: string; questions: string[]; screener?: unknown } | null>(null);
  const [pushing, setPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  async function parseDocument() {
    if (!file) return;
    setParsing(true);
    setParseError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('name', name || file.name);
      form.append('type', type);
      const res = await fetch('/api/parse', { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to parse document.');

      if (body.surveyType === 'screener') {
        const s = body.result as { title: string; questions: { text: string }[] };
        setParsed({ title: s.title, questions: s.questions.map((q) => q.text), screener: s });
      } else {
        const s = body.result as { title: string; questions: string[] };
        setParsed({ title: s.title, questions: s.questions });
      }
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Failed to parse document.');
    } finally {
      setParsing(false);
    }
  }

  async function pushAndLink() {
    if (!parsed) return;
    setPushing(true);
    setPushError(null);
    try {
      const res = await fetch('/api/sheets/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questions: parsed.questions,
          name: name || parsed.title,
          screener: parsed.screener,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to create the survey sheet.');

      const linkRes = await fetch(`/api/clients/${clientId}/surveys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheet_id: body.spreadsheetId }),
      });
      const linkBody = await linkRes.json();
      if (!linkRes.ok) throw new Error(linkBody.error ?? 'Survey created but could not be linked to this client.');

      onDone();
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'Failed to create the survey sheet.');
    } finally {
      setPushing(false);
    }
  }

  if (parsed) {
    return (
      <div className="stack">
        <div className="cw-section-title">
          {parsed.title} <span className="count">{parsed.questions.length} questions</span>
        </div>
        <div style={{ maxHeight: 220, overflowY: 'auto', border: '1px solid var(--cw-border)', borderRadius: 8, padding: '4px 12px' }}>
          {parsed.questions.map((q, i) => (
            <div key={i} className="cw-doc-row">
              <span className="cw-doc-name">{q}</span>
            </div>
          ))}
        </div>
        {pushError && <p className="error-text">{pushError}</p>}
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="cw-btn" onClick={() => setParsed(null)} disabled={pushing}>
            Back
          </button>
          <button type="button" className="cw-btn cw-btn-primary" onClick={pushAndLink} disabled={pushing}>
            {pushing ? 'Creating…' : 'Push & link'}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="stack">
      <div>
        <label>Survey name</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Fee dispute questionnaire"
          disabled={parsing}
        />
      </div>
      <div>
        <label>Type</label>
        <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
          <button
            type="button"
            className={`cw-btn${type === 'simple' ? ' cw-btn-primary' : ''}`}
            onClick={() => setType('simple')}
            disabled={parsing}
          >
            Simple
          </button>
          <button
            type="button"
            className={`cw-btn${type === 'screener' ? ' cw-btn-primary' : ''}`}
            onClick={() => setType('screener')}
            disabled={parsing}
          >
            Screener
          </button>
        </div>
      </div>
      <div>
        <label>Document</label>
        <input type="file" accept=".pdf,.docx,.txt" onChange={(e) => setFile(e.target.files?.[0] ?? null)} disabled={parsing} />
      </div>
      {parseError && <p className="error-text">{parseError}</p>}
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="cw-btn cw-btn-primary" onClick={parseDocument} disabled={!file || parsing}>
          {parsing ? 'Parsing…' : 'Parse document'}
        </button>
      </div>
    </div>
  );
}

function LinkExistingTab({ clientId, onDone }: { clientId: string; onDone: () => void }) {
  const [available, setAvailable] = useState<SurveyEntry[] | null>(null);
  const [selected, setSelected] = useState('');
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/clients/${clientId}/surveys`)
      .then((res) => res.json())
      .then((body) => setAvailable(body.available ?? []))
      .catch(() => setAvailable([]));
  }, [clientId]);

  async function link() {
    if (!selected) return;
    setLinking(true);
    setError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/surveys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheet_id: selected }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to link survey.');
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to link survey.');
    } finally {
      setLinking(false);
    }
  }

  if (available === null) {
    return <p style={{ fontSize: 13, color: 'var(--cw-text-tertiary)' }}>Loading…</p>;
  }
  if (available.length === 0) {
    return (
      <p style={{ fontSize: 13, color: 'var(--cw-text-tertiary)' }}>
        No unlinked surveys -- every existing survey is already linked to a client, or none exist yet.
      </p>
    );
  }

  return (
    <div className="stack">
      {error && <p className="error-text">{error}</p>}
      <div className="row" style={{ gap: 8 }}>
        <select value={selected} onChange={(e) => setSelected(e.target.value)} style={{ flex: 1 }} disabled={linking}>
          <option value="">Pick a survey…</option>
          {available.map((s) => (
            <option key={s.spreadsheetId} value={s.spreadsheetId}>
              {s.name}
            </option>
          ))}
        </select>
        <button type="button" className="cw-btn cw-btn-primary" onClick={link} disabled={!selected || linking}>
          {linking ? 'Linking…' : 'Link'}
        </button>
      </div>
    </div>
  );
}

function InboundNumbersTab({ linkedSurveys }: { linkedSurveys: SurveyEntry[] }) {
  const [mappings, setMappings] = useState<InboundMapping[] | null>(null);
  const [phone, setPhone] = useState('');
  const [surveyId, setSurveyId] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    fetch('/api/inbound-numbers')
      .then((res) => res.json())
      .then((body) => setMappings(body.mappings ?? []))
      .catch(() => setMappings([]));
  }

  useEffect(load, []);

  const linkedIds = new Set(linkedSurveys.map((s) => s.spreadsheetId));
  const rows = (mappings ?? []).filter((m) => linkedIds.has(m.spreadsheetId));

  function surveyName(id: string): string {
    return linkedSurveys.find((s) => s.spreadsheetId === id)?.name ?? id;
  }

  async function assign() {
    if (!phone.trim() || !surveyId) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/inbound-numbers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone_number: phone.trim(), spreadsheet_id: surveyId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to assign number.');
      setPhone('');
      setSurveyId('');
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to assign number.');
    } finally {
      setSaving(false);
    }
  }

  async function unassign(phoneNumber: string) {
    try {
      await fetch(`/api/inbound-numbers/${encodeURIComponent(phoneNumber)}`, { method: 'DELETE' });
      load();
    } catch {
      setError('Failed to remove that number.');
    }
  }

  if (linkedSurveys.length === 0) {
    return (
      <p style={{ fontSize: 13, color: 'var(--cw-text-tertiary)' }}>
        Link a survey first -- inbound numbers route to one of this client's surveys.
      </p>
    );
  }

  return (
    <div className="stack">
      {mappings === null ? (
        <p style={{ fontSize: 13, color: 'var(--cw-text-tertiary)' }}>Loading…</p>
      ) : rows.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--cw-text-tertiary)' }}>No numbers routed to this client's surveys yet.</p>
      ) : (
        rows.map((m) => (
          <div key={m.phoneNumber} className="cw-doc-row">
            <span className="cw-doc-name">
              {m.phoneNumber} &rarr; {surveyName(m.spreadsheetId)}
            </span>
            <button className="cw-icon-btn" onClick={() => unassign(m.phoneNumber)} type="button">
              ✕
            </button>
          </div>
        ))
      )}

      {error && <p className="error-text">{error}</p>}

      <div className="row" style={{ gap: 8 }}>
        <input
          type="text"
          placeholder="+1 555 010 0000"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          disabled={saving}
        />
        <select value={surveyId} onChange={(e) => setSurveyId(e.target.value)} disabled={saving} style={{ flex: 1 }}>
          <option value="">Survey…</option>
          {linkedSurveys.map((s) => (
            <option key={s.spreadsheetId} value={s.spreadsheetId}>
              {s.name}
            </option>
          ))}
        </select>
        <button type="button" className="cw-btn cw-btn-primary" onClick={assign} disabled={saving || !phone.trim() || !surveyId}>
          {saving ? 'Assigning…' : 'Assign'}
        </button>
      </div>
    </div>
  );
}
