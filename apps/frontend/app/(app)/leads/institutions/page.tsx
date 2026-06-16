import type { Metadata } from 'next';
import Client from './Client';

export const metadata: Metadata = {
  title: 'CRM catalog report',
};

export default function Page() {
  return <Client />;
}
