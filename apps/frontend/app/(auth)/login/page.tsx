import type { Metadata } from 'next';
import Client from './Client';

export const metadata: Metadata = {
  title: 'Sign in',
};

export default function Page() {
  return <Client />;
}
