'use client';

import { Box, Stack, Typography } from '@mui/material';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import { type ReactNode } from 'react';

export type EmptyStateProps = {
  title: string;
  description?: string;
  icon?: ReactNode;
  actions?: ReactNode;
  /** When true, the state fills its parent height. */
  fill?: boolean;
};

export default function EmptyState({
  title,
  description,
  icon,
  actions,
  fill = false,
}: EmptyStateProps) {
  return (
    <Box
      sx={{
        width: '100%',
        minHeight: fill ? 360 : 240,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        py: { xs: 6, md: 8 },
        px: 3,
        textAlign: 'center',
        borderRadius: 3,
        border: (t) => `1px dashed ${t.palette.divider}`,
        bgcolor: 'background.paper',
      }}
      role="status"
    >
      <Stack spacing={2} alignItems="center" maxWidth={460}>
        <Box
          sx={{
            width: 56,
            height: 56,
            borderRadius: 999,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: 'action.hover',
            color: 'text.secondary',
          }}
        >
          {icon ?? <InboxOutlinedIcon fontSize="medium" />}
        </Box>
        <Typography variant="h6" sx={{ fontWeight: 600 }}>
          {title}
        </Typography>
        {description ? (
          <Typography variant="body2" color="text.secondary">
            {description}
          </Typography>
        ) : null}
        {actions ? (
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ pt: 1 }}>
            {actions}
          </Stack>
        ) : null}
      </Stack>
    </Box>
  );
}
