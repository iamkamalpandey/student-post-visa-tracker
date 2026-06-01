import type { Metadata } from 'next';
import OutboxClient from './Client';

export const metadata: Metadata = {
  title: 'Comms outbox',
};

export default function OutboxPage() {
  return <OutboxClient />;
}
