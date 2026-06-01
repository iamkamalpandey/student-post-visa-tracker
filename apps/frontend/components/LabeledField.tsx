'use client';

import { type ReactNode } from 'react';
import { Box, Stack, Tooltip, Typography } from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';

type Props = {
  label: string;
  required?: boolean;
  helperText?: string;
  error?: boolean;
  children: ReactNode;
  /** Optional `for=` association — must match the input's `id`. */
  htmlFor?: string;
  /** Show a lock badge next to the label to mark fields encrypted at rest. */
  encrypted?: boolean;
  /**
   * Visually hide the label (still readable by screen-readers). Use INSIDE
   * filter toolbars where the input retains `size="small"` and a visible
   * label would compete with the data table below. The label is still
   * present in the DOM and associated via `htmlFor=` so AT users get the
   * same affordance as sighted users do via the placeholder/icon.
   */
  srOnly?: boolean;
};

/**
 * Label-above-input form field wrapper. Use INSTEAD of MUI's floating label
 * when you want the cleaner "label / input / helper" stack used by typical
 * SaaS admin forms.
 *
 * Pair with `<TextField hiddenLabel size="small" sx={{...}} />` so the inner
 * MUI label doesn't double-render. The input renders as a borderless box
 * inside this wrapper's container.
 */
// Tailwind-style sr-only: removes from visual flow but keeps in the AT tree.
const SR_ONLY_SX = {
  position: 'absolute' as const,
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden' as const,
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap' as const,
  border: 0,
};

export default function LabeledField({
  label,
  required = false,
  helperText,
  error = false,
  children,
  htmlFor,
  encrypted = false,
  srOnly = false,
}: Props) {
  // Screen-reader-only mode: render the label inline-but-hidden and skip
  // the helperText caption row entirely so filter toolbars stay compact.
  if (srOnly) {
    return (
      <Box sx={{ position: 'relative' }}>
        <Box component="label" htmlFor={htmlFor} sx={SR_ONLY_SX}>
          {label}
          {required ? ' (required)' : ''}
        </Box>
        {children}
      </Box>
    );
  }

  return (
    <Stack spacing={0.5} sx={{ mb: 0.5 }}>
      <Stack direction="row" alignItems="center" spacing={0.5} component="span">
        <Typography
          component="label"
          htmlFor={htmlFor}
          variant="body2"
          sx={{
            fontWeight: 500,
            fontSize: 13,
            color: error ? 'error.main' : 'text.primary',
            display: 'inline-flex',
            alignItems: 'baseline',
          }}
        >
          {label}
          {required && (
            <Box component="span" aria-hidden="true" sx={{ color: 'error.main', ml: 0.25, fontWeight: 700 }}>
              *
            </Box>
          )}
        </Typography>
        {encrypted && (
          <Tooltip title="Encrypted at rest">
            <Box
              component="span"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 0.25,
                px: 0.5,
                py: 0.125,
                borderRadius: 0.5,
                bgcolor: 'action.hover',
                color: 'text.secondary',
                fontSize: 10,
                fontWeight: 600,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
              }}
            >
              <LockOutlinedIcon sx={{ fontSize: 11 }} />
              Encrypted
            </Box>
          </Tooltip>
        )}
      </Stack>
      {children}
      {helperText && (
        <Typography variant="caption" color={error ? 'error.main' : 'text.secondary'} sx={{ minHeight: 16 }}>
          {helperText}
        </Typography>
      )}
    </Stack>
  );
}
