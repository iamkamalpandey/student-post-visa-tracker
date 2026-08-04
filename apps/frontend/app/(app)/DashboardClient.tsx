'use client';

import { useEffect, useMemo, useState } from 'react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  Alert,
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Collapse,
  Divider,
  IconButton,
  Link as MuiLink,
  Skeleton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import CloseIcon from '@mui/icons-material/Close';
import CheckCircleOutlinedIcon from '@mui/icons-material/CheckCircleOutlined';
import RadioButtonUncheckedOutlinedIcon from '@mui/icons-material/RadioButtonUncheckedOutlined';
import RocketLaunchOutlinedIcon from '@mui/icons-material/RocketLaunchOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined';
import EventBusyOutlinedIcon from '@mui/icons-material/EventBusyOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import EventAvailableOutlinedIcon from '@mui/icons-material/EventAvailableOutlined';
import TimelineOutlinedIcon from '@mui/icons-material/TimelineOutlined';
import PersonAddAlt1OutlinedIcon from '@mui/icons-material/PersonAddAlt1Outlined';
import CloudUploadOutlinedIcon from '@mui/icons-material/CloudUploadOutlined';
import InboxOutlinedIcon from '@mui/icons-material/InboxOutlined';
import MarkChatUnreadOutlinedIcon from '@mui/icons-material/MarkChatUnreadOutlined';
import ArrowForwardOutlinedIcon from '@mui/icons-material/ArrowForwardOutlined';
import HourglassBottomOutlinedIcon from '@mui/icons-material/HourglassBottomOutlined';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useStages, useTenant, type StageLookup } from '@/lib/queries';
import StageChip from '@/components/StageChip';
import EmptyState from '@/components/EmptyState';
import DensityToggle from '@/components/DensityToggle';
import { formatDate, formatRelative, initials, useFormat } from '@/lib/format';
import { safeHref } from '@/lib/safeHref';
import { useDensity } from '@/lib/useDensity';
import { usePrefetchStudent } from '@/lib/usePrefetchStudent';

// ---------------------------------------------------------------------------
// Types matching /api/v1/dashboard/summary
// ---------------------------------------------------------------------------

type ByStage = { stage_id: string; count: number };
type ByStatus = { status: string; count: number };
type RecentEvent = {
  id: string;
  student_id: string;
  to_stage_id: string | null;
  occurred_at: string;
  notes?: string | null;
  actor_id?: string | null;
};
type UpcomingExpiry = {
  kind: string;
  entity_id: string;
  student_id: string;
  expires_on: string;
  days_remaining: number;
};

type DashboardSummary = {
  by_stage: ByStage[];
  by_status: ByStatus[];
  recent_events: RecentEvent[];
  upcoming_expiries: UpcomingExpiry[];
  upcoming_expiries_total: number;
  unread_messages_count?: number;
};

// SVT-WAVE60-ONBOARDING-2026-05 — first-run checklist payload from
// /api/v1/dashboard/onboarding. The 8 steps are computed server-side; the
// dashboard only renders + tracks dismissal client-side.
type OnboardingStep = {
  id: string;
  label: string;
  complete: boolean;
  action_url: string;
};
type OnboardingPayload = {
  steps: OnboardingStep[];
  complete_count: number;
};

// SVT-WAVE33-SLA-2026-05
type SlaBreachRow = {
  student_id: string;
  student_code: string;
  given_name: string;
  family_name: string;
  stage_id: string;
  stage_key: string;
  stage_label: string;
  stage_color_hex: string | null;
  sla_hours: number;
  stage_entered_at: string;
  hours_over_sla: number;
  assigned_to_id: string | null;
};

// SVT-WAVE-ENGAGEMENT-2026-06 — attendance / engagement at-risk row.
type EngagementRiskRow = {
  student_id: string;
  student_code: string;
  given_name: string;
  family_name: string;
  assigned_to_id: string | null;
  total_count: number;
  present_count: number;
  absent_count: number;
  attendance_rate: number; // 0..1
  last_check_date: string | null;
};

function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

// SVT-QA-2026-08 — was: hardcoded 'Default Tenant'. Now hydrated from
// GET /tenants/me (admin-only route; falls back to '—' for non-admin
// callers who can't read the tenant record).

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

type KpiCardProps = {
  label: string;
  value: number | null;
  trend?: string;
  icon: React.ReactNode;
  loading?: boolean;
  accent?: string;
};

