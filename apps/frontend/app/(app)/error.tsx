'use client';

// SVT-AUDIT-OPS-2026-05 — route-segment error boundary for the (app) group.
// Catches unhandled errors from child routes and renders a recovery surface
// instead of crashing the whole shell. Logs to console (and Sentry, when wired)
// so on-call has a stack to inspect.

import { useEffect } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { reportBoundaryError } from '@/lib/reportError';

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function AppGroupError({ error, reset }: Props) {
  useEffect(() => {
    // SVT-SEC-P2-FE4-2026-05 — dev: rich console; prod: sanitised beacon
    // (no message, no stack) to /api/v1/security/error-report.
    reportBoundaryError('app', error);
  }, [error]);

  return (
    <Stack
      role="alert"
      aria-live="assertive"
      spacing={2}
      alignItems="center"
      justifyContent="center"
      sx={{ minHeight: '60vh', px: 3, textAlign: 'center' }}
    >
      <ErrorOutlineIcon sx={{ fontSize: 48, color: 'error.main' }} />
      <Typography variant="h5" sx={{ fontWeight: 600 }}>
        Something went wrong
      </Typography>
      <Typography color="text.secondary" sx={{ maxWidth: 480 }}>
        {process.env.NODE_ENV !== 'production' && error.message
          ? error.message
          : 'An unexpected error occurred. The team has been notified.'}
      </Typography>
      {error.digest ? (
        <Typography variant="caption" color="text.secondary">
          Reference: {error.digest}
        </Typography>
      ) : null}
      <Box sx={{ display: 'flex', gap: 1 }}>
        <Button variant="contained" onClick={reset}>
          Try again
        </Button>
        <Button variant="outlined" onClick={() => { window.location.href = '/'; }}>
          Back to dashboard
        </Button>
      </Box>
    </Stack>
  );
}
