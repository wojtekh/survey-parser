'use client';

import { useEffect, useState, FormEvent } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { notifyClientsChanged } from '../layout';

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
  createdAt: string;
}

interface AgentDocument {
  dataId: string;
  datasetId: string;
  name: string;
}

function monogram(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function ConfirmModal({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}) {
  return (
    <div className="cw-modal-backdrop" onClick={onCancel}>
      <div className="cw-modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button className="cw-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="cw-btn cw-btn-danger" onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function AgentSection({
  clientId,
  agent,
  onAgentDeleted,
}: {
  clientId: string;
  agent: ClientAgent;
  onAgentDeleted: (agentId: string) => void;
}) {
  const [documents, setDocuments] = useState<AgentDocument[] | null>(null);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [files, setFiles] = useState<FileList | null>(null);
  const [uploadStatus, setUploadStatus] = useState<'idle' | 'uploading' | 'error'>('idle');
  const [uploadMessage, setUploadMessage] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deletingAgent, setDeletingAgent] = useState(false);
  const [deletingDocId, setDeletingDocId] = useState<string | null>(null);

  function loadDocuments() {
    fetch(`/api/clients/${clientId}/documents?agent_name=${encodeURIComponent(agent.name)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? 'Failed to list documents.');
        setDocuments(body.documents ?? []);
      })
      .catch((err) => setDocsError(err instanceof Error ? err.message : 'Failed to list documents.'));
  }

  useEffect(() => {
    loadDocuments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.name]);

  async function upload() {
    if (!files || files.length === 0) return;
    setUploadStatus('uploading');
    setUploadMessage(null);
    try {
      const form = new FormData();
      Array.from(files).forEach((f) => form.append('file', f));
      form.append('agent_name', agent.name);
      const res = await fetch(`/api/clients/${clientId}/documents`, { method: 'POST', body: form });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Upload failed.');
      setUploadStatus('idle');
      setUploadMessage(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}.`);
      setFiles(null);
      loadDocuments();
    } catch (err) {
      setUploadStatus('error');
      setUploadMessage(err instanceof Error ? err.message : 'Upload failed.');
    }
  }

  async function deleteDocument(doc: AgentDocument) {
    setDeletingDocId(doc.dataId);
    try {
      const res = await fetch(`/api/clients/${clientId}/documents`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_name: agent.name, dataset_id: doc.datasetId, data_id: doc.dataId }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to delete document.');
      setDocuments((prev) => (prev ? prev.filter((d) => d.dataId !== doc.dataId) : prev));
    } catch (err) {
      setDocsError(err instanceof Error ? err.message : 'Failed to delete document.');
    } finally {
      setDeletingDocId(null);
    }
  }

  async function deleteAgent() {
    setDeletingAgent(true);
    try {
      const res = await fetch(`/api/clients/${clientId}/agents/${agent.agentId}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to delete agent.');
      onAgentDeleted(agent.agentId);
    } catch (err) {
      setDocsError(err instanceof Error ? err.message : 'Failed to delete agent.');
      setDeletingAgent(false);
      setConfirmingDelete(false);
    }
  }

  return (
    <div className="cw-agent-card">
      <div className="cw-agent-head">
        <div>
          <div className="cw-agent-name">{agent.name}</div>
          <div className="cw-agent-meta">{agent.agentEmail}</div>
        </div>
        <button className="cw-icon-btn danger" title="Delete agent" onClick={() => setConfirmingDelete(true)}>
          ✕
        </button>
      </div>

      <div className="cw-dropzone">
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 600, fontSize: 14 }}>Drop documents to add them</div>
          <div style={{ fontSize: 12, color: 'var(--cw-text-tertiary)' }}>
            .pdf, .docx, .txt, .md — select several at once for a batch upload.
          </div>
        </div>
        <input
          type="file"
          multiple
          onChange={(e) => setFiles(e.target.files)}
          disabled={uploadStatus === 'uploading'}
          style={{ maxWidth: 220 }}
        />
        <button
          className="cw-btn cw-btn-primary"
          onClick={upload}
          disabled={!files || files.length === 0 || uploadStatus === 'uploading'}
        >
          {uploadStatus === 'uploading' ? 'Uploading…' : 'Upload'}
        </button>
      </div>
      {uploadMessage && (
        <p className={uploadStatus === 'error' ? 'error-text' : ''} style={{ fontSize: 12, margin: 0 }}>
          {uploadMessage}
        </p>
      )}

      {docsError && <p className="error-text" style={{ fontSize: 12 }}>{docsError}</p>}

      {documents === null ? (
        <p style={{ fontSize: 13, color: 'var(--cw-text-tertiary)' }}>Loading documents…</p>
      ) : documents.length === 0 ? (
        <p style={{ fontSize: 13, color: 'var(--cw-text-tertiary)' }}>No documents uploaded yet.</p>
      ) : (
        <div>
          {documents.map((d) => (
            <div key={d.dataId} className="cw-doc-row" style={{ gridTemplateColumns: '1fr auto' }}>
              <span className="cw-doc-name">{d.name}</span>
              <button
                className="cw-icon-btn danger"
                title="Delete document"
                onClick={() => deleteDocument(d)}
                disabled={deletingDocId === d.dataId}
              >
                {deletingDocId === d.dataId ? '…' : '✕'}
              </button>
            </div>
          ))}
        </div>
      )}

      {confirmingDelete && (
        <ConfirmModal
          title={`Delete ${agent.name}?`}
          body="This revokes the agent's Cognee login and API key. Its uploaded documents are NOT deleted -- they may be shared with other agents on this client."
          confirmLabel="Delete agent"
          busy={deletingAgent}
          onConfirm={deleteAgent}
          onCancel={() => setConfirmingDelete(false)}
        />
      )}
    </div>
  );
}

export default function ClientDetailPage() {
  const params = useParams();
  const router = useRouter();
  const clientId = params.clientId as string;

  const [client, setClient] = useState<Client | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newAgentName, setNewAgentName] = useState('');
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState('');
  const [editEmail, setEditEmail] = useState('');
  const [editPhone, setEditPhone] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const [confirmingDeleteClient, setConfirmingDeleteClient] = useState(false);
  const [deletingClient, setDeletingClient] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

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

  function startEdit() {
    if (!client) return;
    setEditName(client.name);
    setEditEmail(client.contactEmail);
    setEditPhone(client.contactPhone);
    setEditing(true);
  }

  async function saveEdit(e: FormEvent) {
    e.preventDefault();
    setSavingEdit(true);
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim(), contact_email: editEmail.trim(), contact_phone: editPhone.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to save.');
      setClient(body.client);
      notifyClientsChanged();
      setEditing(false);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to save.');
    } finally {
      setSavingEdit(false);
    }
  }

  async function deleteClient() {
    setDeletingClient(true);
    setDeleteError(null);
    try {
      const res = await fetch(`/api/clients/${clientId}`, { method: 'DELETE' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? 'Failed to delete client.');
      notifyClientsChanged();
      router.push('/clients');
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete client.');
      setDeletingClient(false);
    }
  }

  function onAgentDeleted(agentId: string) {
    setClient((prev) => (prev ? { ...prev, agents: prev.agents.filter((a) => a.agentId !== agentId) } : prev));
  }

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
    return <p className="error-text">{loadError}</p>;
  }
  if (!client) {
    return <p style={{ fontSize: 13, color: 'var(--cw-text-tertiary)' }}>Loading…</p>;
  }

  const badgeClass =
    client.kbStatus === 'provisioned'
      ? 'cw-badge cw-badge-success'
      : client.kbStatus === 'error'
        ? 'cw-badge cw-badge-alert'
        : 'cw-badge cw-badge-info';
  const badgeText = !client.kbEnabled
    ? 'Survey only'
    : client.kbStatus === 'provisioned'
      ? 'Knowledge base ready'
      : client.kbStatus === 'error'
        ? 'Knowledge base error'
        : 'Knowledge base pending';

  return (
    <>
      <div className="cw-header">
        <div className="cw-header-avatar">{monogram(client.name)}</div>
        <div style={{ flex: 1 }}>
          <div className="row" style={{ justifyContent: 'flex-start', gap: 10 }}>
            <h1 className="cw-header-title">{client.name}</h1>
            <span className={badgeClass}>{badgeText}</span>
          </div>
          <div className="cw-header-sub">
            {client.contactEmail || 'no contact email'} · {client.contactPhone || 'no phone'}
          </div>
        </div>
        <button className="cw-btn" onClick={startEdit}>
          Edit details
        </button>
        <button className="cw-btn cw-btn-danger" onClick={() => setConfirmingDeleteClient(true)}>
          Delete client
        </button>
      </div>

      {editing && (
        <form className="cw-card stack" onSubmit={saveEdit} style={{ maxWidth: 480 }}>
          <div>
            <label>Client name</label>
            <input type="text" value={editName} onChange={(e) => setEditName(e.target.value)} required />
          </div>
          <div>
            <label>Contact email</label>
            <input type="text" value={editEmail} onChange={(e) => setEditEmail(e.target.value)} />
          </div>
          <div>
            <label>Contact phone</label>
            <input type="text" value={editPhone} onChange={(e) => setEditPhone(e.target.value)} />
          </div>
          <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
            <button type="button" className="cw-btn" onClick={() => setEditing(false)} disabled={savingEdit}>
              Cancel
            </button>
            <button type="submit" className="cw-btn cw-btn-primary" disabled={savingEdit || !editName.trim()}>
              {savingEdit ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      )}

      {client.lastError && <p className="error-text">{client.lastError}</p>}

      {client.kbEnabled && (
        <div className="stack">
          <div className="cw-section-title">
            Agents <span className="count">{client.agents.length}</span>
          </div>

          {client.agents.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--cw-text-tertiary)' }}>
              No agent identities yet -- add the first Dograh agent for this client below.
            </p>
          ) : (
            <div className="stack" style={{ gap: 12 }}>
              {client.agents.map((a) => (
                <AgentSection key={a.agentId} clientId={client.clientId} agent={a} onAgentDeleted={onAgentDeleted} />
              ))}
            </div>
          )}

          <form className="cw-card row" onSubmit={provisionAgent} style={{ gap: 8 }}>
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
              className="cw-btn cw-btn-primary"
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

      {confirmingDeleteClient && (
        <ConfirmModal
          title={`Delete ${client.name}?`}
          body={`This revokes all ${client.agents.length} agent identit${client.agents.length === 1 ? 'y' : 'ies'} in Cognee and permanently removes this client. This cannot be undone.`}
          confirmLabel="Delete client"
          busy={deletingClient}
          onConfirm={deleteClient}
          onCancel={() => setConfirmingDeleteClient(false)}
        />
      )}
      {deleteError && <p className="error-text">{deleteError}</p>}
    </>
  );
}
