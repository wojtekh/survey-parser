import { NextRequest, NextResponse } from 'next/server';

// Simple HTTP Basic Auth in front of the whole app -- this is meant to be a
// public URL (Dograh needs to reach /api/agent/*), so without this anyone
// with the link could upload documents and create/read survey spreadsheets.
//
// Deliberately NOT applied to /api/agent/* -- those are called by Dograh
// itself (machine to machine, no browser to show a login prompt to) and
// already have their own check via AGENT_TOOLS_SECRET / x-agent-secret
// (see lib/checkAgentSecret.ts). Basic Auth here would just break Dograh's
// calls without adding real protection on top of that secret.
//
// Same convention as AGENT_TOOLS_SECRET: if AUTH_PASSWORD isn't set, the
// check is skipped entirely -- fine for local dev, but set it for anything
// deployed with a public URL.
export function middleware(request: NextRequest) {
  const expectedPassword = process.env.AUTH_PASSWORD;
  if (!expectedPassword) return NextResponse.next();

  const expectedUsername = process.env.AUTH_USERNAME || 'admin';

  const header = request.headers.get('authorization');
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf(':');
    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);
    if (username === expectedUsername && password === expectedPassword) {
      return NextResponse.next();
    }
  }

  return new NextResponse('Authentication required.', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Survey Parser"' },
  });
}

export const config = {
  // Everything except: /api/agent/* (Dograh's own machine-to-machine
  // calls), Next.js internals, and common static files.
  matcher: ['/((?!api/agent|_next/static|_next/image|favicon.ico).*)'],
};
