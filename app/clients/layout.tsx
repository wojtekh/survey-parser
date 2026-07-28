'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

interface ClientListItem {
  clientId: string;
  name: string;
  kbEnabled: boolean;
  kbStatus: 'none' | 'pending' | 'provisioned' | 'error';
}

// Emit this after any create/delete so the rail (which lives in this
// layout, separate from whichever page is mounted) knows to refetch --
// layouts don't remount on navigation within the same segment, so there's
// no other cheap way for a page to tell the rail its list changed.
export function notifyClientsChanged() {
  window.dispatchEvent(new CustomEvent('cw:clients-changed'));
}

function monogram(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export default function ClientsLayout({ children }: { children: React.ReactNode }) {
  const params = useParams();
  const activeClientId = params?.clientId as string | undefined;

  const [clients, setClients] = useState<ClientListItem[] | null>(null);
  const [query, setQuery] = useState('');

  function load() {
    fetch('/api/clients')
      .then((res) => res.json())
      .then((body) => setClients(body.clients ?? []))
      .catch(() => setClients([]));
  }

  useEffect(() => {
    load();
    window.addEventListener('cw:clients-changed', load);
    return () => window.removeEventListener('cw:clients-changed', load);
  }, []);

  const filtered = (clients ?? []).filter((c) =>
    c.name.toLowerCase().includes(query.trim().toLowerCase())
  );

  return (
    <div className="client-workspace">
      <div className="cw-rail">
        <div className="cw-rail-title">
          <span>Cognexion</span>
        </div>
        <div className="cw-rail-search">
          <span>⌕</span>
          <input
            type="text"
            placeholder="Find a client"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="cw-rail-label">Accounts · {clients?.length ?? 0}</div>
        <div className="cw-rail-list">
          {filtered.map((c) => (
            <Link
              key={c.clientId}
              href={`/clients/${c.clientId}`}
              className={`cw-rail-item${c.clientId === activeClientId ? ' active' : ''}`}
            >
              <span className="cw-mono-badge">{monogram(c.name)}</span>
              <span className="cw-rail-item-name">{c.name}</span>
            </Link>
          ))}
          {clients !== null && filtered.length === 0 && (
            <span style={{ fontSize: 13, color: 'var(--cw-text-tertiary)', padding: '8px' }}>
              {clients.length === 0 ? 'No clients yet.' : 'No matches.'}
            </span>
          )}
        </div>
        <div className="cw-rail-spacer" />
        <div className="cw-rail-footer">
          <Link href="/clients" className="cw-btn cw-btn-primary" style={{ width: '100%', justifyContent: 'center' }}>
            + Add a client
          </Link>
        </div>
      </div>
      <div className="cw-main">
        <div className="cw-page">{children}</div>
      </div>
    </div>
  );
}
