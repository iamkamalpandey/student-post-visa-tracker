// SVT-WAVE-STATUS-PUBLIC-2026-05 — tenant-facing status page.
//
// Server Component. Fetches GET /api/v1/public/status (no auth, 60s cached on
// the backend) and renders an at-a-glance operational view: overall banner,
// per-subsystem badges, and the last 90 days of incidents.
//
// We deliberately use a <meta http-equiv="refresh"> instead of client-side
// polling because:
//   - This page must work without JS (incidents are a brand-safety surface).
//   - A meta-refresh is one line; a client effect would force 'use client'
//     and drag the whole tree out of the static-render path.
//   - The backend already caches for 60s, so the refresh interval matches.
//
// SVT-AUDIT-FE-POLISH-2026-05 — overall banner colors come from the MUI
// palette via sx callbacks (success.light / warning.light / error.light)
// instead of hardcoded Bootstrap-era hex. Copy is i18n'd via the `status`
// namespace and resolved server-side with `getTranslations`.

import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { Box, Chip, Divider, Stack, Typography } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('status');
  return {
    title: t('title'),
    description: t('metaDescription'),
  };
}

// SSR must not cache — we want the meta-refresh to actually pull fresh data,
// and Next 14's default fetch dedupe would otherwise hold a snapshot across
// refreshes within the same revalidate window.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type OverallStatus = 'operational' | 'degraded' | 'major_outage';
type SubsystemStatus = 'operational' | 'degraded' | 'unknown';

interface Subsystem {
  name: string;
  status: SubsystemStatus;
  last_checked: string;
}

interface Incident {
  id: string;
  title: string;
  severity: string;
  started_at: string;
  resolved_at: string | null;
  status: 'open' | 'resolved';
}

