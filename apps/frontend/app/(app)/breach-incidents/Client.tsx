'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import {
  Button,
  Chip,
  IconButton,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import CampaignOutlinedIcon from '@mui/icons-material/CampaignOutlined';
import DoneAllOutlinedIcon from '@mui/icons-material/DoneAllOutlined';
import { useAuth } from '@/lib/auth';
import { isAdmin } from '@/lib/auth-helpers';
import { api, ApiError } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import ListPageShell from '@/components/ListPageShell';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import CreateBreachDialog from '@/features/privacy/CreateBreachDialog';
import ConfirmDialog from '@/components/ConfirmDialog';

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

type BreachRow = {
  id: string;
  detected_at: string;
  due_by: string;
  reported_at: string | null;
  severity: Severity;
  affected_subjects_count: number | null;
  description: string;
  remediation: string | null;
  notification_sent: boolean;
  closed_at: string | null;
  // SVT-WAVE2-BREACH-2026-05 — server-decorated SLA state.
  hours_remaining?: number | null;
  is_overdue?: boolean;
};

const SEVERITY_COLOR: Record<Severity, 'success' | 'warning' | 'error'> = {
  LOW: 'success',
  MEDIUM: 'warning',
  HIGH: 'error',
  CRITICAL: 'error',
};

// SVT-WAVE22-BREACH-SLA-2026-05 — prefer server-decorated `is_overdue` (which
// reflects the new due_by column). Fall back to legacy detected_at+72h check
// for backwards compatibility with older API responses.
const NOTIFY_DEADLINE_MS = 72 * 60 * 60 * 1000; // GDPR Art. 33 — 72 hours.

function reportingOverdue(row: BreachRow): boolean {
  if (row.is_overdue !== undefined) return row.is_overdue;
  if (row.reported_at || row.closed_at) return false;
  const ts = new Date(row.detected_at).getTime();
  if (!Number.isFinite(ts)) return false;
  return Date.now() - ts > NOTIFY_DEADLINE_MS;
}

function hoursRemainingLabel(row: BreachRow): string | null {
  if (row.closed_at) return 'Closed';
  if (typeof row.hours_remaining !== 'number') return null;
  if (row.hours_remaining < 0) return `${Math.abs(row.hours_remaining)}h overdue`;
  return `${row.hours_remaining}h to deadline`;
}

function ForbiddenState() {
  return (
    <Stack spacing={3}>
      <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
        Breach incidents
      </Typography>
      <EmptyState
        icon={<WarningAmberOutlinedIcon fontSize="medium" />}
        title="You don’t have access to this page"
        description="Breach incident management is restricted to workspace administrators."
      />
    </Stack>
  );
}

