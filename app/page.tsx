import { redirect } from 'next/navigation';

// Clients is the app's home now -- the parser UI that used to live at "/"
// moved to /parser (still reachable directly, just no longer the landing
// page). See app/RailNav.tsx for why New parse/Surveys/Inbound numbers left
// the global nav.
export default function RootPage() {
  redirect('/clients');
}
