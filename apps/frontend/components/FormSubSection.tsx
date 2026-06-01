'use client';

import { type ReactNode } from 'react';
import { Stack, Typography, Box } from '@mui/material';

type Props = {
  title: string;
  icon?: ReactNode;
  iconColor?: 'primary' | 'success' | 'warning' | 'error' | 'info';
  children?: ReactNode;
};

/**
 * Sub-section divider inside a FormSection. Renders an icon + bold title row
 * followed by children (typically a Stack of LabeledFields).
 */
export default function FormSubSection({ title, icon, iconColor = 'primary', children }: Props) {
  return (
    <Box sx={{ mt: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }}>
        {icon && (
          <Box sx={{ color: (theme) => theme.palette[iconColor].main, display: 'inline-flex' }}>
            {icon}
          </Box>
        )}
        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
          {title}
        </Typography>
      </Stack>
      {children}
    </Box>
  );
}