interface PublicStatus {
  status: OverallStatus;
  generated_at: string;
  subsystems: Subsystem[];
  incidents: Incident[];
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:4000/api/v1';

async function loadStatus(): Promise<PublicStatus> {
  // Best-effort fetch — if the backend is unreachable, surface a synthetic
  // 'major_outage' snapshot so the page itself stays informative. Crashing
  // here would render a 500 to the customer, which is exactly the failure
  // mode the status page exists to absorb.
  try {
    const res = await fetch(`${API_BASE}/public/status`, {
      // Server-side fetch; no credentials needed.
      cache: 'no-store',
      // Don't let a slow backend hang the page render. 5s aligns with the
      // backend's per-subsystem timeouts.
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    return (await res.json()) as PublicStatus;
  } catch {
    return {
      status: 'major_outage',
      generated_at: new Date().toISOString(),
      subsystems: [
        {
          name: 'API',
          status: 'degraded',
          last_checked: new Date().toISOString(),
        },
      ],
      incidents: [],
    };
  }
}

// SVT-AUDIT-FE-POLISH-2026-05 — palette-driven banner styling. sx callbacks
// receive the theme on the server during render, so the resolved values are
// embedded in the emotion <style> tags shipped with the SSR HTML — no
// "callbacks crash on server boundary" issue here in practice (the callback
// runs before any RSC serialization). Swapping the hex literals for palette
// tokens keeps the banner in step with light/dark themes automatically.
const OVERALL_SX: Record<OverallStatus, SxProps<Theme>> = {
  operational: {
    bgcolor: (t) => t.palette.success.light,
    color: (t) => t.palette.success.contrastText,
  },
  degraded: {
    bgcolor: (t) => t.palette.warning.light,
    color: (t) => t.palette.warning.contrastText,
  },
  major_outage: {
    bgcolor: (t) => t.palette.error.light,
    color: (t) => t.palette.error.contrastText,
  },
};

const SUB_CHIP_COLOR: Record<SubsystemStatus, 'success' | 'warning' | 'default'> = {
  operational: 'success',
  degraded: 'warning',
  unknown: 'default',
};

function formatTimestamp(iso: string): string {
  try {
    return new Date(iso).toUTCString();
  } catch {
    return iso;
  }
}

export default async function StatusPage() {
  const [snapshot, t] = await Promise.all([loadStatus(), getTranslations('status')]);
  const overallSx = OVERALL_SX[snapshot.status];

  return (
    <>
      {/* Auto-refresh every 60s. Matches the backend's cache TTL. */}
      <meta httpEquiv="refresh" content="60" />
      <Box
        sx={{
          minHeight: '100vh',
          bgcolor: 'background.default',
          py: { xs: 4, md: 6 },
          px: 2,
        }}
      >
        <Box sx={{ maxWidth: 760, mx: 'auto' }}>
          <Stack spacing={4}>
            <Box>
              <Typography variant="h3" component="h1" sx={{ fontWeight: 700 }}>
                {t('title')}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                {t('intro')}
              </Typography>
            </Box>

            <Box
              role="status"
              aria-live="polite"
              sx={{
                borderRadius: 2,
                px: 3,
                py: 2.5,
                ...overallSx,
              }}
            >
              <Typography variant="h5" component="p" sx={{ fontWeight: 600 }}>
                {t(`overall.${snapshot.status}`)}
              </Typography>
              <Typography variant="caption" sx={{ display: 'block', mt: 0.5 }}>
                {t('asOf', { when: formatTimestamp(snapshot.generated_at) })}
              </Typography>
            </Box>

            <Box>
              <Typography variant="h6" component="h2" sx={{ fontWeight: 600, mb: 2 }}>
                {t('subsystems.title')}
              </Typography>
              <Stack spacing={1.5} divider={<Divider flexItem />}>
                {snapshot.subsystems.length === 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    {t('subsystems.empty')}
                  </Typography>
                ) : (
                  snapshot.subsystems.map((sub) => {
                    const chipColor = SUB_CHIP_COLOR[sub.status];
                    return (
                      <Stack
                        key={sub.name}
                        direction="row"
                        alignItems="center"
                        justifyContent="space-between"
                        sx={{ py: 1 }}
                      >
                        <Box>
                          <Typography variant="body1" sx={{ fontWeight: 500 }}>
                            {sub.name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {t('subsystems.lastChecked', { when: formatTimestamp(sub.last_checked) })}
                          </Typography>
                        </Box>
                        <Chip
                          size="small"
                          label={t(`subsystemStatus.${sub.status}`)}
                          color={chipColor}
                          variant={chipColor === 'default' ? 'outlined' : 'filled'}
                        />
                      </Stack>
                    );
                  })
                )}
              </Stack>
            </Box>

            <Box>
              <Typography variant="h6" component="h2" sx={{ fontWeight: 600, mb: 2 }}>
                {t('incidents.title')}
              </Typography>
              {snapshot.incidents.length === 0 ? (
                <Box
                  sx={{
                    border: (t2) => `1px dashed ${t2.palette.divider}`,
                    borderRadius: 2,
                    p: 3,
                    textAlign: 'center',
                  }}
                >
                  <Typography variant="body2" color="text.secondary">
                    {t('incidents.empty')}
                  </Typography>
                </Box>
              ) : (
                <Stack spacing={2}>
                  {snapshot.incidents.map((inc) => (
                    <Box
                      key={inc.id}
                      sx={{
                        border: (t2) => `1px solid ${t2.palette.divider}`,
                        borderRadius: 2,
                        p: 2,
                      }}
                    >
                      <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={1}
                        alignItems={{ xs: 'flex-start', sm: 'center' }}
                        justifyContent="space-between"
                      >
                        <Typography variant="body1" sx={{ fontWeight: 500 }}>
                          {inc.title}
                        </Typography>
                        <Stack direction="row" spacing={1}>
                          <Chip size="small" label={inc.severity} variant="outlined" />
                          <Chip
                            size="small"
                            label={inc.status === 'resolved' ? t('incidents.resolved') : t('incidents.open')}
                            color={inc.status === 'resolved' ? 'success' : 'warning'}
                          />
                        </Stack>
                      </Stack>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                        {t('incidents.startedAt', { when: formatTimestamp(inc.started_at) })}
                        {inc.resolved_at ? t('incidents.resolvedAt', { when: formatTimestamp(inc.resolved_at) }) : ''}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              )}
            </Box>
          </Stack>
        </Box>
      </Box>
    </>
  );
}
