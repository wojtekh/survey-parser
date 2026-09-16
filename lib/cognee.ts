import crypto from 'crypto';

// Server-side helper for the self-hosted Cognee instance that sits alongside
// Dograh (see cognee-setup-guide.md / client-onboarding-plan.md in the Voice
// AI project folder for the full architecture). Two things this file does
// deliberately differently from the manual curl workflow that built the
// first demo client:
//
// 1. Login bodies are built with URLSearchParams, not hand-assembled
//    strings. Cognee's login endpoint is application/x-www-form-urlencoded,
//    where a literal "+" decodes to a space -- a plus-addressed email
//    registered fine (JSON body) but failed login (form body) until the "+"
//    was percent-encoded as %2B. URLSearchParams does this encoding
//    correctly by construction, so that whole bug class can't happen here.
// 2. No admin credentials are needed for the core flow. Cognee's
//    /auth/register endpoint is unauthenticated, and agent identities are
//    created as child users of whichever user's own token calls
//    /agents/create -- so each client gets its own registered Cognee user,
//    and that user's own login (not an admin's) is what mints its agent
//    identities. This is what keeps agents scoped under the right client
//    automatically.
// 3. One Cognee identity is shared by every voice agent on a client, not one
//    per agent (2026-09-16). A client's first provision mints a single
//    agent identity; every agent name added after that reuses its
//    agentId/apiKey rather than minting a new one. This is what makes the
//    knowledge base shared across a client's agents -- they all read/write
//    the same Cognee dataset because they authenticate with the same key.

function getApiUrl(): string {
  const url = process.env.COGNEE_API_URL;
  if (!url) {
    throw new Error(
      'COGNEE_API_URL not set. Point it at your cognee-backend service (e.g. https://cognee-api.cognexion.com).'
    );
  }
  return url.replace(/\/+$/, '');
}

function getEncryptionKey(): Buffer {
  const raw = process.env.CLIENTS_SECRET_KEY;
  if (!raw) {
    throw new Error(
      'CLIENTS_SECRET_KEY not set. Generate one with `openssl rand -base64 32` and add it to .env -- ' +
        'it encrypts Cognee passwords/API keys at rest in the clients sheet.'
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `CLIENTS_SECRET_KEY must decode to exactly 32 bytes (got ${key.length}). Generate one with \`openssl rand -base64 32\`.`
    );
  }
  return key;
}

/** AES-256-GCM, IV + authTag + ciphertext joined with ':' as base64 segments. */
export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), ciphertext.toString('base64')].join(':');
}

export function decryptSecret(encoded: string): string {
  const key = getEncryptionKey();
  const [ivB64, tagB64, dataB64] = encoded.split(':');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Malformed encrypted value -- expected "iv:authTag:ciphertext".');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(dataB64, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

async function cogneeFetch(path: string, init?: RequestInit): Promise<any> {
  const url = `${getApiUrl()}${path}`;
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // Node's fetch throws a generic "fetch failed" here for any
    // network-level problem (DNS, connection refused, TLS) and buries the
    // real reason in `.cause` -- surface it so this doesn't turn into an
    // undebuggable "fetch failed" toast in the UI again.
    const cause = (err as any)?.cause;
    const causeMsg = cause instanceof Error ? cause.message : cause ? String(cause) : null;
    throw new Error(
      `Could not reach Cognee at ${url}${causeMsg ? ` (${causeMsg})` : ''}. ` +
        `Check COGNEE_API_URL and that cognee-backend's domain is live in Coolify.`
    );
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!res.ok) {
    const detail = typeof body === 'object' && body ? JSON.stringify(body.detail ?? body) : text;
    const err = new Error(`Cognee API error (${res.status}) on ${init?.method ?? 'GET'} ${path}: ${detail}`);
    (err as any).status = res.status;
    (err as any).body = body;
    throw err;
  }
  return body;
}

