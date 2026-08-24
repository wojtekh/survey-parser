'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * The left rail — the "sidebar console" shell from the design canvas.
 *
 * A client component only because it needs usePathname for the active state.
 * Kept separate from layout.tsx so the layout itself stays a server component.
 *
 * The parser's sections live on one page, so those entries are anchors rather
 * than routes. That keeps the console feel without splitting page.tsx into
 * four views -- worth revisiting if the parse screen keeps growing.
 */
const PARSER_LINKS = [
  { href: '/#parse', label: 'New parse' },
  { href: '/#surveys', label: 'Surveys' },
  { href: '/#numbers', label: 'Inbound numbers' },
];

export default function RailNav() {
  const pathname = usePathname();
  const onClients = pathname?.startsWith('/clients');

  return (
    <nav className="app-rail">
      <div className="app-rail-brand">
        Cognexion
        <span>Survey parser</span>
      </div>

      <div className="app-rail-label">Parser</div>
      {PARSER_LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className={`app-rail-item${!onClients ? '' : ''}`}
        >
          {l.label}
        </Link>
      ))}

      <div className="app-rail-label">Accounts</div>
      <Link href="/clients" className={`app-rail-item${onClients ? ' active' : ''}`}>
        Clients
      </Link>

      <div className="app-rail-spacer" />
      <div className="app-rail-footer">Dograh workspace</div>
    </nav>
  );
}
