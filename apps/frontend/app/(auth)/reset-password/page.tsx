import type { Metadata } from 'next';
import { Suspense } from 'react';
import Client from './Client';

export const metadata: Metadata = {
  title: 'Reset password',
};

export default function Page() {
  // useSearchParams requires a Suspense boundary in app-router Server Components.
  return (
    <Suspense fallback={null}>
      <Client />
    </Suspense>
  );
}
