// Shared-secret check for the two endpoints Dograh's HTTP API tools call.
// These will be public URLs once deployed, so this is the one bit of
// "essential" security worth including -- set AGENT_TOOLS_SECRET and add
// the same value as a custom header in each Dograh HTTP API tool's config.
// If AGENT_TOOLS_SECRET isn't set, the check is skipped (fine for local
// testing, not for anything deployed with a public URL).
export function checkAgentSecret(request: Request): boolean {
  const expected = process.env.AGENT_TOOLS_SECRET;
  if (!expected) return true;
  return request.headers.get('x-agent-secret') === expected;
}
