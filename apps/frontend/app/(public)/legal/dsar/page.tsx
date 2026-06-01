import type { Metadata } from 'next';
import Client from './Client';

export const metadata: Metadata = {
  title: 'Submit a data request',
  description:
    'Public form for submitting access, portability, erasure, rectification, restriction, or objection requests under GDPR, UK DPA, AU Privacy Act, India DPDP, and similar regimes.',
  // Public surface — keep noindex so the form doesn't show up as a search
  // result. Subjects find it from links emailed to them by the tenant or from
  // privacy policies.
  robots: { index: false, follow: false },
};

export default function Page() {
  return <Client />;
}
