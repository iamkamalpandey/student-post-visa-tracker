// Backwards-compat shim. The standalone /reminders page was folded into
// /inbox?tab=tasks as part of the unified Inbox. Server-side redirect
// (308) so old bookmarks, share-links and stale-cache navigations land
// on the right tab without flashing a blank page.
import { redirect } from 'next/navigation';

export default function Page() {
  redirect('/inbox?tab=tasks');
}