function isAlreadyExistsError(err: unknown): boolean {
  const body = (err as any)?.body;
  const detail = typeof body === 'object' && body ? body.detail : body;
  return typeof detail === 'string' && /already.*exist|ALREADY_EXISTS/i.test(detail);
}

/** Deterministic, always-unique Cognee login for a client -- one registered Cognee user per client record. */
function clientEmailFor(clientId: string): string {
  const domain = process.env.COGNEE_CLIENT_EMAIL_DOMAIN;
  if (!domain) {
    throw new Error('COGNEE_CLIENT_EMAIL_DOMAIN not set (e.g. "cognexion.com") -- used to build each client\'s Cognee login.');
  }
  return `client-${clientId}@${domain}`;
}

async function registerCogneeUser(email: string, password: string): Promise<void> {
  try {
    await cogneeFetch('/api/v1/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (err) {
    if (isAlreadyExistsError(err)) return; // fine -- reuse it below via login
    throw err;
  }
}

async function loginCogneeUser(email: string, password: string): Promise<string> {
  // URLSearchParams percent-encodes correctly (including '+'), unlike a
  // hand-built "username=...&password=..." string -- see file header.
  const body = new URLSearchParams({ username: email, password }).toString();
  const data = await cogneeFetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const token = data?.access_token;
  if (!token) throw new Error('Cognee login succeeded but no access_token was returned.');
  return token as string;
}

async function createAgentIdentity(
  clientToken: string,
  agentName: string
): Promise<{ agentId: string; agentEmail: string; agentApiKey: string }> {
  const data = await cogneeFetch(`/api/v1/agents/create?name=${encodeURIComponent(agentName)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${clientToken}` },
  });
  return { agentId: data.agentId, agentEmail: data.agentEmail, agentApiKey: data.agentApiKey };
}

export interface ProvisionedAgent {
  name: string;
  agentId: string;
  agentEmail: string;
  apiKeyEnc: string;
}

export interface ProvisionResult {
  cogneeUserEmail: string;
  cogneePasswordEnc: string;
  agents: ProvisionedAgent[];
}

/**
 * Idempotent: reuses the client's existing Cognee user/password if this
 * client was provisioned before (pass the previously-stored email +
 * encrypted password back in), and skips adding an agent for any agentName
 * that already exists in existingAgents. Safe to call again after a partial
 * failure, or later to add one more agent to an already-KB-enabled client.
 *
 * All agent names for a client share ONE Cognee identity -- minted once, on
 * the first name added, then reused for every name after. This is the whole
 * mechanism behind the shared-KB-per-client design: they all carry the same
 * agentId/apiKey, so they all read and write the same Cognee dataset.
 */
export async function provisionClientKnowledgeBase(params: {
  clientId: string;
  agentNames: string[];
  existingCogneeUserEmail?: string | null;
  existingCogneePasswordEnc?: string | null;
  existingAgents?: ProvisionedAgent[];
}): Promise<ProvisionResult> {
  const existingAgents = params.existingAgents ?? [];
  const alreadyNamed = new Set(existingAgents.map((a) => a.name));
  const toCreate = params.agentNames.filter((name) => !alreadyNamed.has(name));

  let email: string;
  let password: string;

  if (params.existingCogneeUserEmail && params.existingCogneePasswordEnc) {
    email = params.existingCogneeUserEmail;
    password = decryptSecret(params.existingCogneePasswordEnc);
  } else {
    email = clientEmailFor(params.clientId);
    password = crypto.randomBytes(24).toString('base64url');
    await registerCogneeUser(email, password);
  }

  let shared: Omit<ProvisionedAgent, 'name'> | null = existingAgents[0]
    ? { agentId: existingAgents[0].agentId, agentEmail: existingAgents[0].agentEmail, apiKeyEnc: existingAgents[0].apiKeyEnc }
    : null;

  if (!shared && toCreate.length > 0) {
    const token = await loginCogneeUser(email, password);
    const created = await createAgentIdentity(token, params.clientId);
    shared = {
      agentId: created.agentId,
      agentEmail: created.agentEmail,
      apiKeyEnc: encryptSecret(created.agentApiKey),
    };
  }

  const newAgents: ProvisionedAgent[] = toCreate.map((name) => ({ name, ...shared! }));

  return {
    cogneeUserEmail: email,
    cogneePasswordEnc: encryptSecret(password),
    agents: [...existingAgents, ...newAgents],
  };
}

