import type { Metadata } from 'next';
import RailNav from './RailNav';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cognexion Console',
  description: 'Clients, knowledge bases, surveys, and voice agents.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="app-shell">
          <RailNav />
          <main className="app-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
