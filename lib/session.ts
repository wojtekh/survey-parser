// Signed, stateless session cookie -- replaces the HTTP Basic Auth that used
// to guard the whole app (see middleware.ts's old comment). Basic Auth's
// native browser credential prompt isn't a real login screen and can't be
// driven by anything that isn't a human typing into that prompt, so this
// swaps it for an actual /login page + cookie.
//
// Stateless on purpose: middleware.ts runs on Next's Edge runtime by
// default, which does not reliably share memory with the Node-runtime API
// routes that would otherwise track "logged in" sessions server-side (e.g.
// an in-memory Set). Signing the cookie with HMAC-SHA256 via the Web Crypto
// API (`crypto.subtle`) needs no shared state and works identically in both
// runtimes -- verification is pure math, not a lookup.
//
// The signing secret is AUTH_PASSWORD itself, reusing the one secret this
// app already has for this purpose rather than introducing a second one:
// anyone who could forge a valid cookie already knows the password, which
// is exactly the same trust boundary Basic Auth had.

export const SESSION_COOKIE_NAME = 'session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const SESSION_MAX_AGE_SECONDS = SESSION_DURATION_MS / 1000;

async function hmacHex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Value to set as the session cookie after a successful login. */
export async function createSessionValue(username: string, secret: string): Promise<string> {
  const expiresAt = Date.now() + SESSION_DURATION_MS;
  const signature = await hmacHex(secret, `${username}.${expiresAt}`);
  return `${expiresAt}.${signature}`;
}

/** True if `value` (the raw cookie) is a valid, unexpired session for `username`. */
export async function isValidSession(value: string, username: string, secret: string): Promise<boolean> {
  const dotIndex = value.indexOf('.');
  if (dotIndex === -1) return false;
  const expiresAtStr = value.slice(0, dotIndex);
  const signature = value.slice(dotIndex + 1);
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || Date.now() > expiresAt) return false;

  const expected = await hmacHex(secret, `${username}.${expiresAt}`);
  return timingSafeEqual(signature, expected);
}
