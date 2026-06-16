import type { Metadata } from 'next';
import Client from './Client';

export const metadata: Metadata = {
  title: 'Visa Interview Preparation',
  description: 'Practice for your visa interview with our proprietary question system.',
};

export default function Page() {
  return <Client />;
}
