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
//
// Services (2026-09-16): a client's per-service state (knowledge base today;
// survey link / voice-agent-from-prompt / AI services later) used to live as
// one-off column pairs on `clients` (kb_enabled, kb_status, ...). That does
// not generalize -- each new service would mean another pair of columns and
// another bespoke read/write path. `client_services` replaces that with one
// row per (client, service type): enabled / status / lastError / a free-form
// data blob. `getService`/`upsertService`/`listServices` are the generic API
// new services should use.
//
// The old `kbEnabled`/`kbStatus`/`cogneeUserEmail`/`cogneePasswordEnc`/
// `agents`/`lastError` fields on `Client` are kept as a compatibility view
// onto the `knowledge_base` service row, purely so the existing API routes
// and UI (which all read/write those flat fields) did not need to change.
// New services should go through `services`/`getService`/`upsertService`
// directly instead of adding more flat fields like these.

export interface ClientAgent {
  name: string;
  agentId: string;
  agentEmail: string;
  apiKeyEnc: string;
}

export type KbStatus = 'none' | 'pending' | 'provisioned' | 'error';
export type ServiceStatus = KbStatus;

export interface ClientService {
  enabled: boolean;
  status: ServiceStatus;
  lastError: string | null;
  data: Record<string, any>;
  updatedAt: string;
}

export interface Client {
  clientId: string;
  name: string;
  contactEmail: string;
  contactPhone: string;
  services: Record<string, ClientService>;
  createdAt: string;
  updatedAt: string;

  // Compatibility view onto services.knowledge_base -- see file header.
  kbEnabled: boolean;
  kbStatus: KbStatus;
  cogneeUserEmail: string | null;
  cogneePasswordEnc: string | null;
  agents: ClientAgent[];
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
  // kb_enabled..last_error above are superseded by client_services below --
  // left in place (unread, unwritten from here on) rather than dropped,
  // since ALTER TABLE DROP COLUMN on an already-deployed SQLite file is a
  // needless risk for columns that are otherwise harmless once empty.
  db.exec(`
    CREATE TABLE IF NOT EXISTS client_services (
      client_id TEXT NOT NULL,
      service_type TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'none',
      last_error TEXT,
      data_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (client_id, service_type)
    )
  `);
  migrateKbColumnsToServices(db);
  return db;
}

