'use client';

// SVT-WAVE10-OUTBOX-FE-2026-05 — admin outbox page.
//
// Surfaces /api/v1/admin/comms/outbox/health for the KPI strip + paginated
// /messages list filtered by status. Each row exposes a requeue action when
// the status is FAILED (any sub-state); requeue flips the row back to QUEUED
// and invalidates both queries so the UI reflects the new state.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Paper,
  Tooltip,
  Typography,
} from '@mui/material';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import ReplayOutlinedIcon from '@mui/icons-material/ReplayOutlined';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import OutboxOutlinedIcon from '@mui/icons-material/OutboxOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import HourglassEmptyOutlinedIcon from '@mui/icons-material/HourglassEmptyOutlined';
import ConfirmDialog from '@/components/ConfirmDialog';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import KpiTile from '@/components/KpiTile';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import { formatRelative } from '@/lib/format';

type StatusFilter = 'QUEUED' | 'FAILED' | 'TERMINAL' | 'SENT';

type OutboxRow = {
  id: string;
  subject: string | null;
  body: string;
  status: string;
  attempts: number;
  sent_at: string | null;
  created_at: string;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  recipient_user_id: string | null;
  provider_id: string | null;
  metadata: Record<string, unknown> | null;
};

type Health = {
  queued: number;
  retrying: number;
  terminal_failed: number;
  sent_last_24h: number;
};

const STATUS_LABEL: Record<StatusFilter, string> = {
  QUEUED: 'Queued',
  FAILED: 'Retrying',
  TERMINAL: 'Terminal',
  SENT: 'Sent',
};

const STATUS_COLOR: Record<StatusFilter, 'default' | 'warning' | 'error' | 'success'> = {
  QUEUED: 'default',
  FAILED: 'warning',
  TERMINAL: 'error',
  SENT: 'success',
};

// SVT-WAVE13-TREND-2026-05 — CSS-only 7-day stacked bar chart for SENT vs FAILED.
// Bars sized relative to the day with the highest total. Zero-count days render
// a faint tick so the dimension is visible.
function TrendStrip({
  rows,
  loading,
}: {
  rows: Array<{ day: string; status: string; count: number }>;
  loading: boolean;
}) {
  // Pivot rows into per-day {sent, failed} totals.
  const byDay = new Map<string, { sent: number; failed: number }>();
  // Fill the trailing 7 days so empty days still render.
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    byDay.set(key, { sent: 0, failed: 0 });
  }
  for (const r of rows) {
    const slot = byDay.get(r.day) ?? { sent: 0, failed: 0 };
    if (r.status === 'SENT' || r.status === 'DELIVERED' || r.status === 'READ') slot.sent += r.count;
    if (r.status === 'FAILED') slot.failed += r.count;
    byDay.set(r.day, slot);
  }
  const days = Array.from(byDay.entries());
  const max = Math.max(1, ...days.map(([, v]) => v.sent + v.failed));

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack spacing={1.5}>
          <Stack direction="row" alignItems="center" spacing={2}>
            <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
              Delivery trend · 7 days
            </Typography>
            {loading && (
              <Typography variant="caption" color="text.secondary">
                loading…
              </Typography>
            )}
            <Box sx={{ flexGrow: 1 }} />
            <Stack direction="row" spacing={2} alignItems="center">
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Box sx={{ width: 10, height: 10, bgcolor: 'success.main', borderRadius: 0.5 }} />
                <Typography variant="caption">Sent</Typography>
              </Stack>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Box sx={{ width: 10, height: 10, bgcolor: 'error.main', borderRadius: 0.5 }} />
                <Typography variant="caption">Failed</Typography>
              </Stack>
            </Stack>
          </Stack>
          <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 1, height: 96 }}>
            {days.map(([day, v]) => {
              const sentPct = (v.sent / max) * 100;
              const failedPct = (v.failed / max) * 100;
              const label = day.slice(5); // MM-DD
              return (
                <Tooltip
                  key={day}
                  title={`${day} · sent ${v.sent} · failed ${v.failed}`}
                  arrow
                >
                  <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}>
                    <Box
                      sx={{
                        width: '100%',
                        height: 80,
                        display: 'flex',
                        flexDirection: 'column',
                        justifyContent: 'flex-end',
                        gap: 0.25,
                      }}
                    >
                      {v.failed > 0 && (
                        <Box sx={{ width: '100%', height: `${Math.max(failedPct, 4)}%`, bgcolor: 'error.main', borderRadius: 0.5 }} />
                      )}
                      {v.sent > 0 ? (
                        <Box sx={{ width: '100%', height: `${Math.max(sentPct, 4)}%`, bgcolor: 'success.main', borderRadius: 0.5 }} />
                      ) : v.failed === 0 ? (
                        <Box sx={{ width: '100%', height: 2, bgcolor: 'action.disabledBackground', borderRadius: 0.5 }} />
                      ) : null}
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ fontSize: 10 }}>
                      {label}
                    </Typography>
                  </Box>
                </Tooltip>
              );
            })}
          </Box>
        </Stack>
      </CardContent>
    </Card>
  );
}

