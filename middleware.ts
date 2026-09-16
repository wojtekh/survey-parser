import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE_NAME, isValidSession } from '@/lib/session';

// A real login screen in front of the whole app -- this is meant to be a
// public URL (Dograh needs to reach /api/agent/*), so without this anyone
// with the link could upload documents and create/read client and survey
// data. Replaces the HTTP Basic Auth this used to be: Basic Auth's native
// browser credential prompt isn't a real login screen and can't be driven
// by anything but a human typing into that prompt.
//
// Deliberately NOT applied to /api/agent/* -- those are called by Dograh
// itself (machine to machine, no browser to show a login screen to) and
// already have their own check via AGENT_TOOLS_SECRET / x-agent-secret (see
// lib/checkAgentSecret.ts). Also not applied to /login or /api/auth/* --
// those ARE the login flow, so gating them would make logging in impossible.
//
// Same convention as AGENT_TOOLS_SECRET: if AUTH_PASSWORD isn't set, the
// check is skipped entirely -- fine for local dev, but set it for anything
// deployed with a public URL.
export async function middleware(request: NextRequest) {
  const expectedPassword = process.env.AUTH_PASSWORD;
  if (!expectedPassword) return NextResponse.next();

  const expectedUsername = process.env.AUTH_USERNAME || 'admin';

  const cookie = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  if (cookie && (await isValidSession(cookie, expectedUsername, expectedPassword))) {
    return NextResponse.next();
  }

  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });
  }

  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set('next', request.nextUrl.pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Everything except: /api/agent/* (Dograh's own machine-to-machine
  // calls), the login flow itself, Next.js internals, and common static
  // files.
  matcher: ['/((?!api/agent|login|api/auth|_next/static|_next/image|favicon.ico).*)'],
};
