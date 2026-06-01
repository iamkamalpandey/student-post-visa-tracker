// Server component on purpose: child page.tsx files export `metadata`, which Next.js
// disallows under a client-marked layout. ProtectedLayout itself is the client boundary.
import type { ReactNode } from 'react';
import ProtectedLayout from '@/components/ProtectedLayout';

export default function AppGroupLayout({ children }: { children: ReactNode }) {
  return <ProtectedLayout>{children}</ProtectedLayout>;
}