/**
 * Upload one document into a specific agent's knowledge base -- ingest +
 * build the graph in one call. Good for a single new file, whether that's
 * the first starter document for a freshly-provisioned client or a later
 * top-up. See client-onboarding-plan.md for when to prefer add()+cognify()
 * instead (batches of several documents at once).
 */
export async function rememberDocument(
  agentApiKey: string,
  file: File,
  datasetName?: string
): Promise<void> {
  const form = new FormData();
  form.append('data', file, file.name);
  form.append('datasetName', datasetName ?? 'main_dataset');
  form.append('run_in_background', 'false');

  // Agent API keys (from /agents/create) are NOT interchangeable with the
  // "Authorization: Bearer <token>" scheme used for user login sessions --
  // that returned a 401 every time, even for a key minted seconds earlier.
  // Confirmed empirically against the live server: the same key gets 401 as
  // "Authorization: Bearer" and 200 as "X-Api-Key".
  await cogneeFetch('/api/v1/remember', {
    method: 'POST',
    headers: { 'X-Api-Key': agentApiKey },
    body: form,
  });
}

/**
 * Upload several documents into an agent's knowledge base as one batch:
 * add() each file individually, then a single cognify() over the whole
 * batch -- produces more consistent cross-document entity linking than N
 * separate remember() calls (each of which builds the graph in isolation).
 * See client-onboarding-plan.md's ingestion-design section.
 */
export async function addDocumentsBatch(
  agentApiKey: string,
  files: File[],
  datasetName?: string
): Promise<void> {
  const dataset = datasetName ?? 'main_dataset';

  for (const file of files) {
    const form = new FormData();
    form.append('data', file, file.name);
    form.append('datasetName', dataset);
    await cogneeFetch('/api/v1/add', {
      method: 'POST',
      headers: { 'X-Api-Key': agentApiKey },
      body: form,
    });
  }

  await cogneeFetch('/api/v1/cognify', {
    method: 'POST',
    headers: { 'X-Api-Key': agentApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasets: [dataset] }),
  });
}

export interface AgentDocument {
  dataId: string;
  datasetId: string;
  name: string;
}

export interface SearchResult {
  searchResult: unknown;
  datasetId: string | null;
  datasetName: string | null;
}

/**
 * Query an agent's knowledge base -- the retrieval half of remember/cognify.
 * Verified against the live cognee-backend OpenAPI schema (2026-09-16):
 * `POST /api/v1/search`, same `X-Api-Key` auth as remember/add, body
 * `{query, searchType, datasets}`, response an array of
 * `{search_result, dataset_id, dataset_name}`.
 *
 * `datasets` MUST match the name every upload already writes into --
 * `rememberDocument`/`addDocumentsBatch`/`listAgentDocuments` all default to
 * 'main_dataset'. Omitting it here (as an earlier version of this function
 * did) leaves Cognee to pick its own default dataset scope, which is not
 * where anything was actually ingested -- confirmed live 2026-09-16: a real
 * GRAPH_COMPLETION answer came back synthesized from empty context ("no
 * specific information... in the provided context") for a document that was
 * genuinely uploaded. Not an ingestion failure -- a dataset-scope mismatch.
 *
 * 'GRAPH_COMPLETION' (default) returns an LLM answer grounded in the graph
 * -- the fastest way to confirm ingested content is actually retrievable.
 * 'CHUNKS' returns the raw retrieved text instead, with no synthesis step.
 */
