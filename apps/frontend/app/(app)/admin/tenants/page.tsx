import type { Metadata } from 'next';
import TenantsAdminClient from './Client';

export const metadata: Metadata = {
  title: 'Tenants',
};

export default function TenantsAdminPage() {
  return <TenantsAdminClient />;
}
