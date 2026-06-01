import type { Metadata } from 'next';
import Client from './Client';

export const metadata: Metadata = {
  title: 'Exports',
};

export default function Page() {
  return <Client />;
}
