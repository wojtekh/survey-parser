'use client';

import { usePathname } from 'next/navigation';
import RailNav from './RailNav';

// The login page stands alone -- no point showing a nav rail whose only
// link (Clients) the middleware would just bounce back to /login anyway.
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/login') return <>{children}</>;

  return (
    <div className="app-shell">
      <RailNav />
      <main className="app-main">{children}</main>
    </div>
  );
}
