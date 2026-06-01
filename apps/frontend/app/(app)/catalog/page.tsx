import type { Metadata } from 'next';
import Client from './Client';

export const metadata: Metadata = {
  title: 'Catalog',
};

export default function Page() {
  return <Client />;
}
