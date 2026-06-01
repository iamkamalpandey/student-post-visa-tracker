'use client';

// SVT-AUDIT-FE-POLISH-2026-05 — route-segment error boundary for the (legal)
// group (terms, privacy, support). Legal pages are public so the recovery
// link points home rather than into the app shell.

import { useEffect } from 'react';
import { Box, Button, Stack, Typography } from '@mui/material';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import { reportBoundaryError } from '@/lib/reportError';

type Props = {
  error: Error & { digest?: string };
  reset: () => void;
};

export default function LegalGroupError({ error, reset }: Props) {
  useEffect(() => {
    // SVT-SEC-P2-FE4-2026-05 — dev: rich console; prod: sanitised beacon.
    reportBoundaryError('legal', error);
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
          : 'We could not load this page. Please try again in a moment.'}
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
        <Button
          variant="outlined"
          onClick={() => {
            window.location.href = '/';
          }}
        >
          Back to home
        </Button>
      </Box>
    </Stack>
  );
}
