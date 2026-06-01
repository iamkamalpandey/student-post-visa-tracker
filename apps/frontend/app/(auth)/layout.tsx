'use client';

import { Box } from '@mui/material';
import type { ReactNode } from 'react';

/**
 * Layout for unauthenticated routes (login, password reset, etc.).
 * Intentionally does NOT mount the AppShell so /login is reachable without auth.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <Box
      sx={{
        minHeight: '100vh',
        display: 'flex',
        flexDirection: 'column',
        background: (t) =>
          t.palette.mode === 'light'
            ? `radial-gradient(1200px 600px at 0% -10%, ${t.palette.primary.light}33, transparent), ${t.palette.background.default}`
            : `radial-gradient(1200px 600px at 0% -10%, ${t.palette.primary.dark}55, transparent), ${t.palette.background.default}`,
      }}
    >
      {children}
    </Box>
  );
}
