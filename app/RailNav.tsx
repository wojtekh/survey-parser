'use client';

import Link from 'next/link';

/**
 * The left rail — the "sidebar console" shell from the design canvas.
 *
 * Clients is the app's home now -- New parse / Surveys / Inbound numbers
 * used to be a top-level "Parser" section here, each an anchor on the root
 * page. They moved into the per-client "Add survey" panel (see
 * app/clients/[clientId]/AddSurveyModal.tsx), so this rail no longer links
 * anywhere else. The root page (app/page.tsx) and its APIs are unchanged and
 * still reachable by direct URL -- only the nav entry was removed.
 */
export default function RailNav() {
  return (
    <nav className="app-rail">
      <div className="app-rail-brand">
        Cognexion
        <span>Survey parser</span>
      </div>

      <div className="app-rail-label">Workspace</div>
      <Link href="/clients" className="app-rail-item active">
        Clients
      </Link>

      <div className="app-rail-spacer" />
      <div className="app-rail-footer">Dograh workspace</div>
    </nav>
  );
}
