'use client';

import { useEffect, useState, FormEvent } from 'react';
import Link from 'next/link';

interface ClientListItem {
  clientId: string;
  name: string;
  contactEmail: string;
  contactPhone: string;
  kbEnabled: boolean;
  kbStatus: 'none' | 'pending' | 'provisioned' | 'error';
}

function statusBadge(client: ClientListItem) {
  if (!client.kbEnabled) return <span className="type-badge">Survey only</span>;
  if (client.kbStatus === 'provisioned') return <span className="type-badge">KB provisioned</span>;
  if (client.kbStatus === 'error') return <span className="badge-danger">KB error</span>;
  return <span className="type-badge">KB pending</span>;
}

export default function ClientsPage() {
  const [clients, setClients] = useState<ClientListItem[] | null>(null);
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [kbEnabled, setKbEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function loadClients() {
    fetch('/api/clients')
      .then((res) => res.json())
      .then((body) => setClients(body.clients ?? []))
      .catch(() => setClients([]));
  }

  useEffect(() => {
    loadClients();
  }, []);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          contact_email: contactEmail.trim(),
          contact_phone: contactPhone.trim(),
          kb_enabled: kbEnabled,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to create client.');
      setName('');
      setContactEmail('');
      setContactPhone('');
      setKbEnabled(false);
      loadClients();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create client.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="row">
        <h2 style={{ fontSize: 18, margin: 0 }}>Clients</h2>
        <Link href="/" className="btn">
          &larr; Back to surveys
        </Link>
      </div>

      <form className="card stack" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="clientName">Client name</label>
          <input
            id="clientName"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Acme Dental"
            disabled={saving}
            required
          />
        </div>

        <div>
          <label htmlFor="contactEmail">Contact email</label>
          <input
            id="contactEmail"
            type="text"
            value={contactEmail}
            onChange={(e) => setContactEmail(e.target.value)}
            placeholder="e.g. ops@acmedental.com"
            disabled={saving}
          />
        </div>

        <div>
          <label htmlFor="contactPhone">Contact phone</label>
          <input
            id="contactPhone"
            type="text"
            value={contactPhone}
            onChange={(e) => setContactPhone(e.target.value)}
            placeholder="e.g. +1 555 010 0000"
            disabled={saving}
          />
        </div>

        <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
          <input
            id="kbEnabled"
            type="checkbox"
            checked={kbEnabled}
            onChange={(e) => setKbEnabled(e.target.checked)}
            disabled={saving}
            style={{ width: 16, height: 16 }}
          />
          <label htmlFor="kbEnabled" style={{ margin: 0, fontWeight: 400, color: 'var(--text-primary)' }}>
            Create a knowledge base for this client
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '-8px 0 0' }}>
          Leave this off for clients who only need surveys run through Dograh -- no Cognee memory
          gets set up. You can turn it on for an existing client later too.
        </p>

        {error && <p className="error-text">{error}</p>}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="submit" className="btn btn-primary" disabled={saving || !name.trim()}>
            {saving ? 'Saving…' : 'Create client'}
          </button>
        </div>
      </form>

      <div className="stack">
        {clients === null ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading…</p>
        ) : clients.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            No clients yet -- create the first one above.
          </p>
        ) : (
          <div className="stack" style={{ gap: 8 }}>
            {clients.map((c) => (
              <Link
                key={c.clientId}
                href={`/clients/${c.clientId}`}
                className="question-item row"
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                    {c.contactEmail || 'no contact email'} · {c.contactPhone || 'no phone'}
                  </div>
                </div>
                <div className="row" style={{ width: 'auto' }}>
                  {statusBadge(c)}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
