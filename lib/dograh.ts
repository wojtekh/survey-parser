// Thin client for Dograh's workflow (agent) API.
//
// VERIFIED against a live call to voice.cognexion.com on 2026-08-24:
//   - auth header is `X-API-Key`
//   - base path is `<host>/api/v1`
//   - GET /workflow/fetch returns
//     [{ id: number, name, status, created_at, total_runs, folder_id, workflow_uuid }]
//     `id` is the identifier the other endpoints take.
//
// ASSUMED, not yet exercised -- each is marked at its call site below:
//   - PUT /workflow/{id} takes the same body as create/definition
//   - PUT /workflow/{id}/status takes { status: "archived" }
//   - POST /workflow/{id}/validate response shape
// Dograh's docs do not specify these. They are written to fail loudly rather
// than pretend to succeed, and nothing depends on validate's shape.
//
// There is NO tools API. The get_next_screener_question UUID still has to be
// copied from the dashboard by hand -- see dograh/tools-setup.md.

export class DograhApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'DograhApiError';
  }
}

function config(): { baseUrl: string; apiKey: string } {
  const baseUrl = process.env.DOGRAH_API_URL;
  const apiKey = process.env.DOGRAH_API_KEY;
  if (!baseUrl || !apiKey) {
    throw new Error(
      'DOGRAH_API_URL / DOGRAH_API_KEY are not set. Add them to the environment before creating agents from this app.'
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey };
}

async function dograhFetch(path: string, init?: RequestInit): Promise<any> {
  const { baseUrl, apiKey } = config();
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
  });

  const text = await res.text();
  if (!res.ok) {
    // 401 is the one worth naming: it is almost always an unset or revoked
    // key, and "Unauthorized" alone sends people hunting the wrong thing.
    const hint =
      res.status === 401
        ? ' -- check DOGRAH_API_KEY is set and has not been revoked.'
        : '';
    throw new DograhApiError(
      res.status,
      `Dograh API error (${res.status}) on ${init?.method ?? 'GET'} ${path}: ${text}${hint}`
    );
  }

  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new DograhApiError(
      res.status,
      `Dograh returned a ${res.status} with a body that is not JSON on ${path}: ${text.slice(0, 200)}`
    );
  }
}

export interface DograhAgentSummary {
  id: number;
  name: string;
  status: string;
  created_at: string;
  total_runs: number;
  folder_id: number | null;
  workflow_uuid: string | null;
}

export async function listAgents(): Promise<DograhAgentSummary[]> {
  const body = await dograhFetch('/workflow/fetch');
  return Array.isArray(body) ? body : [];
}

export interface CreatedAgent {
  id: number;
  workflowUuid: string | null;
}

/**
 * Create an agent from a definition body.
 *
 * The docs never state what create/definition returns. So rather than trust
 * one shape, this reads an id out of whatever comes back, and if there isn't
 * one, falls back to listing agents and matching on the name we just used.
 *
 * That fallback is not defensive padding -- without it, a create that
 * succeeds but returns an unexpected body leaves an agent in Dograh whose id
 * we never learned, which is exactly the orphan the caller needs to avoid.
 */
export async function createAgent(definition: {
  name: string;
  workflow_definition: unknown;
}): Promise<CreatedAgent> {
  const body = await dograhFetch('/workflow/create/definition', {
    method: 'POST',
    body: JSON.stringify(definition),
  });

  const direct = body?.id ?? body?.workflow?.id ?? body?.data?.id;
  if (typeof direct === 'number') {
    return {
      id: direct,
      workflowUuid: body?.workflow_uuid ?? body?.workflow?.workflow_uuid ?? null,
    };
  }

  const agents = await listAgents();
  const match = agents
    .filter((a) => a.name === definition.name)
    .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0];

  if (!match) {
    throw new DograhApiError(
      502,
      `Dograh accepted the agent but returned no id, and no agent named "${definition.name}" came back from /workflow/fetch. Check the Dograh dashboard before creating it again -- a duplicate may already exist.`
    );
  }
  return { id: match.id, workflowUuid: match.workflow_uuid };
}

/** ASSUMED: same body as create. Fails loudly if Dograh disagrees. */
export async function updateAgent(
  id: number,
  definition: { name: string; workflow_definition: unknown }
): Promise<void> {
  await dograhFetch(`/workflow/${id}`, {
    method: 'PUT',
    body: JSON.stringify(definition),
  });
}

/**
 * ASSUMED body shape: { status: "archived" }. Dograh has no delete endpoint;
 * archiving is the documented removal path.
 *
 * Used as the rollback when an agent is created but its id cannot be stored.
 */
export async function archiveAgent(id: number): Promise<void> {
  await dograhFetch(`/workflow/${id}/status`, {
    method: 'PUT',
    body: JSON.stringify({ status: 'archived' }),
  });
}

/**
 * Best effort. The response shape is undocumented, so this returns whatever
 * came back for display and never blocks a save on it -- a validate endpoint
 * we cannot read reliably must not decide whether a real agent is usable.
 */
export async function validateAgent(id: number): Promise<unknown> {
  return dograhFetch(`/workflow/${id}/validate`, { method: 'POST' });
}