/** One-time (idempotent) backfill: existing clients' kb_* columns -> a 'knowledge_base' client_services row. */
function migrateKbColumnsToServices(database: DatabaseSync): void {
  const rows = database.prepare('SELECT * FROM clients').all() as unknown as ClientRow[];
  if (rows.length === 0) return;

  const exists = database.prepare(
    'SELECT 1 FROM client_services WHERE client_id = ? AND service_type = ?'
  );
  const insert = database.prepare(`
    INSERT INTO client_services (client_id, service_type, enabled, status, last_error, data_json, updated_at)
    VALUES (?, 'knowledge_base', ?, ?, ?, ?, ?)
  `);

  for (const row of rows) {
    if (exists.get(row.client_id, 'knowledge_base')) continue;
    const data = JSON.stringify({
      cogneeUserEmail: row.cognee_user_email,
      cogneePasswordEnc: row.cognee_password_enc,
      agents: row.agents_json ? JSON.parse(row.agents_json) : [],
    });
    insert.run(row.client_id, row.kb_enabled, row.kb_status, row.last_error, data, row.updated_at);
  }
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

interface ServiceRow {
  client_id: string;
  service_type: string;
  enabled: number;
  status: string;
  last_error: string | null;
  data_json: string;
  updated_at: string;
}

function rowToService(row: ServiceRow): ClientService {
  return {
    enabled: row.enabled === 1,
    status: row.status as ServiceStatus,
    lastError: row.last_error,
    data: row.data_json ? JSON.parse(row.data_json) : {},
    updatedAt: row.updated_at,
  };
}

const EMPTY_KB_SERVICE: ClientService = {
  enabled: false,
  status: 'none',
  lastError: null,
  data: {},
  updatedAt: new Date(0).toISOString(),
};

function assembleClient(row: ClientRow, services: Record<string, ClientService>): Client {
  const kb = services.knowledge_base ?? EMPTY_KB_SERVICE;
  return {
    clientId: row.client_id,
    name: row.name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    services,
    createdAt: row.created_at,
    updatedAt: row.updated_at,

    kbEnabled: kb.enabled,
    kbStatus: kb.status,
    cogneeUserEmail: kb.data.cogneeUserEmail ?? null,
    cogneePasswordEnc: kb.data.cogneePasswordEnc ?? null,
    agents: kb.data.agents ?? [],
    lastError: kb.lastError,
  };
}

function loadServices(clientId: string): Record<string, ClientService> {
  const rows = getDb()
    .prepare('SELECT * FROM client_services WHERE client_id = ?')
    .all(clientId) as unknown as ServiceRow[];
  const out: Record<string, ClientService> = {};
  for (const row of rows) out[row.service_type] = rowToService(row);
  return out;
}

export async function createClient(input: {
  name: string;
  contactEmail: string;
  contactPhone: string;
  kbEnabled: boolean;
}): Promise<Client> {
  const now = new Date().toISOString();
  const clientId = randomUUID();

  getDb()
    .prepare(
      `INSERT INTO clients (client_id, name, contact_email, contact_phone, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(clientId, input.name, input.contactEmail, input.contactPhone, now, now);

  if (input.kbEnabled) {
    await upsertService(clientId, 'knowledge_base', {
      enabled: true,
      status: 'pending',
      lastError: null,
      data: {},
    });
  }

  const client = await getClient(clientId);
  if (!client) throw new Error(`Client ${clientId} not found immediately after creation.`);
  return client;
}

export async function listClients(): Promise<Client[]> {
  const rows = getDb()
    .prepare('SELECT * FROM clients ORDER BY created_at DESC')
    .all() as unknown as ClientRow[];
  if (rows.length === 0) return [];

  const serviceRows = getDb()
    .prepare('SELECT * FROM client_services')
    .all() as unknown as ServiceRow[];
  const byClient = new Map<string, Record<string, ClientService>>();
  for (const row of serviceRows) {
    const bucket = byClient.get(row.client_id) ?? {};
    bucket[row.service_type] = rowToService(row);
    byClient.set(row.client_id, bucket);
  }

  return rows.map((row) => assembleClient(row, byClient.get(row.client_id) ?? {}));
}

export async function getClient(clientId: string): Promise<Client | null> {
  const row = getDb().prepare('SELECT * FROM clients WHERE client_id = ?').get(clientId) as
    | ClientRow
    | undefined;
  if (!row) return null;
  return assembleClient(row, loadServices(clientId));
}

/**
 * Overwrite a client's full record. Basic fields (name/contact) go to
 * `clients`; the compatibility kb* fields on the passed object are written
 * back to the `knowledge_base` service row -- so every existing call site
 * that does `updateClient({ ...client, kbStatus: 'provisioned', ... })`
 * keeps working unchanged.
 */
export async function updateClient(client: Client): Promise<void> {
  const updatedAt = new Date().toISOString();
  const result = getDb()
    .prepare(`UPDATE clients SET name = ?, contact_email = ?, contact_phone = ?, updated_at = ? WHERE client_id = ?`)
    .run(client.name, client.contactEmail, client.contactPhone, updatedAt, client.clientId);

  if (result.changes === 0) {
    throw new Error(`Client ${client.clientId} not found -- can't update.`);
  }

  await upsertService(client.clientId, 'knowledge_base', {
    enabled: client.kbEnabled,
    status: client.kbStatus,
    lastError: client.lastError,
    data: {
      cogneeUserEmail: client.cogneeUserEmail,
      cogneePasswordEnc: client.cogneePasswordEnc,
      agents: client.agents,
    },
  });
}

/** Remove a client's row and all of its service rows. Cognee-side cleanup (deleting its agent identities) must happen before calling this -- see the /api/clients/[clientId] DELETE route. */
export async function deleteClientRecord(clientId: string): Promise<void> {
  const result = getDb().prepare('DELETE FROM clients WHERE client_id = ?').run(clientId);
  if (result.changes === 0) {
    throw new Error(`Client ${clientId} not found -- can't delete.`);
  }
  getDb().prepare('DELETE FROM client_services WHERE client_id = ?').run(clientId);
}

/**
 * Strip one agent out of a client's agent list and persist. Keyed by name,
 * not agentId -- every agent on a client now shares one Cognee agentId (see
 * lib/cognee.ts), so agentId can no longer identify a single row.
 */
export async function removeAgentFromClient(clientId: string, agentName: string): Promise<Client> {
  const client = await getClient(clientId);
  if (!client) {
    throw new Error(`Client ${clientId} not found -- can't remove agent.`);
  }
  const updated: Client = {
    ...client,
    agents: client.agents.filter((a) => a.name !== agentName),
  };
  await updateClient(updated);
  return updated;
}

// --- Generic services API -----------------------------------------------
// New services (survey link, voice-agent-from-prompt, KB-from-URL, AI
// services, ...) should read/write through these instead of adding more
// flat fields to Client. `serviceType` is an open string on purpose -- no
// central enum to edit every time a service is added.

export async function getService(clientId: string, serviceType: string): Promise<ClientService | null> {
  const row = getDb()
    .prepare('SELECT * FROM client_services WHERE client_id = ? AND service_type = ?')
    .get(clientId, serviceType) as ServiceRow | undefined;
  return row ? rowToService(row) : null;
}

export async function listServices(clientId: string): Promise<Record<string, ClientService>> {
  return loadServices(clientId);
}

/** Upsert one service row. Any field left out of `patch` keeps its current value (or a sane default for a new row). */
export async function upsertService(
  clientId: string,
  serviceType: string,
  patch: Partial<Pick<ClientService, 'enabled' | 'status' | 'lastError' | 'data'>>
): Promise<ClientService> {
  const current = await getService(clientId, serviceType);
  const next: ClientService = {
    enabled: patch.enabled ?? current?.enabled ?? false,
    status: patch.status ?? current?.status ?? 'none',
    lastError: patch.lastError !== undefined ? patch.lastError : (current?.lastError ?? null),
    data: patch.data ?? current?.data ?? {},
    updatedAt: new Date().toISOString(),
  };

  getDb()
    .prepare(
      `INSERT INTO client_services (client_id, service_type, enabled, status, last_error, data_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(client_id, service_type) DO UPDATE SET
         enabled = excluded.enabled,
         status = excluded.status,
         last_error = excluded.last_error,
         data_json = excluded.data_json,
         updated_at = excluded.updated_at`
    )
    .run(
      clientId,
      serviceType,
      next.enabled ? 1 : 0,
      next.status,
      next.lastError,
      JSON.stringify(next.data),
      next.updatedAt
    );

  return next;
}
