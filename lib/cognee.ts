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
//    automatically. Tenant creation (for sharing context across a client's
//    agents) is intentionally not implemented yet -- per-client-user
//    isolation is enough for a single agent per client; add it if/when a
//    client needs multiple agents to share memory.

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
  const res = await fetch(`${getApiUrl()}${path}`, init);
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
 * encrypted password back in), and skips creating an agent identity for any
 * agentName that already exists in existingAgents. Safe to call again after
 * a partial failure, or later to add one more agent to an already-KB-enabled
 * client.
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

  const token = await loginCogneeUser(email, password);

  const newAgents: ProvisionedAgent[] = [];
  for (const name of toCreate) {
    const created = await createAgentIdentity(token, name);
    newAgents.push({
      name,
      agentId: created.agentId,
      agentEmail: created.agentEmail,
      apiKeyEnc: encryptSecret(created.agentApiKey),
    });
  }

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

  await cogneeFetch('/api/v1/remember', {
    method: 'POST',
    headers: { Authorization: `Bearer ${agentApiKey}` },
    body: form,
  });
}
