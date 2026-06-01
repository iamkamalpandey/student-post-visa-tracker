import DashboardClient from './DashboardClient';

// Server Component shell — keeps the route a server boundary so we can later
// stream metadata, headers, and per-tenant SSR data without a client refactor.
export const metadata = {
  title: 'Dashboard',
};

export default function DashboardPage() {
  return <DashboardClient />;
}
