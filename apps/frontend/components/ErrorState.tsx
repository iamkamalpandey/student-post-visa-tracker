'use client';

import { Box, Button, Stack, Typography } from '@mui/material';
import ReportGmailerrorredOutlinedIcon from '@mui/icons-material/ReportGmailerrorredOutlined';
import { type ReactNode } from 'react';

export type ErrorStateProps = {
  title?: string;
  description?: string;
  /** Will render a "Try again" button when provided. */
  onRetry?: () => void;
  /** Optional secondary action (e.g. "Contact support"). */
  secondaryAction?: ReactNode;
  /** RFC 7807 instance id, request id, or trace id to display for support. */
  requestId?: string;
};

export default function ErrorState({
  title = 'Something went wrong',
  description = 'We couldn’t complete that request. Please try again in a moment.',
  onRetry,
  secondaryAction,
  requestId,
}: ErrorStateProps) {
  return (
    <Box
      sx={{
        width: '100%',
        py: { xs: 6, md: 8 },
        px: 3,
        textAlign: 'center',
        borderRadius: 3,
        border: (t) => `1px solid ${t.palette.divider}`,
        bgcolor: 'background.paper',
      }}
      role="alert"
      aria-live="assertive"
    >
      <Stack spacing={2} alignItems="center" maxWidth={460} mx="auto">
        <Box
          sx={{
            width: 56,
            height: 56,
            borderRadius: 999,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'error.light',
            color: 'error.dark',
          }}
        >
          <ReportGmailerrorredOutlinedIcon />
        </Box>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {description}
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ pt: 1 }}>
          {onRetry ? (
            <Button variant="contained" onClick={onRetry}>
              Try again
            </Button>
          ) : null}
          {secondaryAction}
        </Stack>
        {requestId ? (
          <Typography variant="caption" color="text.disabled">
            Reference: {requestId}
          </Typography>
        ) : null}
      </Stack>
    </Box>
  );
}
