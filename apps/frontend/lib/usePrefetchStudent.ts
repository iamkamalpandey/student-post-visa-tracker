'use client';

// SVT-WAVE-POLISH-2026-05 — Hover-prefetch hook for student rows.
//
// Goal: by the time the user clicks a row, the React Query cache and the
// Next.js route chunk are warm so the detail page renders without a network
// round-trip. Debounced 200ms so casual mouse-over scans don't fire a burst
// of GETs.

import { useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { api } from './api';

const PREFETCH_DELAY_MS = 200;
const PREFETCH_STALE_MS = 30_000;

export function usePrefetchStudent() {
  const router = useRouter();
  const qc = useQueryClient();
  const timer = useRef<number | null>(null);
  const inflight = useRef<Set<string>>(new Set());

  const cancel = useCallback(() => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const onEnter = useCallback(
    (studentId: string, href?: string) => {
      cancel();
      timer.current = window.setTimeout(() => {
        if (inflight.current.has(studentId)) return;
        inflight.current.add(studentId);
        // React Query prefetch: idle if already cached & fresh.
        void qc
          .prefetchQuery({
            queryKey: ['student', studentId],
            queryFn: async () => {
              const res = await api.get(`/students/${studentId}`);
              return res.data;
            },
            staleTime: PREFETCH_STALE_MS,
          })
          .finally(() => inflight.current.delete(studentId));
        // Warm the Next.js route too.
        if (href) router.prefetch(href);
      }, PREFETCH_DELAY_MS);
    },
    [cancel, qc, router],
  );

  return { onEnter, onLeave: cancel };
}
