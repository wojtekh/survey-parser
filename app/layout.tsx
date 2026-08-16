import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Survey Parser',
  description: 'Upload a document, see the parsed questions.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <header className="app-header row">
            <span>Survey Parser</span>
            <div className="row" style={{ width: 'auto', gap: 16 }}>
              <Link href="/annuity-calculator" style={{ fontSize: 13, fontWeight: 600 }}>
                Annuity Calculator
              </Link>
              <Link href="/clients" style={{ fontSize: 13, fontWeight: 600 }}>
                Clients
              </Link>
            </div>
          </header>
          <main className="app-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
