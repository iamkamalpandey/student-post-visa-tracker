'use client';

import type { ReactNode } from 'react';
import { Button, Card, Paper, Stack, Typography } from '@mui/material';

export type ListPageShellProps = {
  title: string;
  description?: string;
  /** Right-aligned primary action (e.g. "Add student"). */
  action?: ReactNode;
  /** Filter bar content — search box, selects, etc. Rendered in an outlined Paper. */
  filters?: ReactNode;
  /** Main content (table, empty state, error). Rendered in an outlined Card. */
  children: ReactNode;
  /** When true, skip the Card wrapper around children (caller renders its own surface). */
  bareContent?: boolean;
};

/**
 * Canonical layout shell for every list / index page in the (app) route group.
 * AppShell already provides the outer page padding — this component must NOT add more.
 */
export default function ListPageShell({
  title,
  description,
  action,
  filters,
  children,
  bareContent = false,
}: ListPageShellProps) {
  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        justifyContent="space-between"
      >
        <Stack spacing={0.75}>
          <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
            {title}
          </Typography>
          {description ? (
            <Typography variant="body1" color="text.secondary">
              {description}
            </Typography>
          ) : null}
        </Stack>
        {action ? <Stack direction="row" spacing={1}>{action}</Stack> : null}
      </Stack>

      {filters ? (
        // Lean on the theme's MuiPaper.rounded (shape.md = 8) — no per-instance
        // override. py: 1.5 is denser than the prior p: 2.
        <Paper variant="outlined" sx={{ px: 2, py: 1.5 }}>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5}>
            {filters}
          </Stack>
        </Paper>
      ) : null}

      {bareContent ? children : (
        // Card inherits theme borderRadius (shape.md = 8) — no override needed.
        <Card variant="outlined">
          {children}
        </Card>
      )}
    </Stack>
  );
}

/** Re-export Button for convenience so callers don't need a separate import. */
export { Button as ListAction };
