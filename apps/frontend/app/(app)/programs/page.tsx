import type { Metadata } from 'next';
import Client from './Client';

// User-facing label is "Courses" everywhere (nav, page heading, "New course");
// keep the browser tab title consistent with it even though the route/API
// term is "programs".
export const metadata: Metadata = {
  title: 'Courses',
};

export default function Page() {
  return <Client />;
}
