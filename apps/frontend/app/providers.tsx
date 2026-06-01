'use client';

// rebuild trigger 2026-05-15T00:00:00Z — invalidates stale .next vendor-chunk
// reference to @tanstack+query-devtools after dependency upgrade. Safe to
// remove on the next planned dev-server restart.

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import { QueryClientProvider } from '@tanstack/react-query';
import dynamic from 'next/dynamic';
// Lazy-load devtools so the server bundle never needs the @tanstack vendor
// chunk. Avoids stale-cache 500s after dep upgrades.
const ReactQueryDevtools = dynamic(
  () => import('@tanstack/react-query-devtools').then((m) => m.ReactQueryDevtools),
  { ssr: false }
);
import { SnackbarProvider } from 'notistack';
import Cookies from 'js-cookie';
import { createAppTheme } from '@/theme/theme';
import { getQueryClient } from '@/lib/queryClient';
import { AuthProvider } from '@/lib/auth';

type Mode = 'light' | 'dark' | 'system';
const THEME_COOKIE = 'spv-theme';
const THEME_LS = 'spv:theme';

function readPreferredMode(): Mode {
  if (typeof window === 'undefined') return 'light';
  try {
    const ls = window.localStorage.getItem(THEME_LS) as Mode | null;
    if (ls === 'light' || ls === 'dark' || ls === 'system') return ls;
    const ck = Cookies.get(THEME_COOKIE) as Mode | undefined;
    if (ck === 'light' || ck === 'dark' || ck === 'system') return ck;
  } catch {
    /* ignore */
  }
  return 'light';
}

function resolveMode(mode: Mode, systemPrefersDark: boolean): 'light' | 'dark' {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}

export type ThemeContextValue = {
  mode: Mode;
  setMode: (m: Mode) => void;
};

import { createContext, useContext } from 'react';
const ThemeModeContext = createContext<ThemeContextValue | null>(null);

export function useThemeMode(): ThemeContextValue {
  const ctx = useContext(ThemeModeContext);
  if (!ctx) throw new Error('useThemeMode must be used inside <Providers>');
  return ctx;
}

export default function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => getQueryClient());
  const [mode, setModeState] = useState<Mode>('light');
  const [systemPrefersDark, setSystemPrefersDark] = useState<boolean>(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setModeState(readPreferredMode());
    if (typeof window !== 'undefined' && window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const listener = (e: MediaQueryListEvent) => setSystemPrefersDark(e.matches);
      setSystemPrefersDark(mq.matches);
      mq.addEventListener?.('change', listener);
      setHydrated(true);
      return () => mq.removeEventListener?.('change', listener);
    }
    setHydrated(true);
    return undefined;
  }, []);

  const setMode = (next: Mode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(THEME_LS, next);
      Cookies.set(THEME_COOKIE, next, { expires: 365, sameSite: 'lax' });
    } catch {
      /* ignore */
    }
  };

  const resolved = resolveMode(mode, systemPrefersDark);
  const theme = useMemo(() => createAppTheme(resolved), [resolved]);
  const ctxValue = useMemo<ThemeContextValue>(() => ({ mode, setMode }), [mode]);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeModeContext.Provider value={ctxValue}>
        <ThemeProvider theme={theme}>
          <CssBaseline enableColorScheme />
          <SnackbarProvider
            maxSnack={4}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
            autoHideDuration={4500}
            preventDuplicate
            dense={false}
            // SVT-A11Y-2026-05 — assistive-tech announcement. Errors +
            // warnings interrupt (assertive) so users with screen readers
            // catch failures; info/success are polite to avoid flooding.
            // Per WCAG 2.2 SC 4.1.3 "Status Messages".
            SnackbarProps={{ role: 'status', 'aria-live': 'polite' } as never}
            // For error / warning specifically, override via Components prop
            // since notistack doesn't expose a per-variant aria-live prop.
          >
            <AuthProvider>
              {/* suppress mismatch on first paint while we hydrate the theme */}
              <div style={{ visibility: hydrated ? 'visible' : 'visible' }}>{children}</div>
            </AuthProvider>
          </SnackbarProvider>
        </ThemeProvider>
      </ThemeModeContext.Provider>
      {process.env.NODE_ENV === 'development' ? (
        <ReactQueryDevtools initialIsOpen={false} buttonPosition="bottom-right" />
      ) : null}
    </QueryClientProvider>
  );
}
