import type { Metadata } from 'next';
import Client from './Client';

export const metadata: Metadata = {
  title: 'Institution',
};

export default function Page() {
  return <Client />;
}
