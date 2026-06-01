'use client';

import { useState, type ReactNode } from 'react';
import { Box, IconButton, Stack, Typography, Collapse, Paper } from '@mui/material';
import ExpandMoreOutlinedIcon from '@mui/icons-material/ExpandMoreOutlined';
import ExpandLessOutlinedIcon from '@mui/icons-material/ExpandLessOutlined';

type Props = {
  title: string;
  subtitle?: string;
  icon: ReactNode;
  /** Tinted square color behind the icon. Defaults to the theme's primary at 12% opacity. */
  iconColor?: 'primary' | 'success' | 'warning' | 'error' | 'info' | 'muted';
  children: ReactNode;
  /** Defaults to true — section is open. Pass false to ship a collapsed section. */
  defaultOpen?: boolean;
  /** Hide the chevron + interaction. */
  static?: boolean;
  /**
   * Compact mode: smaller icon (24x24), no card chrome, only a thin top
   * divider. Use INSIDE forms where the section header should not compete
   * with the fields below it.
   */
  compact?: boolean;
};

/**
 * Card with a tinted-square icon header (Personal Information / Address pattern).
 * Replaces the bare-AppDialog-content pattern when a dialog needs scannable
 * section grouping.
 */
export default function FormSection({
  title,
  subtitle,
  icon,
  iconColor = 'primary',
  children,
  defaultOpen = true,
  static: isStatic = false,
  compact = false,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const isMuted = iconColor === 'muted';

  // Compact: lighter top-divider header, 24x24 icon, no card chrome.
  if (compact) {
    return (
      <Box sx={{ mb: 2 }}>
        <Stack
          direction="row"
          alignItems="center"
          spacing={1}
          sx={{
            cursor: isStatic ? 'default' : 'pointer',
            py: 1,
            borderTop: (t) => `1px solid ${t.palette.divider}`,
            pt: 1.5,
            mt: 1.5,
          }}
          onClick={isStatic ? undefined : () => setOpen((v) => !v)}
          role={isStatic ? undefined : 'button'}
          aria-expanded={isStatic ? undefined : open}
        >
          <Box
            sx={{
              width: 24,
              height: 24,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: isMuted ? 'text.secondary' : `${iconColor}.main`,
              '& svg': { fontSize: 20 },
              flexShrink: 0,
            }}
          >
            {icon}
          </Box>
          <Typography variant="subtitle2" sx={{ fontWeight: 700, flex: 1, minWidth: 0 }}>
            {title}
          </Typography>
          {!isStatic && (
            <IconButton size="small" aria-label={open ? 'Collapse section' : 'Expand section'}>
              {open ? <ExpandLessOutlinedIcon fontSize="small" /> : <ExpandMoreOutlinedIcon fontSize="small" />}
            </IconButton>
          )}
        </Stack>
        {subtitle && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', ml: 4, mb: 1 }}>
            {subtitle}
          </Typography>
        )}
        <Collapse in={open} unmountOnExit>
          <Box sx={{ pt: 1 }}>{children}</Box>
        </Collapse>
      </Box>
    );
  }

  return (
    <Paper variant="outlined" sx={{ p: 0, mb: 2, overflow: 'hidden' }}>
      <Stack
        direction="row"
        alignItems="center"
        spacing={1.5}
        sx={{
          px: 2,
          py: 1.5,
          cursor: isStatic ? 'default' : 'pointer',
        }}
        onClick={isStatic ? undefined : () => setOpen((v) => !v)}
        role={isStatic ? undefined : 'button'}
        aria-expanded={isStatic ? undefined : open}
      >
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: 1,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            bgcolor: (theme) => isMuted
              ? theme.palette.action.hover
              : `${theme.palette[iconColor].main}1f`,
            color: (theme) => isMuted
              ? theme.palette.text.secondary
              : theme.palette[iconColor].main,
            flexShrink: 0,
          }}
        >
          {icon}
        </Box>
        <Stack sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.3 }}>
            {title}
          </Typography>
          {subtitle && (
            <Typography variant="body2" color="text.secondary">
              {subtitle}
            </Typography>
          )}
        </Stack>
        {!isStatic && (
          <IconButton size="small" aria-label={open ? 'Collapse section' : 'Expand section'}>
            {open ? <ExpandLessOutlinedIcon /> : <ExpandMoreOutlinedIcon />}
          </IconButton>
        )}
      </Stack>
      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: 2, pb: 2, pt: 0 }}>{children}</Box>
      </Collapse>
    </Paper>
  );
}
