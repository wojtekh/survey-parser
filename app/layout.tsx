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
            <Link href="/clients" style={{ fontSize: 13, fontWeight: 600 }}>
              Clients
            </Link>
          </header>
          <main className="app-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
