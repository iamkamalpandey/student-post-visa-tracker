'use client';

import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import { type ReactNode } from 'react';
import { useRequireAuth } from '@/lib/auth';
import AppShell from './AppShell';

export default function ProtectedLayout({ children }: { children: ReactNode }) {
  const { user, isLoading } = useRequireAuth();

  if (isLoading || !user) {
    return (
      <Box
        sx={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'background.default',
        }}
        role="status"
        aria-live="polite"
        suppressHydrationWarning
      >
        <Stack spacing={2} alignItems="center">
          <CircularProgress size={36} thickness={4} />
          <Typography variant="body2" color="text.secondary">
            {isLoading ? 'Restoring your session…' : 'Redirecting to sign in…'}
          </Typography>
        </Stack>
      </Box>
    );
  }

  return <AppShell>{children}</AppShell>;
}