export async function searchKnowledgeBase(
  agentApiKey: string,
  query: string,
  searchType: 'GRAPH_COMPLETION' | 'CHUNKS' | 'SUMMARIES' = 'GRAPH_COMPLETION',
  datasetName?: string
): Promise<SearchResult[]> {
  const data = await cogneeFetch('/api/v1/search', {
    method: 'POST',
    headers: { 'X-Api-Key': agentApiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, searchType, datasets: [datasetName ?? 'main_dataset'] }),
  });
  const list = Array.isArray(data) ? data : [];
  return list.map((item: any) => ({
    searchResult: item.search_result ?? item,
    datasetId: item.dataset_id ?? null,
    datasetName: item.dataset_name ?? null,
  }));
}

/** Look up the dataset ID Cognee assigned to `datasetName` for the caller (agent) making this request. */
async function findDatasetId(agentApiKey: string, datasetName: string): Promise<string | null> {
  const datasets = await cogneeFetch('/api/v1/datasets', {
    headers: { 'X-Api-Key': agentApiKey },
  });
  const list = Array.isArray(datasets) ? datasets : datasets?.datasets;
  const match = Array.isArray(list) ? list.find((d: any) => d.name === datasetName) : null;
  return match?.id ?? match?.dataset_id ?? null;
}

/**
 * List the documents ingested into one agent's knowledge base. Returns []
 * if the agent hasn't had anything uploaded yet (no dataset created).
 */
export async function listAgentDocuments(
  agentApiKey: string,
  datasetName?: string
): Promise<AgentDocument[]> {
  const dataset = datasetName ?? 'main_dataset';
  const datasetId = await findDatasetId(agentApiKey, dataset);
  if (!datasetId) return [];

  const data = await cogneeFetch(`/api/v1/datasets/${datasetId}/data`, {
    headers: { 'X-Api-Key': agentApiKey },
  });
  const items = Array.isArray(data) ? data : data?.data ?? [];
  return items.map((item: any) => ({
    dataId: item.id ?? item.data_id,
    datasetId,
    name: item.name ?? item.file_metadata?.name ?? item.raw_data_location ?? 'Untitled document',
  }));
}

/** Delete a single ingested document from an agent's dataset. */
export async function deleteAgentDocument(
  agentApiKey: string,
  datasetId: string,
  dataId: string
): Promise<void> {
  await cogneeFetch(`/api/v1/datasets/${datasetId}/data/${dataId}`, {
    method: 'DELETE',
    headers: { 'X-Api-Key': agentApiKey },
  });
}

/**
 * Cascade-delete the agent identity/identities under a client's Cognee
 * user -- called only when the whole CLIENT is deleted, never for removing
 * one voice agent (all of a client's agents share one Cognee identity, so
 * revoking it takes every agent's access down at once; that's only correct
 * when the client itself is going away). Dedupes agentIds first, since
 * every agent row on a client now carries the same shared agentId -- one
 * real Cognee identity behind however many local rows. Best effort --
 * collects failures rather than throwing on the first one. Cognee has no
 * "delete user" endpoint we've found, so the client's own parent Cognee
 * account is NOT deleted here -- only its agent identity is. See
 * client-onboarding-plan.md.
 */
export async function deleteAllCogneeAgents(
  cogneeUserEmail: string,
  cogneePasswordEnc: string,
  agentIds: string[]
): Promise<{ failed: { agentId: string; error: string }[] }> {
  const password = decryptSecret(cogneePasswordEnc);
  const token = await loginCogneeUser(cogneeUserEmail, password);

  const failed: { agentId: string; error: string }[] = [];
  for (const agentId of new Set(agentIds)) {
    try {
      await cogneeFetch(`/api/v1/agents/${agentId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (err) {
      failed.push({ agentId, error: err instanceof Error ? err.message : 'Unknown error' });
    }
  }
  return { failed };
}
