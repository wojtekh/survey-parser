'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';

/**
 * The left rail — the "sidebar console" shell from the design canvas.
 *
 * Clients is the app's home now -- New parse / Surveys / Inbound numbers
 * used to be a top-level "Parser" section here, each an anchor on the root
 * page. They moved into the per-client "Add survey" panel (see
 * app/clients/[clientId]/AddSurveyModal.tsx), so this rail no longer links
 * anywhere else. The old parser page moved to /parser (still reachable
 * directly), and "/" now redirects to /clients.
 */
export default function RailNav() {
  const router = useRouter();

  async function logOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/login');
    router.refresh();
  }

  return (
    <nav className="app-rail">
      <div className="app-rail-brand">
        Cognexion
        <span>Console</span>
      </div>

      <div className="app-rail-label">Workspace</div>
      <Link href="/clients" className="app-rail-item active">
        Clients
      </Link>

      <div className="app-rail-spacer" />
      <button
        onClick={logOut}
        className="app-rail-item"
        style={{ all: 'unset', boxSizing: 'border-box', width: '100%', cursor: 'pointer', display: 'flex', alignItems: 'center', height: 40, padding: '0 12px', borderRadius: 8, font: '400 14px var(--font-sans)', color: 'var(--gray-700)' }}
      >
        Log out
      </button>
      <div className="app-rail-footer">Dograh workspace</div>
    </nav>
  );
}