function KpiCard({ label, value, trend, icon, loading, accent }: KpiCardProps) {
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" alignItems="center" justifyContent="space-between">
            <Typography
              variant="caption"
              sx={{
                fontWeight: 600,
                letterSpacing: 0.8,
                textTransform: 'uppercase',
                color: 'text.secondary',
              }}
            >
              {label}
            </Typography>
            <Box
              sx={{
                width: 36,
                height: 36,
                borderRadius: 2,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                bgcolor: accent ?? 'action.hover',
                color: accent ? '#fff' : 'text.secondary',
              }}
            >
              {icon}
            </Box>
          </Stack>
          {loading ? (
            <Skeleton variant="text" width={96} height={56} />
          ) : (
            <Typography
              variant="h3"
              sx={{
                fontWeight: 600,
                lineHeight: 1.05,
                letterSpacing: -0.5,
                color: 'primary.main',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {value ?? 0}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary">
            {trend ?? ''}
          </Typography>
        </Stack>
      </CardContent>
    </Card>
  );
}

function SectionCard({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card variant="outlined" sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <Box sx={{ px: 3, pt: 2.5, pb: 2 }}>
        <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2}>
          <Stack spacing={0.25}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              {title}
            </Typography>
            {subtitle ? (
              <Typography variant="body2" color="text.secondary">
                {subtitle}
              </Typography>
            ) : null}
          </Stack>
          {action}
        </Stack>
      </Box>
      <Divider />
      <Box sx={{ flex: 1, p: 3 }}>{children}</Box>
    </Card>
  );
}

function normaliseHex(hex: string | null | undefined, fallback = '#74777F'): string {
  if (!hex) return fallback;
  const trimmed = hex.trim();
  if (!/^#?[0-9a-f]{6}$/i.test(trimmed)) return fallback;
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
}

type StageSegment = {
  stage: StageLookup;
  count: number;
  pct: number;
};

function PipelineBar({
  segments,
  total,
}: {
  segments: StageSegment[];
  total: number;
}) {
  const fmt = useFormat();
  const t = useTranslations('dashboard.pipeline');
  if (total === 0) {
    return (
      <EmptyState
        icon={<TimelineOutlinedIcon fontSize="medium" />}
        title={t('emptyTitle')}
        description={t('emptyDescription')}
      />
    );
  }
  return (
    <Stack spacing={2.5}>
      <Box
        sx={{
          width: '100%',
          height: 28,
          borderRadius: 999,
          overflow: 'hidden',
          display: 'flex',
          bgcolor: 'action.hover',
        }}
      >
        {segments.map(({ stage, count, pct }) => {
          const color = normaliseHex(stage.color_hex);
          return (
            <Tooltip
              key={stage.id}
              title={`${stage.label}: ${count} (${fmt.percent(pct)})`}
              arrow
            >
              <Box
                sx={{
                  width: `${pct}%`,
                  background: `linear-gradient(180deg, ${color} 0%, ${color}dd 100%)`,
                  transition: 'filter 150ms ease',
                  '&:hover': { filter: 'brightness(1.08)' },
                  cursor: 'default',
                }}
              />
            </Tooltip>
          );
        })}
      </Box>
      <Box
        sx={{
          display: 'grid',
          gap: 1.25,
          gridTemplateColumns: {
            xs: '1fr',
            sm: 'repeat(2, 1fr)',
            md: 'repeat(3, 1fr)',
          },
        }}
      >
        {segments.map(({ stage, count, pct }) => (
          <Stack
            key={stage.id}
            direction="row"
            alignItems="center"
            spacing={1}
            sx={{ minWidth: 0 }}
          >
            <Box
              sx={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                bgcolor: normaliseHex(stage.color_hex),
                flexShrink: 0,
              }}
            />
            <Typography
              variant="body2"
              sx={{
                fontWeight: 500,
                color: 'text.primary',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                minWidth: 0,
                flex: 1,
              }}
            >
              {stage.label}
            </Typography>
            <Typography
              variant="caption"
              color="text.secondary"
              sx={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}
            >
              {count} · {fmt.percent(pct)}
            </Typography>
          </Stack>
        ))}
      </Box>
    </Stack>
  );
}

// ---------- Expiry helpers ------------------------------------------------

const KIND_COLORS: Record<string, { bg: string; fg: string; key: 'visa' | 'passport' | 'insurance' | 'document' }> = {
  visa: { bg: '#E0F2FE', fg: '#075985', key: 'visa' },
  passport: { bg: '#EDE9FE', fg: '#5B21B6', key: 'passport' },
  insurance: { bg: '#DCFCE7', fg: '#166534', key: 'insurance' },
  document: { bg: '#FEF3C7', fg: '#854D0E', key: 'document' },
};

function KindChip({ kind }: { kind: string }) {
  const t = useTranslations('dashboard.expiries.kinds');
  const cfg = KIND_COLORS[kind.toLowerCase()];
  const label = cfg
    ? t(cfg.key)
    : kind.charAt(0).toUpperCase() + kind.slice(1);
  return (
    <Chip
      size="small"
      label={label}
      sx={{
        bgcolor: cfg?.bg ?? '#E2E8F0',
        color: cfg?.fg ?? '#334155',
        fontWeight: 600,
        height: 22,
        '& .MuiChip-label': { px: 1, fontSize: 11 },
      }}
    />
  );
}

function DaysBadge({ days }: { days: number }) {
  const t = useTranslations('dashboard.expiries');
  let color: { bg: string; fg: string };
  if (days < 14) color = { bg: '#FEE2E2', fg: '#991B1B' };
  else if (days < 30) color = { bg: '#FEF3C7', fg: '#92400E' };
  else color = { bg: '#DCFCE7', fg: '#166534' };
  const label = days <= 0 ? t('today') : days === 1 ? t('oneDay') : t('days', { count: days });
  return (
    <Box
      component="span"
      sx={{
        bgcolor: color.bg,
        color: color.fg,
        fontWeight: 600,
        px: 1,
        py: 0.25,
        borderRadius: 1,
        fontSize: 11,
        fontVariantNumeric: 'tabular-nums',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function DashboardClient() {
  const router = useRouter();
  const { user, isLoading: authLoading } = useAuth();
  const fmt = useFormat();
  const [errorDismissed, setErrorDismissed] = useState(false);
  const t = useTranslations('dashboard');
  // GET /tenants/me is ADMIN-only. useTenant() no-ops when disabled=false.
  const tenantQuery = useTenant(user?.role === 'ADMIN');
  const tenantName = tenantQuery.data?.name ?? '';
  const tPipeline = useTranslations('dashboard.pipeline');
  const tRecent = useTranslations('dashboard.recent');
  const tExp = useTranslations('dashboard.expiries');
  const tQuick = useTranslations('dashboard.quick');
  const tKpi = useTranslations('dashboard.kpi');
  const [density] = useDensity();
  const compact = density === 'compact';
  const prefetch = usePrefetchStudent();

  const summaryQuery = useQuery<DashboardSummary>({
    queryKey: ['dashboard', 'summary'],
    queryFn: async () => {
      const res = await api.get('/dashboard/summary');
      return unwrap<DashboardSummary>(res.data);
    },
    staleTime: 30_000,
  });

  // SVT-WAVE33-SLA-2026-05 — top breaches surface. Cheap server-side compute
  // (capped at 200 students across SLA-bearing stages); we read at most 10 for
  // the widget. Independent query so the rest of the dashboard renders even
  // when no SLA stages are configured.
  const slaQuery = useQuery<{ data: SlaBreachRow[]; page: { total: number } }>({
    queryKey: ['dashboard', 'sla-breaches'],
    queryFn: async () => {
      const res = await api.get('/dashboard/sla-breaches', { params: { limit: 10 } });
      return res.data as { data: SlaBreachRow[]; page: { total: number } };
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // SVT-WAVE-ENGAGEMENT-2026-06 — attendance at-risk surface. Server scopes a
  // counsellor to their own caseload; shown to all roles (not admin-gated).
  // Independent query so the rest of the dashboard renders even when no
  // engagement checks have been recorded yet.
  const engagementQuery = useQuery<{ data: EngagementRiskRow[]; page: { total: number } }>({
    queryKey: ['dashboard', 'engagement-at-risk'],
    queryFn: async () => {
      const res = await api.get('/dashboard/engagement-at-risk', { params: { limit: 10 } });
      return res.data as { data: EngagementRiskRow[]; page: { total: number } };
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  // SVT-WAVE36-BREACH-DASH-2026-05 — admin-only GDPR-72h widget. Counsellor/
  // viewer roles don't access /breach-incidents; gate the fetch so they
  // don't hit a 403 on every dashboard mount.
  const isAdmin = (user?.role ?? '').toUpperCase() === 'ADMIN';
  const breachQuery = useQuery<{ data: { open: number; overdue: number; due_within_24h: number } }>({
    queryKey: ['dashboard', 'breach-summary'],
    enabled: isAdmin,
    queryFn: async () => {
      const res = await api.get('/breach-incidents/dashboard-summary');
      return res.data as { data: { open: number; overdue: number; due_within_24h: number } };
    },
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  // SVT-WAVE37-DSAR-DASH-2026-05 — admin-only DSAR 30-day clock surface.
  const dsarQuery = useQuery<{ data: { open: number; overdue: number; due_within_3d: number } }>({
    queryKey: ['dashboard', 'dsar-summary'],
    enabled: isAdmin,
    queryFn: async () => {
      const res = await api.get('/dsar/dashboard-summary');
      return res.data as { data: { open: number; overdue: number; due_within_3d: number } };
    },
    staleTime: 60_000,
    placeholderData: (prev) => prev,
  });

  // SVT-WAVE60-ONBOARDING-2026-05 — first-run setup checklist. Cheap (8
   // counts behind a 60s per-tenant cache). VIEWER role gets a 403; gate the
   // query so the dashboard doesn't show a spurious error banner.
  const canSeeOnboarding =
    (user?.role ?? '').toUpperCase() === 'ADMIN' ||
    (user?.role ?? '').toUpperCase() === 'COUNSELLOR';
  const onboardingQuery = useQuery<OnboardingPayload>({
    queryKey: ['dashboard', 'onboarding'],
    enabled: canSeeOnboarding,
    queryFn: async () => {
      const res = await api.get('/dashboard/onboarding');
      return unwrap<OnboardingPayload>(res.data);
    },
    staleTime: 60_000,
  });

  // Dismissal flag is purely client-side: once an admin completes every
  // step, store a flag in localStorage so we never re-render the card —
  // even if a future data-mutation transiently lowers complete_count
  // (e.g. soft-deleted last student). SSR-safe: initialise to false and
  // hydrate from storage in an effect.
  const ONBOARDING_DISMISSED_KEY = 'spv:onboarding-dismissed';
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  useEffect(() => {
    try {
      if (typeof window === 'undefined') return;
      if (window.localStorage.getItem(ONBOARDING_DISMISSED_KEY) === '1') {
        setOnboardingDismissed(true);
      }
    } catch {
      // localStorage may throw in private-mode / SSR — treat as not dismissed.
    }
  }, []);
  useEffect(() => {
    if (!onboardingQuery.data) return;
    if (onboardingQuery.data.complete_count !== onboardingQuery.data.steps.length) return;
    if (onboardingDismissed) return;
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(ONBOARDING_DISMISSED_KEY, '1');
      }
    } catch {
      // ignore write failures (private mode)
    }
    setOnboardingDismissed(true);
  }, [onboardingQuery.data, onboardingDismissed]);

  const stagesQuery = useStages();

  const stagesById = useMemo(() => {
    const map = new Map<string, StageLookup>();
    (stagesQuery.data ?? []).forEach((s) => map.set(s.id, s));
    return map;
  }, [stagesQuery.data]);

  const summary = summaryQuery.data;
  const loading = summaryQuery.isLoading || stagesQuery.isLoading;
  const errorMessage = summaryQuery.error
    ? (summaryQuery.error as Error).message
    : stagesQuery.error
      ? (stagesQuery.error as Error).message
      : null;

  // ----- KPI derivations -------------------------------------------------
  const totalStudents = useMemo(
    () => (summary?.by_status ?? []).reduce((sum, s) => sum + (s.count ?? 0), 0),
    [summary?.by_status],
  );
  const activeStudents = useMemo(
    () =>
      (summary?.by_status ?? []).find((s) => s.status?.toUpperCase() === 'ACTIVE')?.count ?? 0,
    [summary?.by_status],
  );
  const upcomingTotal = summary?.upcoming_expiries_total ?? 0;
  const recentCount = summary?.recent_events?.length ?? 0;
  const unreadMessages = summary?.unread_messages_count ?? 0;

  // ----- Pipeline segments ----------------------------------------------
  const pipelineSegments = useMemo<StageSegment[]>(() => {
    if (!summary?.by_stage) return [];
    const stagesList = stagesQuery.data ?? [];
    const totalsById = new Map<string, number>();
    summary.by_stage.forEach((b) => {
      totalsById.set(b.stage_id, (totalsById.get(b.stage_id) ?? 0) + (b.count ?? 0));
    });
    const total = Array.from(totalsById.values()).reduce((a, b) => a + b, 0);
    if (total === 0) return [];
    // Ordered by the canonical stage sequence; fall back to count desc for unknown ids.
    const known = stagesList
      .filter((s) => (totalsById.get(s.id) ?? 0) > 0)
      .sort((a, b) => a.sequence - b.sequence)
      .map<StageSegment>((stage) => {
        const count = totalsById.get(stage.id) ?? 0;
        return { stage, count, pct: (count / total) * 100 };
      });
    const knownIds = new Set(known.map((s) => s.stage.id));
    const unknown = summary.by_stage
      .filter((b) => !knownIds.has(b.stage_id) && (b.count ?? 0) > 0)
      .map<StageSegment>((b) => ({
        stage: {
          id: b.stage_id,
          key: 'unknown',
          label: 'Unassigned',
          sequence: 999,
          category: 'OTHER',
          is_initial: false,
          is_terminal: false,
          color_hex: '#9AA0A6',
        },
        count: b.count,
        pct: (b.count / total) * 100,
      }));
    return [...known, ...unknown];
  }, [summary?.by_stage, stagesQuery.data]);

  const pipelineTotal = pipelineSegments.reduce((a, b) => a + b.count, 0);

  // ----- Today header ----------------------------------------------------
  // SVT-QA-2026-08 — `new Date()` inside a useMemo runs during SSR too; the
  // server rendered `today` in the deployment's timezone (typically UTC) while
  // the client re-computed in the user's timezone. Across a midnight boundary
  // (or where fmt.timezone diverges from the server default) that produced
  // different strings and tripped React #418 (hydration mismatch), which in
  // turn delayed event-handler attachment and manifested as the reported
  // "first click doesn't register" behaviour. Defer to a post-mount effect so
  // the SSR HTML never contains a locale-dependent date fragment.
  const [today, setToday] = useState<string>('');
  useEffect(() => {
    setToday(
      new Intl.DateTimeFormat(fmt.locale, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: fmt.timezone,
      }).format(new Date()),
    );
  }, [fmt.locale, fmt.timezone]);

  const givenName = user?.given_name?.trim() || t('welcomeFallback');
  const userInitials = initials(user?.given_name ?? undefined, user?.family_name ?? undefined);

  // ----- Render ---------------------------------------------------------

  return (
    <Stack spacing={compact ? 2 : 3}>
      {/* Welcome hero strip */}
      <Card
        variant="outlined"
        sx={{
          borderRadius: 3,
          background: (t) =>
            `linear-gradient(135deg, ${t.palette.primary.light} 0%, ${t.palette.background.paper} 70%)`,
        }}
      >
        <CardContent sx={{ py: 3 }}>
          <Stack
            direction={{ xs: 'column', sm: 'row' }}
            spacing={2}
            alignItems={{ xs: 'flex-start', sm: 'center' }}
            justifyContent="space-between"
          >
            <Stack spacing={0.5}>
              {authLoading ? (
                <Skeleton variant="text" width={320} height={40} />
              ) : (
                <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.3 }}>
                  {t('welcomeBack', { name: givenName })}
                </Typography>
              )}
              <Typography variant="body1" color="text.secondary">
                {tenantName ? `${tenantName} · ${today}` : today}
              </Typography>
            </Stack>
            <Stack direction="row" spacing={1} alignItems="center">
              <DensityToggle />
              <Avatar
                sx={{
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  width: 48,
                  height: 48,
                  fontWeight: 600,
                  fontSize: 18,
                }}
              >
                {userInitials}
              </Avatar>
            </Stack>
          </Stack>
        </CardContent>
      </Card>

      {/* SVT-WAVE60-ONBOARDING-2026-05 — first-run "Get started" card.
          Renders only while incomplete and not dismissed. Dismissal is
          permanent (localStorage); see the effect above for auto-dismiss
          on full completion. */}
      {canSeeOnboarding &&
      onboardingQuery.data &&
      !onboardingDismissed &&
      onboardingQuery.data.complete_count < onboardingQuery.data.steps.length ? (
        <Card variant="outlined" sx={{ borderRadius: 3 }}>
          <CardContent sx={{ py: 2.5 }}>
            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={2}
              alignItems={{ xs: 'flex-start', sm: 'center' }}
              justifyContent="space-between"
              sx={{ mb: 1.5 }}
            >
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Box
                  sx={{
                    width: 40,
                    height: 40,
                    borderRadius: 2,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    bgcolor: 'primary.main',
                    color: 'primary.contrastText',
                  }}
                >
                  <RocketLaunchOutlinedIcon fontSize="small" />
                </Box>
                <Stack spacing={0.25}>
                  <Typography variant="h6" sx={{ fontWeight: 600 }}>
                    Get started
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    {onboardingQuery.data.complete_count} of{' '}
                    {onboardingQuery.data.steps.length} steps complete
                  </Typography>
                </Stack>
              </Stack>
            </Stack>
            <Divider sx={{ mb: 1.5 }} />
            <Stack spacing={0.5}>
              {onboardingQuery.data.steps.map((step) => (
                <MuiLink
                  key={step.id}
                  component={NextLink}
                  // SVT-SEC-P1-FE1-2026-05 — onboarding action_url is server-derived
                  // today but is rendered as a click target so we still gate it
                  // through the scheme allowlist (relative `/foo` is permitted).
                  href={safeHref(step.action_url) ?? '/'}
                  underline="none"
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1.25,
                    py: 0.75,
                    px: 1,
                    borderRadius: 1,
                    color: step.complete ? 'text.secondary' : 'text.primary',
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  {step.complete ? (
                    <CheckCircleOutlinedIcon
                      fontSize="small"
                      sx={{ color: 'success.main' }}
                    />
                  ) : (
                    <RadioButtonUncheckedOutlinedIcon
                      fontSize="small"
                      sx={{ color: 'action.active' }}
                    />
                  )}
                  <Typography
                    variant="body2"
                    sx={{
                      fontWeight: step.complete ? 400 : 500,
                      textDecoration: step.complete ? 'line-through' : 'none',
                      flex: 1,
                    }}
                  >
                    {step.label}
                  </Typography>
                  {!step.complete ? (
                    <ArrowForwardOutlinedIcon
                      fontSize="inherit"
                      sx={{ color: 'text.secondary' }}
                    />
                  ) : null}
                </MuiLink>
              ))}
            </Stack>
          </CardContent>
        </Card>
      ) : null}

      {/* Error banner (collapsable) */}
      <Collapse in={Boolean(errorMessage) && !errorDismissed} unmountOnExit>
        <Alert
          severity="error"
          action={
            <IconButton
              size="small"
              color="inherit"
              onClick={() => setErrorDismissed(true)}
              aria-label={t('dismissError')}
            >
              <CloseIcon fontSize="small" />
            </IconButton>
          }
        >
          {t('errorBanner', { message: errorMessage ?? '' })}
        </Alert>
      </Collapse>

      {/* KPI cards */}
      <Grid container spacing={compact ? 2 : 3}>
        <Grid item xs={12} md={6} lg={3}>
          <KpiCard
            label={tKpi('totalStudents')}
            value={totalStudents}
            trend={tKpi('vsLast30')}
            icon={<GroupsOutlinedIcon fontSize="small" />}
            loading={loading}
          />
        </Grid>
        <Grid item xs={12} md={6} lg={3}>
          <KpiCard
            label={tKpi('activeStudents')}
            value={activeStudents}
            trend={tKpi('vsLast30')}
            icon={<VerifiedOutlinedIcon fontSize="small" />}
            loading={loading}
          />
        </Grid>
        <Grid item xs={12} md={6} lg={3}>
          <KpiCard
            label={tKpi('upcomingExpiries')}
            value={upcomingTotal}
            trend={tKpi('next60Days')}
            icon={<EventBusyOutlinedIcon fontSize="small" />}
            loading={loading}
          />
        </Grid>
        <Grid item xs={12} md={6} lg={3}>
          <KpiCard
            label={tKpi('recentActivity')}
            value={recentCount}
            trend={tKpi('last10Events')}
            icon={<HistoryOutlinedIcon fontSize="small" />}
            loading={loading}
          />
        </Grid>
        {/* SVT-WAVE21-DASHBOARD-2026-05 — unread comms inbox count. */}
        <Grid item xs={12} md={6} lg={3}>
          <KpiCard
            label="Unread messages"
            value={unreadMessages}
            trend={unreadMessages === 0 ? 'all caught up' : 'open bell to read'}
            icon={<MarkChatUnreadOutlinedIcon fontSize="small" />}
            loading={loading}
            accent={unreadMessages > 0 ? 'warning.main' : undefined}
          />
        </Grid>
      </Grid>

      {/* Two-column body */}
      <Grid container spacing={compact ? 2 : 3}>
        {/* Left column */}
        <Grid item xs={12} lg={8}>
          <Stack spacing={3}>
            <SectionCard
              title={tPipeline('title')}
              subtitle={
                pipelineTotal > 0
                  ? tPipeline('subtitleCount', {
                      students: tPipeline('subtitleStudents', { count: pipelineTotal }),
                      stages: tPipeline('subtitleStages', { count: pipelineSegments.length }),
                    })
                  : tPipeline('subtitleFallback')
              }
            >
              {loading ? (
                <Stack spacing={2}>
                  <Skeleton variant="rounded" height={28} />
                  <Skeleton variant="text" width="80%" />
                  <Skeleton variant="text" width="60%" />
                </Stack>
              ) : (
                <PipelineBar segments={pipelineSegments} total={pipelineTotal} />
              )}
            </SectionCard>

            <SectionCard
              title={tRecent('title')}
              subtitle={tRecent('subtitle')}
              action={
                <Button
                  component={NextLink}
                  href="/audit"
                  size="small"
                  endIcon={<ArrowForwardOutlinedIcon fontSize="small" />}
                >
                  {tRecent('auditLog')}
                </Button>
              }
            >
              {loading ? (
                <Stack spacing={1.5}>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} variant="rounded" height={56} />
                  ))}
                </Stack>
              ) : (summary?.recent_events ?? []).length === 0 ? (
                <EmptyState
                  icon={<HistoryOutlinedIcon fontSize="medium" />}
                  title={tRecent('emptyTitle')}
                  description={tRecent('emptyDescription')}
                />
              ) : (
                <Stack divider={<Divider flexItem />} spacing={0}>
                  {(summary?.recent_events ?? []).slice(0, 10).map((ev) => {
                    const stage = ev.to_stage_id ? stagesById.get(ev.to_stage_id) : undefined;
                    const studentShort = ev.student_id.slice(0, 8);
                    return (
                      <Stack
                        key={ev.id}
                        direction="row"
                        spacing={2}
                        alignItems="center"
                        sx={{ py: 1.25, minWidth: 0 }}
                      >
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Stack
                            direction="row"
                            spacing={1}
                            alignItems="center"
                            sx={{ mb: 0.25, flexWrap: 'wrap' }}
                          >
                            <MuiLink
                              component={NextLink}
                              href={`/students/${ev.student_id}`}
                              underline="hover"
                              onMouseEnter={() =>
                                prefetch.onEnter(ev.student_id, `/students/${ev.student_id}`)
                              }
                              onMouseLeave={prefetch.onLeave}
                              sx={{
                                fontWeight: 600,
                                color: 'text.primary',
                                fontSize: 14,
                                fontFamily: 'monospace',
                              }}
                            >
                              {studentShort}
                            </MuiLink>
                            <Typography variant="caption" color="text.secondary">
                              {tRecent('movedTo')}
                            </Typography>
                            {stage ? (
                              <StageChip stage={stage} />
                            ) : (
                              <Chip
                                size="small"
                                label={tRecent('unknownStage')}
                                variant="outlined"
                                sx={{ fontWeight: 600 }}
                              />
                            )}
                          </Stack>
                          {ev.notes ? (
                            <Typography
                              variant="body2"
                              color="text.secondary"
                              sx={{
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {ev.notes}
                            </Typography>
                          ) : null}
                        </Box>
                        <Tooltip title={formatDate(ev.occurred_at)} arrow>
                          <Typography
                            variant="caption"
                            color="text.secondary"
                            sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}
                          >
                            {formatRelative(ev.occurred_at)}
                          </Typography>
                        </Tooltip>
                      </Stack>
                    );
                  })}
                </Stack>
              )}
            </SectionCard>
          </Stack>
        </Grid>

        {/* Right column */}
        <Grid item xs={12} lg={4}>
          <Stack spacing={3}>
            <SectionCard
              title={tExp('title')}
              subtitle={tExp('subtitle')}
            >
              {loading ? (
                <Stack spacing={1.5}>
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} variant="rounded" height={52} />
                  ))}
                </Stack>
              ) : (summary?.upcoming_expiries ?? []).length === 0 ? (
                <EmptyState
                  icon={<EventAvailableOutlinedIcon fontSize="medium" />}
                  title={tExp('emptyTitle')}
                  description={tExp('emptyDescription')}
                />
              ) : (
                <Stack spacing={0} divider={<Divider flexItem />}>
                  {(summary?.upcoming_expiries ?? []).slice(0, 10).map((exp) => {
                    const studentShort = exp.student_id.slice(0, 8);
                    return (
                      <Stack
                        key={`${exp.kind}-${exp.entity_id}`}
                        direction="row"
                        spacing={1.5}
                        alignItems="center"
                        sx={{ py: 1.25, minWidth: 0 }}
                      >
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Stack
                            direction="row"
                            spacing={1}
                            alignItems="center"
                            sx={{ mb: 0.25 }}
                          >
                            <KindChip kind={exp.kind} />
                            <MuiLink
                              component={NextLink}
                              href={`/students/${exp.student_id}`}
                              underline="hover"
                              onMouseEnter={() =>
                                prefetch.onEnter(exp.student_id, `/students/${exp.student_id}`)
                              }
                              onMouseLeave={prefetch.onLeave}
                              sx={{
                                fontWeight: 600,
                                color: 'text.primary',
                                fontSize: 13,
                                fontFamily: 'monospace',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {studentShort}
                            </MuiLink>
                          </Stack>
                          <Typography variant="caption" color="text.secondary">
                            {formatDate(exp.expires_on)}
                          </Typography>
                        </Box>
                        <DaysBadge days={exp.days_remaining} />
                      </Stack>
                    );
                  })}
                </Stack>
              )}
              <Box sx={{ pt: 2 }}>
                <MuiLink
                  component={NextLink}
                  href="/calendar"
                  underline="hover"
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  {tExp('viewAll')}
                  <ArrowForwardOutlinedIcon fontSize="inherit" />
                </MuiLink>
              </Box>
            </SectionCard>

            {/* SVT-WAVE36-BREACH-DASH-2026-05 — GDPR 72h watchdog. Renders
                only when the admin has something to act on (open >0 OR
                overdue >0). Counsellor/viewer never see this. */}
            {isAdmin && breachQuery.data && (breachQuery.data.data.open > 0 || breachQuery.data.data.overdue > 0) ? (
              <SectionCard
                title="GDPR 72h watchdog"
                subtitle="Open breach incidents tracked against the 72h reporting clock"
                action={
                  breachQuery.data.data.overdue > 0 ? (
                    <Chip
                      size="small"
                      color="error"
                      variant="filled"
                      label={`${breachQuery.data.data.overdue} overdue`}
                    />
                  ) : (
                    <Chip
                      size="small"
                      color="success"
                      variant="outlined"
                      label="On track"
                    />
                  )
                }
              >
                <Stack
                  direction="row"
                  spacing={2}
                  alignItems="stretch"
                  divider={<Divider orientation="vertical" flexItem />}
                >
                  {[
                    { label: 'Open', value: breachQuery.data.data.open, color: 'text.primary' as const },
                    { label: 'Overdue', value: breachQuery.data.data.overdue, color: 'error.main' as const },
                    { label: 'Due ≤ 24h', value: breachQuery.data.data.due_within_24h, color: 'warning.main' as const },
                  ].map((stat) => (
                    <Box key={stat.label} sx={{ flex: 1, py: 0.5 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 600 }}>
                        {stat.label}
                      </Typography>
                      <Typography variant="h5" sx={{ fontWeight: 700, color: stat.color, lineHeight: 1.1 }}>
                        {stat.value}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
                <Box sx={{ pt: 2 }}>
                  <MuiLink
                    component={NextLink}
                    href="/breach-incidents"
                    underline="hover"
                    sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontWeight: 600, fontSize: 13 }}
                  >
                    Open breach register
                    <ArrowForwardOutlinedIcon fontSize="inherit" />
                  </MuiLink>
                </Box>
              </SectionCard>
            ) : null}

            {/* SVT-WAVE37-DSAR-DASH-2026-05 — DSAR 30-day clock. Same
                pattern as the GDPR widget; hidden when nothing actionable. */}
            {isAdmin && dsarQuery.data && (dsarQuery.data.data.open > 0 || dsarQuery.data.data.overdue > 0) ? (
              <SectionCard
                title="DSAR 30-day clock"
                subtitle="Open subject-access / portability / erasure requests"
                action={
                  dsarQuery.data.data.overdue > 0 ? (
                    <Chip
                      size="small"
                      color="error"
                      variant="filled"
                      label={`${dsarQuery.data.data.overdue} overdue`}
                    />
                  ) : (
                    <Chip
                      size="small"
                      color="success"
                      variant="outlined"
                      label="On track"
                    />
                  )
                }
              >
                <Stack
                  direction="row"
                  spacing={2}
                  alignItems="stretch"
                  divider={<Divider orientation="vertical" flexItem />}
                >
                  {[
                    { label: 'Open', value: dsarQuery.data.data.open, color: 'text.primary' as const },
                    { label: 'Overdue', value: dsarQuery.data.data.overdue, color: 'error.main' as const },
                    { label: 'Due ≤ 3d', value: dsarQuery.data.data.due_within_3d, color: 'warning.main' as const },
                  ].map((stat) => (
                    <Box key={stat.label} sx={{ flex: 1, py: 0.5 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 600 }}>
                        {stat.label}
                      </Typography>
                      <Typography variant="h5" sx={{ fontWeight: 700, color: stat.color, lineHeight: 1.1 }}>
                        {stat.value}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
                <Box sx={{ pt: 2 }}>
                  <MuiLink
                    component={NextLink}
                    href="/dsar"
                    underline="hover"
                    sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontWeight: 600, fontSize: 13 }}
                  >
                    Open DSAR register
                    <ArrowForwardOutlinedIcon fontSize="inherit" />
                  </MuiLink>
                </Box>
              </SectionCard>
            ) : null}

            {/* SVT-WAVE33-SLA-2026-05 — top breaches widget. Hidden entirely
                when there's nothing actionable so we don't waste vertical
                space on a quiet day. */}
            {(slaQuery.data?.data ?? []).length > 0 ? (
              <SectionCard
                title="SLA breaches"
                subtitle="Students past their stage SLA — worst first"
                action={
                  <Chip
                    size="small"
                    color="warning"
                    variant="outlined"
                    label={`${slaQuery.data?.page.total ?? 0} total`}
                  />
                }
              >
                <Stack spacing={0} divider={<Divider flexItem />}>
                  {(slaQuery.data?.data ?? []).slice(0, 8).map((row) => {
                    const overDays = Math.max(1, Math.round(row.hours_over_sla / 24));
                    // SVT-WAVE54-SLA-STAGE-COLOR-2026-05 — show the stage
                    // color as a vertical accent so an admin can correlate
                    // breaches to pipeline columns at a glance.
                    const stageColor = (row.stage_color_hex && /^#[0-9a-fA-F]{6}$/.test(row.stage_color_hex))
                      ? row.stage_color_hex
                      : '#FF9800';
                    return (
                      <Stack
                        key={`${row.stage_id}-${row.student_id}`}
                        direction="row"
                        spacing={1.5}
                        alignItems="center"
                        sx={{
                          py: 1.25,
                          minWidth: 0,
                          borderLeft: `3px solid ${stageColor}`,
                          pl: 1.25,
                        }}
                      >
                        <HourglassBottomOutlinedIcon
                          sx={{ color: 'warning.main', fontSize: 18 }}
                        />
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <MuiLink
                              component={NextLink}
                              href={`/students/${row.student_id}`}
                              underline="hover"
                              onMouseEnter={() =>
                                prefetch.onEnter(
                                  row.student_id,
                                  `/students/${row.student_id}`,
                                )
                              }
                              onMouseLeave={prefetch.onLeave}
                              sx={{
                                fontWeight: 600,
                                color: 'text.primary',
                                fontSize: 13,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={`${row.given_name} ${row.family_name}`}
                            >
                              {row.given_name} {row.family_name}
                            </MuiLink>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ fontFamily: 'monospace' }}
                              noWrap
                            >
                              {row.student_code}
                            </Typography>
                          </Stack>
                          <Typography variant="caption" color="text.secondary" noWrap>
                            {row.stage_label} · entered {formatRelative(row.stage_entered_at)}
                          </Typography>
                        </Box>
                        <Chip
                          size="small"
                          color="warning"
                          label={overDays >= 2 ? `+${overDays}d` : `+${Math.round(row.hours_over_sla)}h`}
                        />
                      </Stack>
                    );
                  })}
                </Stack>
                {/* SVT-WAVE40-SLA-VIEW-ALL-2026-05 — exposes the full
                    list (server-paged) when there are more breaches than
                    the dashboard widget surfaces. */}
                <Box sx={{ pt: 2 }}>
                  <MuiLink
                    component={NextLink}
                    href="/students?sla_breached=true"
                    underline="hover"
                    sx={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 0.5,
                      fontWeight: 600,
                      fontSize: 13,
                    }}
                  >
                    View all breaches
                    <ArrowForwardOutlinedIcon fontSize="inherit" />
                  </MuiLink>
                </Box>
              </SectionCard>
            ) : null}

            {/* SVT-WAVE-ENGAGEMENT-2026-06 — attendance at-risk widget. Hidden
                when nothing is actionable (no recorded checks below threshold)
                so a fully-engaged cohort doesn't show an empty card. */}
            {(engagementQuery.data?.data ?? []).length > 0 ? (
              <SectionCard
                title="Engagement at risk"
                subtitle="Students whose recent attendance has dropped — lowest first"
                action={
                  <Chip
                    size="small"
                    color="error"
                    variant="outlined"
                    label={`${engagementQuery.data?.page.total ?? 0} total`}
                  />
                }
              >
                <Stack spacing={0} divider={<Divider flexItem />}>
                  {(engagementQuery.data?.data ?? []).slice(0, 8).map((row) => {
                    const pct = Math.round(row.attendance_rate * 100);
                    return (
                      <Stack
                        key={row.student_id}
                        direction="row"
                        spacing={1.5}
                        alignItems="center"
                        sx={{
                          py: 1.25,
                          minWidth: 0,
                          borderLeft: '3px solid #EF5350',
                          pl: 1.25,
                        }}
                      >
                        <EventBusyOutlinedIcon sx={{ color: 'error.main', fontSize: 18 }} />
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Stack direction="row" spacing={1} alignItems="center">
                            <MuiLink
                              component={NextLink}
                              href={`/students/${row.student_id}`}
                              underline="hover"
                              onMouseEnter={() =>
                                prefetch.onEnter(row.student_id, `/students/${row.student_id}`)
                              }
                              onMouseLeave={prefetch.onLeave}
                              sx={{
                                fontWeight: 600,
                                color: 'text.primary',
                                fontSize: 13,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                              title={`${row.given_name} ${row.family_name}`}
                            >
                              {row.given_name} {row.family_name}
                            </MuiLink>
                            <Typography
                              variant="caption"
                              color="text.secondary"
                              sx={{ fontFamily: 'monospace' }}
                              noWrap
                            >
                              {row.student_code}
                            </Typography>
                          </Stack>
                          <Typography variant="caption" color="text.secondary" noWrap>
                            {row.present_count}/{row.total_count} present
                            {row.last_check_date ? ` · last ${formatRelative(row.last_check_date)}` : ''}
                          </Typography>
                        </Box>
                        <Chip size="small" color="error" label={`${pct}%`} />
                      </Stack>
                    );
                  })}
                </Stack>
              </SectionCard>
            ) : null}

            <SectionCard title={tQuick('title')} subtitle={tQuick('subtitle')}>
              <Stack spacing={1.25}>
                <Button
                  variant="contained"
                  fullWidth
                  startIcon={<PersonAddAlt1OutlinedIcon />}
                  onClick={() => router.push('/students')}
                >
                  {tQuick('addStudent')}
                </Button>
                <Button
                  variant="outlined"
                  fullWidth
                  startIcon={<CloudUploadOutlinedIcon />}
                  onClick={() => router.push('/imports/new')}
                >
                  {tQuick('runImport')}
                </Button>
                <Button
                  variant="outlined"
                  fullWidth
                  startIcon={<InboxOutlinedIcon />}
                  onClick={() => router.push('/inbox')}
                >
                  {tQuick('openInbox')}
                </Button>
              </Stack>
            </SectionCard>
          </Stack>
        </Grid>
      </Grid>
    </Stack>
  );
}
