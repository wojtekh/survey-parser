import type { Metadata } from 'next';
import AppShell from './AppShell';
import './globals.css';

export const metadata: Metadata = {
  title: 'Cognexion Console',
  description: 'Clients, knowledge bases, surveys, and voice agents.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