export default function OutboxClient() {
  const router = useRouter();
  const { user } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [status, setStatus] = useState<StatusFilter>('QUEUED');

  const isAdmin = user?.role === 'ADMIN';

  const healthQ = useQuery({
    queryKey: ['admin', 'outbox', 'health'],
    enabled: isAdmin,
    refetchInterval: 30_000,
    queryFn: async () => {
      const res = await api.get<{ data: Health }>('/admin/comms/outbox/health');
      return res.data.data;
    },
  });

  const listQ = useQuery({
    queryKey: ['admin', 'outbox', 'messages', status],
    enabled: isAdmin,
    refetchInterval: 30_000,
    queryFn: async () => {
      const res = await api.get<{ data: OutboxRow[] }>(`/admin/comms/outbox/messages`, {
        params: { status, limit: 50 },
      });
      return res.data.data;
    },
  });

  // SVT-WAVE13-TREND-2026-05 — 7-day SENT/FAILED stack for dashboard trend.
  const trendQ = useQuery({
    queryKey: ['admin', 'outbox', 'trend', 7],
    enabled: isAdmin,
    refetchInterval: 60_000,
    queryFn: async () => {
      const res = await api.get<{ data: Array<{ day: string; status: string; count: number }> }>(
        `/admin/comms/outbox/trend`,
        { params: { days: 7 } },
      );
      return res.data.data;
    },
  });

  const requeue = useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/admin/comms/outbox/${id}/requeue`, {});
    },
    onSuccess: () => {
      enqueueSnackbar('Requeued for next dispatcher pass.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['admin', 'outbox'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? (err.detail || err.title) : err instanceof Error ? err.message : 'Requeue failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  // SVT-WAVE12-BULK-REQUEUE-2026-05 — bulk-requeue current visible bucket.
  // Scope inferred from active status filter (TERMINAL→terminal,
  // FAILED→retrying, anything else not eligible).
  const bulkRequeue = useMutation({
    mutationFn: async (scope: 'terminal' | 'retrying' | 'failed') => {
      const res = await api.post<{ requeued: number; scope: string }>(
        `/admin/comms/outbox/requeue-all`,
        {},
        { params: { scope } },
      );
      return res.data;
    },
    onSuccess: (data) => {
      enqueueSnackbar(
        data.requeued === 0
          ? `No rows to requeue (scope: ${data.scope}).`
          : `Requeued ${data.requeued} row${data.requeued === 1 ? '' : 's'} (scope: ${data.scope}).`,
        { variant: data.requeued > 0 ? 'success' : 'info' },
      );
      void qc.invalidateQueries({ queryKey: ['admin', 'outbox'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? (err.detail || err.title) : err instanceof Error ? err.message : 'Bulk requeue failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });
  const bulkScope: 'terminal' | 'retrying' | 'failed' | null =
    status === 'TERMINAL' ? 'terminal' : status === 'FAILED' ? 'retrying' : null;
  const [confirmBulk, setConfirmBulk] = useState(false);

  if (!isAdmin) {
    return (
      <Stack spacing={2}>
        <Typography variant="h5">Comms outbox</Typography>
        <Typography color="text.secondary">Admin role required.</Typography>
      </Stack>
    );
  }

  const rows = listQ.data ?? [];
  const h = healthQ.data;

  return (
    <Stack spacing={3}>
      <Stack direction="row" spacing={1} alignItems="center">
        <IconButton size="small" onClick={() => router.push('/admin')} aria-label="Back to admin">
          <ArrowBackIosNewIcon fontSize="small" />
        </IconButton>
        <Stack>
          <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
            Comms outbox
          </Typography>
          <Typography variant="body1" color="text.secondary">
            EMAIL/SMS/WhatsApp delivery state for transitions, reminders, and ad-hoc messages.
          </Typography>
        </Stack>
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <KpiTile
          icon={<HourglassEmptyOutlinedIcon />}
          label="Queued"
          value={h?.queued ?? '—'}
          hint={healthQ.isFetching ? 'refreshing…' : undefined}
        />
        <KpiTile
          icon={<ReplayOutlinedIcon />}
          label="Retrying"
          value={h?.retrying ?? '—'}
          intent={(h?.retrying ?? 0) > 0 ? 'warning' : 'default'}
        />
        <KpiTile
          icon={<ErrorOutlineIcon />}
          label="Terminal"
          value={h?.terminal_failed ?? '—'}
          intent={(h?.terminal_failed ?? 0) > 0 ? 'error' : 'default'}
        />
        <KpiTile
          icon={<CheckCircleOutlineIcon />}
          label="Sent · 24h"
          value={h?.sent_last_24h ?? '—'}
        />
      </Stack>

      <TrendStrip rows={trendQ.data ?? []} loading={trendQ.isLoading} />

      <Stack direction="row" spacing={1} alignItems="center">
        {(['QUEUED', 'FAILED', 'TERMINAL', 'SENT'] as StatusFilter[]).map((s) => (
          <Button
            key={s}
            variant={status === s ? 'contained' : 'outlined'}
            size="small"
            color={STATUS_COLOR[s] === 'default' ? 'primary' : STATUS_COLOR[s]}
            onClick={() => setStatus(s)}
          >
            {STATUS_LABEL[s]}
          </Button>
        ))}
        <Box sx={{ flexGrow: 1 }} />
        {bulkScope && rows.length > 0 && (
          <Tooltip title={`Flip every ${bulkScope.toUpperCase()} row back to QUEUED. Resets attempts.`}>
            <span>
              <Button
                size="small"
                variant="outlined"
                color="warning"
                startIcon={<ReplayOutlinedIcon />}
                onClick={() => setConfirmBulk(true)}
                disabled={bulkRequeue.isPending}
              >
                Requeue all
              </Button>
            </span>
          </Tooltip>
        )}
        {bulkScope ? (
          <ConfirmDialog
            open={confirmBulk}
            title="Requeue all in this view?"
            description={`Flip every ${bulkScope.toUpperCase()} message (${rows.length} shown) back to QUEUED and reset attempts. They will be re-sent on the next dispatch — recipients may receive previously-failed messages.`}
            confirmText="Requeue all"
            destructive
            loading={bulkRequeue.isPending}
            onConfirm={() => { setConfirmBulk(false); bulkRequeue.mutate(bulkScope); }}
            onClose={() => setConfirmBulk(false)}
          />
        ) : null}
        <Tooltip title="Refresh">
          <IconButton onClick={() => void qc.invalidateQueries({ queryKey: ['admin', 'outbox'] })} size="small">
            <RefreshOutlinedIcon />
          </IconButton>
        </Tooltip>
      </Stack>

      {listQ.isLoading ? (
        <LoadingSkeleton variant="page" />
      ) : listQ.isError ? (
        <ErrorState onRetry={() => void listQ.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<OutboxOutlinedIcon />}
          title={`No ${STATUS_LABEL[status].toLowerCase()} messages`}
          description="Background dispatcher runs every 5 minutes."
        />
      ) : (
        <TableContainer component={Paper} variant="outlined">
          <Table size="small" aria-label="Outbox messages">
            <TableHead>
              <TableRow>
                <TableCell>Subject</TableCell>
                <TableCell>Body preview</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Attempts</TableCell>
                <TableCell>Last attempt</TableCell>
                <TableCell>Next retry</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((m) => {
                const isFailed = m.status === 'FAILED';
                const lastError =
                  (m.metadata as { last_error?: string } | null)?.last_error ?? null;
                return (
                  <TableRow key={m.id} hover>
                    <TableCell>{m.subject ?? '—'}</TableCell>
                    <TableCell sx={{ maxWidth: 280 }}>
                      <Typography
                        variant="body2"
                        sx={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {m.body}
                      </Typography>
                      {lastError && (
                        <Typography variant="caption" color="error">
                          Last error: {lastError}
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={m.status} color={isFailed ? 'warning' : 'default'} />
                    </TableCell>
                    <TableCell align="right">{m.attempts}</TableCell>
                    <TableCell>{m.last_attempt_at ? formatRelative(m.last_attempt_at) : '—'}</TableCell>
                    <TableCell>{m.next_retry_at ? formatRelative(m.next_retry_at) : '—'}</TableCell>
                    <TableCell align="right">
                      {isFailed ? (
                        <Tooltip title="Requeue this row for next dispatcher pass">
                          <span>
                            <Button
                              size="small"
                              variant="outlined"
                              startIcon={<ReplayOutlinedIcon />}
                              onClick={() => requeue.mutate(m.id)}
                              disabled={requeue.isPending}
                            >
                              Requeue
                            </Button>
                          </span>
                        </Tooltip>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Stack>
  );
}
