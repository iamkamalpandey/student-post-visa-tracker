// Server shell for the Commissions admin page. The actual page is a client
// component (filters, dialogs, mutations) — this file exists purely so we can
// export the canonical metadata.title that the rest of the app uses.

import type { Metadata } from 'next';
import Client from './Client';

export const metadata: Metadata = {
  title: 'Commissions',
};

export default function Page() {
  return <Client />;
}
