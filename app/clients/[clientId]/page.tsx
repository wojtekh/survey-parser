'use client';

import { useEffect, useState, FormEvent } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface ClientAgent {
  name: string;
  agentId: string;
  agentEmail: string;
}

interface Client {
  clientId: string;
  name: string;
  contactEmail: string;
  contactPhone: string;
  kbEnabled: boolean;
  kbStatus: 'none' | 'pending' | 'provisioned' | 'error';
  agents: ClientAgent[];
  lastError: string | null;
}

function AgentCard({ clientId, agent }: { clientId: string; agent: ClientAgent }) {
  const [file, setFile] = useState<globalThis.File | null>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'done' | 'error'>('idle');
  const [message, setMessage] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setStatus('uploading');
    setMessage(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('agent_name', agent.name);
      const res = await fetch(`/api/clients/${clientId}/documents`, { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Upload failed.');
      setStatus('done');
      setMessage(`Uploaded ${file.name}`);
      setFile(null);
    } catch (err) {
      setStatus('error');
      setMessage(err instanceof Error ? err.message : 'Upload failed.');
    }
  }

  return (
    <div className="question-item">
      <div style={{ fontWeight: 600, fontSize: 14 }}>{agent.name}</div>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
        {agent.agentEmail} · key issued
      </div>
      <div className="row" style={{ marginTop: 10, gap: 8 }}>
        <input
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          disabled={status === 'uploading'}
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={upload} disabled={!file || status === 'uploading'}>
          {status === 'uploading' ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      {message && (
        <p className={status === 'error' ? 'error-text' : ''} style={{ fontSize: 12, marginTop: 6 }}>
          {message}
        </p>
      )}
    </div>
  );
}

export default function ClientDetailPage() {
  const params = useParams();
  const clientId = params.clientId as string;

  const [client, setClient] = useState<Client | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newAgentName, setNewAgentName] = useState('');
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  function loadClient() {
    fetch(`/api/clients/${clientId}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'Failed to load client.');
        setClient(body.client);
      })
      .catch((err) => setLoadError(err instanceof Error ? err.message : 'Failed to load client.'));
  }

  useEffect(() => {
    loadClient();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId]);

  async function provisionAgent(e: FormEvent) {
    e.preventDefault();
    if (!newAgentName.trim()) return;

    setProvisioning(true);
    setProvisionError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}/provision`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_names: [newAgentName.trim()] }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to provision agent.');
      setClient(body.client);
      setNewAgentName('');
    } catch (err) {
      setProvisionError(err instanceof Error ? err.message : 'Failed to provision agent.');
    } finally {
      setProvisioning(false);
    }
  }

  if (loadError) {
    return (
      <>
        <Link href="/clients" className="btn">
          &larr; Back to clients
        </Link>
        <p className="error-text">{loadError}</p>
      </>
    );
  }

  if (!client) {
    return <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>Loading…</p>;
  }

  return (
    <>
      <div className="row">
        <h2 style={{ fontSize: 18, margin: 0 }}>{client.name}</h2>
        <Link href="/clients" className="btn">
          &larr; Back to clients
        </Link>
      </div>

      <div className="card stack" style={{ gap: 6 }}>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {client.contactEmail || 'no contact email'} · {client.contactPhone || 'no phone'}
        </div>
        <div className="row" style={{ justifyContent: 'flex-start', gap: 8 }}>
          {!client.kbEnabled && <span className="type-badge">Survey only</span>}
          {client.kbEnabled && client.kbStatus === 'provisioned' && (
            <span className="type-badge">Knowledge base: provisioned</span>
          )}
          {client.kbEnabled && client.kbStatus === 'pending' && (
            <span className="type-badge">Knowledge base: not provisioned yet</span>
          )}
          {client.kbEnabled && client.kbStatus === 'error' && (
            <span className="badge-danger">Knowledge base: error</span>
          )}
        </div>
        {client.lastError && <p className="error-text">{client.lastError}</p>}
      </div>

      {client.kbEnabled && (
        <div className="stack">
          <h3 style={{ fontSize: 15, margin: 0 }}>Agents</h3>

          {client.agents.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              No agent identities yet -- add the first Dograh agent for this client below.
            </p>
          ) : (
            <div className="stack" style={{ gap: 8 }}>
              {client.agents.map((a) => (
                <AgentCard key={a.agentId} clientId={client.clientId} agent={a} />
              ))}
            </div>
          )}

          <form className="card row" onSubmit={provisionAgent} style={{ gap: 8 }}>
            <input
              type="text"
              placeholder="Dograh agent name, e.g. reception"
              value={newAgentName}
              onChange={(e) => setNewAgentName(e.target.value)}
              disabled={provisioning}
              style={{ flex: 1 }}
            />
            <button
              type="submit"
              className="btn btn-primary"
              disabled={provisioning || !newAgentName.trim()}
            >
              {provisioning
                ? 'Provisioning…'
                : client.kbStatus === 'error'
                  ? 'Retry'
                  : 'Add & provision agent'}
            </button>
          </form>
          {provisionError && <p className="error-text">{provisionError}</p>}
        </div>
      )}
    </>
  );
}
