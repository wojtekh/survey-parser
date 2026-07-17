import type { Metadata } from 'next';
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
          <header className="app-header">Survey Parser</header>
          <main className="app-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