export default function BreachIncidentsPage() {
  const { user } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const queryClient = useQueryClient();
  const admin = isAdmin(user?.role ?? null);
  const t = useTranslations('breach');

  const [createOpen, setCreateOpen] = useState(false);
  // SVT-QA-2026-08 — Mark-reported and Mark-closed are timestamp writes that
  // start / stop the GDPR Art. 33 clock and materially affect the audit chain.
  // A stray IconButton click on the wrong row (they sit at the row end where
  // touch users can easily mis-tap) should require an explicit confirmation.
  const [confirmAction, setConfirmAction] = useState<
    | { rowId: string; kind: 'report' | 'close'; label: string }
    | null
  >(null);
  // SVT-WAVE-HIGH-5-2026-05 — client-side filter chips (list capped at 100).
  // Severity = LOW|MEDIUM|HIGH|CRITICAL; lifecycle = OPEN|REPORTED|CLOSED.
  const [severityFilter, setSeverityFilter] = useState<Severity | 'ALL'>('ALL');
  const [lifecycleFilter, setLifecycleFilter] = useState<
    'ALL' | 'OPEN' | 'REPORTED' | 'CLOSED'
  >('ALL');

  const listQuery = useQuery<BreachRow[]>({
    queryKey: ['breach-incidents'],
    queryFn: async ({ signal }) => {
      // Backend may return either the bare array (legacy) or `{ data: [...] }`
      // (current envelope). Tolerate both so older deployments still work.
      const res = await api.get<BreachRow[] | { data: BreachRow[] }>('/breach-incidents', {
        params: { limit: 100 },
        signal,
      });
      if (Array.isArray(res.data)) return res.data;
      return Array.isArray(res.data?.data) ? res.data.data : [];
    },
    enabled: admin,
  });

  const patchMut = useMutation({
    mutationFn: async (vars: { id: string; body: Record<string, unknown> }) => {
      const res = await api.patch(`/breach-incidents/${vars.id}`, vars.body);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Incident updated.', { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['breach-incidents'] });
      // SVT-WAVE42-DASH-INVALIDATE-2026-05 — the GDPR 72h dashboard widget
      // reads `/breach-incidents/dashboard-summary`. Invalidate so closing
      // an overdue incident makes the badge drop immediately.
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof ApiError
          ? err.detail || err.title || 'Failed to update incident.'
          : 'Failed to update incident.';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const allRows = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const rows = useMemo(() => {
    return allRows.filter((r) => {
      if (severityFilter !== 'ALL' && r.severity !== severityFilter) return false;
      if (lifecycleFilter !== 'ALL') {
        const isClosed = r.closed_at != null;
        const isReported = r.reported_at != null && !isClosed;
        const isOpen = !isClosed && !isReported;
        if (lifecycleFilter === 'OPEN' && !isOpen) return false;
        if (lifecycleFilter === 'REPORTED' && !isReported) return false;
        if (lifecycleFilter === 'CLOSED' && !isClosed) return false;
      }
      return true;
    });
  }, [allRows, severityFilter, lifecycleFilter]);

  const columns: DataTableColumn<BreachRow>[] = useMemo(
    () => [
      {
        key: 'detected_at',
        label: 'Detected',
        render: (r) => (
          <Tooltip title={formatDateTime(r.detected_at)}>
            <Typography component="span" variant="body2">
              {formatRelative(r.detected_at)}
            </Typography>
          </Tooltip>
        ),
      },
      {
        key: 'severity',
        label: 'Severity',
        render: (r) => (
          <Chip size="small" label={r.severity} color={SEVERITY_COLOR[r.severity]} />
        ),
      },
      {
        key: 'affected',
        label: 'Affected',
        align: 'right',
        render: (r) => (
          <Typography component="span" variant="body2">
            {r.affected_subjects_count != null ? r.affected_subjects_count : '—'}
          </Typography>
        ),
      },
      {
        key: 'reported_at',
        label: 'Reported',
        render: (r) => {
          if (r.reported_at) {
            return (
              <Tooltip title={formatDateTime(r.reported_at)}>
                <Typography component="span" variant="body2" color="text.secondary">
                  {formatRelative(r.reported_at)}
                </Typography>
              </Tooltip>
            );
          }
          const overdue = reportingOverdue(r);
          const label = hoursRemainingLabel(r);
          return (
            <Stack spacing={0.25}>
              <Typography
                component="span"
                variant="body2"
                sx={{ color: overdue ? 'error.main' : 'text.secondary', fontWeight: overdue ? 700 : 400 }}
              >
                {overdue ? 'OVERDUE (>72h)' : 'Not reported'}
              </Typography>
              {label && (
                <Typography variant="caption" color="text.secondary">
                  {label}
                </Typography>
              )}
            </Stack>
          );
        },
      },
      {
        key: 'description',
        label: 'Description',
        render: (r) => (
          <Tooltip title={r.description} placement="top-start">
            <Typography
              component="span"
              variant="body2"
              sx={{
                display: '-webkit-box',
                WebkitLineClamp: 2,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
                maxWidth: 360,
              }}
            >
              {r.description}
            </Typography>
          </Tooltip>
        ),
      },
      {
        key: 'closed_at',
        label: 'Closed',
        render: (r) =>
          r.closed_at ? (
            <Tooltip title={formatDateTime(r.closed_at)}>
              <Chip size="small" label={formatRelative(r.closed_at)} color="success" />
            </Tooltip>
          ) : (
            <Chip size="small" label="Open" variant="outlined" />
          ),
        hideOnMobile: true,
      },
      {
        key: 'actions',
        label: '',
        align: 'right',
        width: 120,
        render: (r) => (
          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
            <Tooltip title={r.reported_at ? 'Already reported' : 'Mark as reported now'}>
              <span>
                <IconButton
                  size="small"
                  disabled={Boolean(r.reported_at) || patchMut.isPending}
                  onClick={() =>
                    setConfirmAction({
                      rowId: r.id,
                      kind: 'report',
                      label: r.description.slice(0, 60) || r.id.slice(0, 8),
                    })
                  }
                  aria-label={t('aria.markReported')}
                >
                  <CampaignOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title={r.closed_at ? 'Already closed' : 'Mark as closed'}>
              <span>
                <IconButton
                  size="small"
                  disabled={Boolean(r.closed_at) || patchMut.isPending}
                  onClick={() =>
                    setConfirmAction({
                      rowId: r.id,
                      kind: 'close',
                      label: r.description.slice(0, 60) || r.id.slice(0, 8),
                    })
                  }
                  aria-label={t('aria.markClosed')}
                >
                  <DoneAllOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
          </Stack>
        ),
      },
    ],
    [patchMut, t],
  );

  if (!admin) return <ForbiddenState />;

  // SVT-WAVE22-BREACH-SLA-2026-05 — quick counts for the alert banner.
  // Always over the un-filtered set so an overdue badge isn't hidden by a
  // CLOSED-only filter selection.
  const overdueCount = allRows.filter((r) => reportingOverdue(r)).length;
  const dueSoonCount = allRows.filter((r) =>
    !r.closed_at && !r.reported_at && !reportingOverdue(r) &&
    typeof r.hours_remaining === 'number' && r.hours_remaining <= 24
  ).length;

  return (
    <ListPageShell
      title="Breach incidents"
      description="Personal data breaches under GDPR Art. 33. The 72-hour notification clock starts at detection."
      action={
        <Button
          variant="contained"
          color="warning"
          startIcon={<AddOutlinedIcon />}
          onClick={() => setCreateOpen(true)}
        >
          Report incident
        </Button>
      }
      bareContent
    >
      {(overdueCount > 0 || dueSoonCount > 0) && (
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ mb: 2 }}
        >
          {overdueCount > 0 && (
            <Chip
              color="error"
              icon={<WarningAmberOutlinedIcon />}
              label={`${overdueCount} overdue — past 72h, notification required`}
              sx={{ fontWeight: 600 }}
            />
          )}
          {dueSoonCount > 0 && (
            <Chip
              color="warning"
              icon={<WarningAmberOutlinedIcon />}
              label={`${dueSoonCount} due within 24h`}
            />
          )}
        </Stack>
      )}

      {/* SVT-WAVE-HIGH-5-2026-05 — severity + lifecycle filter strip. */}
      {allRows.length > 0 && (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          flexWrap="wrap"
          useFlexGap
          sx={{ mb: 2 }}
        >
          <Typography variant="caption" color="text.secondary" sx={{ mr: 0.5, fontWeight: 600 }}>
            Severity:
          </Typography>
          {(['ALL', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const).map((s) => (
            <Chip
              key={s}
              label={s === 'ALL' ? 'All' : s}
              size="small"
              variant={severityFilter === s ? 'filled' : 'outlined'}
              color={severityFilter === s ? 'primary' : 'default'}
              onClick={() => setSeverityFilter(s)}
              aria-pressed={severityFilter === s}
            />
          ))}
          <Typography variant="caption" color="text.secondary" sx={{ mx: 0.5, fontWeight: 600 }}>
            Status:
          </Typography>
          {(['ALL', 'OPEN', 'REPORTED', 'CLOSED'] as const).map((s) => (
            <Chip
              key={s}
              label={s === 'ALL' ? 'All' : s}
              size="small"
              variant={lifecycleFilter === s ? 'filled' : 'outlined'}
              color={lifecycleFilter === s ? 'primary' : 'default'}
              onClick={() => setLifecycleFilter(s)}
              aria-pressed={lifecycleFilter === s}
            />
          ))}
          {(severityFilter !== 'ALL' || lifecycleFilter !== 'ALL') && (
            <Chip
              label={`Showing ${rows.length}/${allRows.length}`}
              size="small"
              variant="outlined"
              color="info"
            />
          )}
        </Stack>
      )}
      {listQuery.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : listQuery.isError ? (
        <ErrorState
          title="Couldn’t load breach incidents"
          description={
            listQuery.error instanceof ApiError
              ? listQuery.error.detail || listQuery.error.title
              : 'Please try again.'
          }
          onRetry={() => listQuery.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<WarningAmberOutlinedIcon fontSize="medium" />}
          title="No incidents recorded"
          description="That’s the goal — but if something happens, log it here so the 72h clock is on record."
          actions={
            <Button
              variant="contained"
              color="warning"
              startIcon={<AddOutlinedIcon />}
              onClick={() => setCreateOpen(true)}
            >
              Report incident
            </Button>
          }
        />
      ) : (
        <DataTable<BreachRow>
          columns={columns}
          rows={rows}
          getRowId={(r) => r.id}
          ariaLabel="Breach incidents"
        />
      )}

      <CreateBreachDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <ConfirmDialog
        open={Boolean(confirmAction)}
        title={
          confirmAction?.kind === 'report'
            ? 'Mark breach as reported to the regulator?'
            : 'Close this breach incident?'
        }
        description={
          confirmAction?.kind === 'report'
            ? `Stamp reported_at on "${confirmAction?.label}". This is a GDPR Art. 33 timestamp; it cannot be edited via the UI.`
            : `Stamp closed_at on "${confirmAction?.label}". Reopen requires an admin console update.`
        }
        confirmText={confirmAction?.kind === 'report' ? 'Mark reported' : 'Mark closed'}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => {
          if (!confirmAction) return;
          const body =
            confirmAction.kind === 'report'
              ? { reported_at: new Date().toISOString() }
              : { closed_at: new Date().toISOString() };
          patchMut.mutate({ id: confirmAction.rowId, body });
          setConfirmAction(null);
        }}
      />
    </ListPageShell>
  );
}
