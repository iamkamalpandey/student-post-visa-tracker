'use client';

// SVT-WAVE-POLISH-2026-05 — Persistent UI density preference.
// Two surfaces today (Dashboard + Students list) share a single key so flipping
// it on one side is reflected everywhere. SSR-safe: hydrates from localStorage
// in an effect; defaults to 'comfortable' during the first paint to avoid a
// hydration mismatch.

import { useCallback, useEffect, useState } from 'react';

export type Density = 'comfortable' | 'compact';
const KEY = 'spv:ui-density';

function readStored(): Density {
  if (typeof window === 'undefined') return 'comfortable';
  try {
    const v = window.localStorage.getItem(KEY);
    return v === 'compact' ? 'compact' : 'comfortable';
  } catch {
    return 'comfortable';
  }
}

export function useDensity(): [Density, (next: Density) => void, () => void] {
  const [density, setDensityState] = useState<Density>('comfortable');

  useEffect(() => {
    setDensityState(readStored());
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setDensityState(readStored());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setDensity = useCallback((next: Density) => {
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // localStorage may be unavailable (private mode); the in-memory state
      // still wins for the rest of this session.
    }
    setDensityState(next);
  }, []);

  const toggle = useCallback(() => {
    setDensity(density === 'compact' ? 'comfortable' : 'compact');
  }, [density, setDensity]);

  return [density, setDensity, toggle];
}
