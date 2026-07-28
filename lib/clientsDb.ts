import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

// Clients live in an embedded SQLite database, not Google Sheets -- unlike
// surveys/inbound-numbers/fields/screener (which stay on Sheets and are
// unaffected by this), client records need instant read-your-writes
// consistency: this app hit Sheets' documented lack of read-after-write
// guarantee live, on the very first client created (create succeeded,
// clicking straight into its detail page got "not found" a moment later).
// SQLite has no such race -- a write is visible to the very next read in
// the same process, no network round trip, no eventual consistency window.
//
// Uses Node's built-in node:sqlite (stable without a flag since Node
// 22.13/23.4) rather than a package like better-sqlite3, specifically to
// avoid native-module compilation inside the Alpine + Next.js "standalone"
// output build -- see the Dockerfile for the Node 22 requirement this
// brings.
//
// IMPORTANT: the container filesystem is otherwise wiped on every redeploy.
// CLIENTS_DB_PATH's directory must be a persistent volume -- see
// docker-compose.yml's comment and the README for the Coolify Storages-tab
// step this requires for a Dockerfile-based app.

export interface ClientAgent {
  name: string;
  agentId: string;
  agentEmail: string;
  apiKeyEnc: string;
}

export type KbStatus = 'none' | 'pending' | 'provisioned' | 'error';

export interface Client {
  clientId: string;
  name: string;
  contactEmail: string;
  contactPhone: string;
  kbEnabled: boolean;
  kbStatus: KbStatus;
  cogneeUserEmail: string | null;
  cogneePasswordEnc: string | null;
  agents: ClientAgent[];
  createdAt: string;
  updatedAt: string;
  lastError: string | null;
}

let db: DatabaseSync | null = null;

function getDb(): DatabaseSync {
  if (db) return db;

  const dbPath = process.env.CLIENTS_DB_PATH || '/app/data/clients.db';
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS clients (
      client_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      contact_email TEXT NOT NULL DEFAULT '',
      contact_phone TEXT NOT NULL DEFAULT '',
      kb_enabled INTEGER NOT NULL DEFAULT 0,
      kb_status TEXT NOT NULL DEFAULT 'none',
      cognee_user_email TEXT,
      cognee_password_enc TEXT,
      agents_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_error TEXT
    )
  `);
  return db;
}

interface ClientRow {
  client_id: string;
  name: string;
  contact_email: string;
  contact_phone: string;
  kb_enabled: number;
  kb_status: string;
  cognee_user_email: string | null;
  cognee_password_enc: string | null;
  agents_json: string;
  created_at: string;
  updated_at: string;
  last_error: string | null;
}

function rowToClient(row: ClientRow): Client {
  return {
    clientId: row.client_id,
    name: row.name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    kbEnabled: row.kb_enabled === 1,
    kbStatus: row.kb_status as KbStatus,
    cogneeUserEmail: row.cognee_user_email,
    cogneePasswordEnc: row.cognee_password_enc,
    agents: row.agents_json ? (JSON.parse(row.agents_json) as ClientAgent[]) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastError: row.last_error,
  };
}

export async function createClient(input: {
  name: string;
  contactEmail: string;
  contactPhone: string;
  kbEnabled: boolean;
}): Promise<Client> {
  const now = new Date().toISOString();
  const client: Client = {
    clientId: randomUUID(),
    name: input.name,
    contactEmail: input.contactEmail,
    contactPhone: input.contactPhone,
    kbEnabled: input.kbEnabled,
    kbStatus: input.kbEnabled ? 'pending' : 'none',
    cogneeUserEmail: null,
    cogneePasswordEnc: null,
    agents: [],
    createdAt: now,
    updatedAt: now,
    lastError: null,
  };

  getDb()
    .prepare(
      `INSERT INTO clients
        (client_id, name, contact_email, contact_phone, kb_enabled, kb_status, cognee_user_email, cognee_password_enc, agents_json, created_at, updated_at, last_error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      client.clientId,
      client.name,
      client.contactEmail,
      client.contactPhone,
      client.kbEnabled ? 1 : 0,
      client.kbStatus,
      client.cogneeUserEmail,
      client.cogneePasswordEnc,
      JSON.stringify(client.agents),
      client.createdAt,
      client.updatedAt,
      client.lastError
    );

  return client;
}

export async function listClients(): Promise<Client[]> {
  const rows = getDb()
    .prepare('SELECT * FROM clients ORDER BY created_at DESC')
    .all() as unknown as ClientRow[];
  return rows.map(rowToClient);
}

export async function getClient(clientId: string): Promise<Client | null> {
  const row = getDb().prepare('SELECT * FROM clients WHERE client_id = ?').get(clientId) as
    | ClientRow
    | undefined;
  return row ? rowToClient(row) : null;
}

/** Overwrite a client's full record -- used after provisioning (or a provisioning failure) to persist the new state. */
export async function updateClient(client: Client): Promise<void> {
  const updatedAt = new Date().toISOString();
  const result = getDb()
    .prepare(
      `UPDATE clients SET
        name = ?, contact_email = ?, contact_phone = ?, kb_enabled = ?, kb_status = ?,
        cognee_user_email = ?, cognee_password_enc = ?, agents_json = ?, updated_at = ?, last_error = ?
       WHERE client_id = ?`
    )
    .run(
      client.name,
      client.contactEmail,
      client.contactPhone,
      client.kbEnabled ? 1 : 0,
      client.kbStatus,
      client.cogneeUserEmail,
      client.cogneePasswordEnc,
      JSON.stringify(client.agents),
      updatedAt,
      client.lastError,
      client.clientId
    );

  if (result.changes === 0) {
    throw new Error(`Client ${client.clientId} not found -- can't update.`);
  }
}

/** Remove a client's row entirely. Cognee-side cleanup (deleting its agent identities) must happen before calling this -- see the /api/clients/[clientId] DELETE route. */
export async function deleteClientRecord(clientId: string): Promise<void> {
  const result = getDb().prepare('DELETE FROM clients WHERE client_id = ?').run(clientId);
  if (result.changes === 0) {
    throw new Error(`Client ${clientId} not found -- can't delete.`);
  }
}

/** Strip one agent out of a client's agent list and persist -- used after successfully revoking that agent's Cognee identity. */
export async function removeAgentFromClient(clientId: string, agentId: string): Promise<Client> {
  const client = await getClient(clientId);
  if (!client) {
    throw new Error(`Client ${clientId} not found -- can't remove agent.`);
  }
  const updated: Client = {
    ...client,
    agents: client.agents.filter((a) => a.agentId !== agentId),
  };
  await updateClient(updated);
  return updated;
}
