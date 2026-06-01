'use client';

// Shared KPI tile. Replaces 2 near-identical implementations that were drifting:
//   - apps/frontend/app/(app)/institutions/Client.tsx::KpiTile  (canonical visual)
//   - apps/frontend/app/(app)/super-agents/Client.tsx::KpiTile
//
// Intentionally NOT consolidating:
//   - inbox/Client.tsx::KpiTile — tabs-as-tiles UX with active border, severity
//     accents on warning state, role="button" semantics; distinct affordance.
//   - DashboardClient.tsx::KpiCard — h3 typography, accent palette tied to
//     dashboard's tighter colour system; consolidation would lose the visual
//     hierarchy the dashboard depends on.
//
// Visual taxonomy (locked):
//   * 40x40 muted icon tile (action.hover bg, text.secondary icon)
//   * h5 700-weight value
//   * caption label, optional " · hint" suffix
//   * Card outlined surface, full-width-flex via flex: 1
//
// API:
//   - value: string | number — primary metric
//   - hint: string — appended to label with a " · " separator (e.g. "refreshing…")
//   - href: string — optional click-through; wraps in CardActionArea for keyboard
//     parity
//   - intent: 'default' | 'warning' | 'error' — accent tone on the icon tile
//     for time-sensitive widgets (overdue counts etc.)
//
// Accessibility: when `href` is set we render an `<a>` via Next.Link so screen
// readers announce the navigation target. When absent the tile is a passive
// figure (Card) with no implicit role beyond that.
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Box, Card, CardActionArea, CardContent, Stack, Typography } from '@mui/material';

export type KpiIntent = 'default' | 'warning' | 'error';

const INTENT_BG: Record<KpiIntent, string> = {
  default: 'action.hover',
  warning: 'warning.lighter',
  error: 'error.lighter',
};
const INTENT_COLOR: Record<KpiIntent, string> = {
  default: 'text.secondary',
  warning: 'warning.dark',
  error: 'error.dark',
};

export type KpiTileProps = {
  icon: ReactNode;
  label: string;
  value: string | number;
  hint?: string;
  href?: string;
  intent?: KpiIntent;
};

export default function KpiTile({ icon, label, value, hint, href, intent = 'default' }: KpiTileProps) {
  const body = (
    <CardContent>
      <Stack direction="row" alignItems="center" spacing={1.5}>
        <Box
          sx={{
            width: 40,
            height: 40,
            borderRadius: 1,
            bgcolor: INTENT_BG[intent],
            color: INTENT_COLOR[intent],
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {icon}
        </Box>
        <Stack sx={{ minWidth: 0 }}>
          <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
            {value}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
            {label}
            {hint ? ` · ${hint}` : ''}
          </Typography>
        </Stack>
      </Stack>
    </CardContent>
  );

  if (href) {
    return (
      <Card variant="outlined" sx={{ flex: 1, minWidth: 0 }}>
        <CardActionArea LinkComponent={Link} href={href} sx={{ height: '100%' }}>
          {body}
        </CardActionArea>
      </Card>
    );
  }
  return (
    <Card variant="outlined" sx={{ flex: 1, minWidth: 0 }}>
      {body}
    </Card>
  );
}
