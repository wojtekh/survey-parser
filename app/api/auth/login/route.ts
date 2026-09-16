import { NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_SECONDS, createSessionValue } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/auth/login  { username, password }
export async function POST(request: Request) {
  const expectedPassword = process.env.AUTH_PASSWORD;
  if (!expectedPassword) {
    return NextResponse.json({ error: 'Login is not configured.' }, { status: 400 });
  }
  const expectedUsername = process.env.AUTH_USERNAME || 'admin';

  const body = await request.json().catch(() => ({}));
  const username: unknown = body.username;
  const password: unknown = body.password;

  if (typeof username !== 'string' || typeof password !== 'string' || username !== expectedUsername || password !== expectedPassword) {
    return NextResponse.json({ error: 'Incorrect username or password.' }, { status: 401 });
  }

  const value = await createSessionValue(expectedUsername, expectedPassword);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  return res;
}
