// SVT-WAVE-DSAR-PUBLIC-2026-05 — minimal layout for the public DSAR surface.
//
// Intentionally bare. No AppShell, no nav, no auth-aware chrome. GDPR Art. 12
// requires the surface to be reachable by anyone (including ex-students whose
// accounts were already deleted) without friction. Branding is suppressed so
// the page works under any tenant's domain without leaking the platform's
// trade dress.

import type { ReactNode } from 'react';

export default function PublicLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
