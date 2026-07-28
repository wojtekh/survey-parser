'use client';

import { useState, FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { notifyClientsChanged } from './layout';

export default function ClientsIndexPage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [kbEnabled, setKbEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      notifyClientsChanged();
      router.push(`/clients/${body.client.clientId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create client.');
      setSaving(false);
    }
  }

  return (
    <>
      <div className="cw-header">
        <div style={{ flex: 1 }}>
          <h1 className="cw-header-title">Add a client</h1>
          <div className="cw-header-sub">
            Pick a client from the left, or create a new one here.
          </div>
        </div>
      </div>

      <form className="cw-card stack" onSubmit={handleSubmit} style={{ maxWidth: 480 }}>
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
          <label htmlFor="kbEnabled" style={{ margin: 0, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: 'var(--cw-text-body)' }}>
            Create a knowledge base for this client
          </label>
        </div>
        <p style={{ fontSize: 12, color: 'var(--cw-text-tertiary)', margin: '-8px 0 0' }}>
          Leave this off for clients who only need surveys run through Dograh -- no Cognee memory
          gets set up. You can turn it on for an existing client later too.
        </p>

        {error && <p className="error-text">{error}</p>}

        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="submit" className="cw-btn cw-btn-primary" disabled={saving || !name.trim()}>
            {saving ? 'Creating…' : 'Create client'}
          </button>
        </div>
      </form>
    </>
  );
}
