'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

interface ServiceRow {
  enabled: boolean;
  status: 'none' | 'pending' | 'provisioned' | 'error';
}

interface ClientListItem {
  clientId: string;
  name: string;
  contactEmail: string;
  contactPhone: string;
  kbEnabled: boolean;
  kbStatus: 'none' | 'pending' | 'provisioned' | 'error';
  agents: { name: string }[];
  services: Record<string, ServiceRow>;
}

function monogram(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

type ChipState = 'none' | 'pending' | 'success' | 'alert';

function chipClass(state: ChipState): string {
  if (state === 'success') return 'cw-badge cw-badge-success';
  if (state === 'alert') return 'cw-badge cw-badge-alert';
  if (state === 'pending') return 'cw-badge cw-badge-info';
  return 'cw-badge';
}

function kbChipState(client: ClientListItem): ChipState {
  if (!client.kbEnabled) return 'none';
  if (client.kbStatus === 'provisioned') return 'success';
  if (client.kbStatus === 'error') return 'alert';
  return 'pending';
}

function surveyChipState(client: ClientListItem): ChipState {
  const survey = client.services?.survey;
  if (!survey?.enabled) return 'none';
  return survey.status === 'provisioned' ? 'success' : 'pending';
}

function agentChipState(client: ClientListItem): ChipState {
  return client.agents.length > 0 ? 'success' : 'none';
}

export default function ClientsDashboardPage() {
  const [clients, setClients] = useState<ClientListItem[] | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    fetch('/api/clients')
      .then((res) => res.json())
      .then((body) => setClients(body.clients ?? []))
      .catch(() => setClients([]));
  }, []);

  const filtered = (clients ?? []).filter((c) =>
    c.name.toLowerCase().includes(query.trim().toLowerCase())
  );

  return (
    <>
      <div className="cw-header">
        <div style={{ flex: 1 }}>
          <h1 className="cw-header-title">Clients</h1>
          <div className="cw-header-sub">
            {clients === null ? 'Loading…' : `${clients.length} account${clients.length === 1 ? '' : 's'}`}
          </div>
        </div>
        <input
          type="text"
          placeholder="Search clients"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ width: 260 }}
        />
        <Link href="/clients/new" className="cw-btn cw-btn-primary">
          + Add a client
        </Link>
      </div>

      {clients === null ? (
        <p style={{ fontSize: 13, color: 'var(--cw-text-tertiary)' }}>Loading…</p>
      ) : filtered.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--cw-text-tertiary)' }}>
          {clients.length === 0 ? 'No clients yet.' : 'No matches.'}
        </p>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 20 }}>
          {filtered.map((c) => (
            <Link
              key={c.clientId}
              href={`/clients/${c.clientId}`}
              className="cw-card"
              style={{ display: 'flex', flexDirection: 'column', gap: 16, textDecoration: 'none' }}
            >
              <div className="row" style={{ justifyContent: 'flex-start', gap: 12 }}>
                <div className="cw-header-avatar">{monogram(c.name)}</div>
                <div style={{ minWidth: 0 }}>
                  <div style={{ font: '600 15px var(--font-sans)', color: 'var(--cw-text-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.name}
                  </div>
                  <div style={{ font: '400 12px var(--font-sans)', color: 'var(--cw-text-tertiary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.contactEmail || 'no contact email'}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                <span className={chipClass(kbChipState(c))}>Knowledge base</span>
                <span className={chipClass(surveyChipState(c))}>Survey</span>
                <span className={chipClass(agentChipState(c))}>Voice agent</span>
                <span className="cw-badge" style={{ background: 'var(--cw-surface)', color: 'var(--cw-text-tertiary)', border: '1px dashed var(--border-input)' }}>
                  AI services
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}
