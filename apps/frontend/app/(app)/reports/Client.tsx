'use client';

import { useState } from 'react';
import NextLink from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  CircularProgress,
  IconButton,
  Paper,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import EventAvailableOutlinedIcon from '@mui/icons-material/EventAvailableOutlined';
import NotificationsOutlinedIcon from '@mui/icons-material/NotificationsOutlined';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { canWriteStudents } from '@/lib/auth-helpers';
import ErrorState from '@/components/ErrorState';
import ListPageShell from '@/components/ListPageShell';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import {
  DASHBOARD_QK,
  downloadAuthedBlob,
  rememberExportId,
  type ExportStatus,
} from '@/features/io/util';

type SummaryResponse = {
  data: {
    by_stage: { stage_id: string; count: number }[];
    by_status: { status: string; count: number }[];
    recent_events: Array<{
      id: string;
      student_id: string;
      to_stage_id: string;
      occurred_at: string;
      notes: string | null;
      actor_id: string | null;
    }>;
    upcoming_expiries: unknown[];
    upcoming_expiries_total: number;
  };
};

const STATUS_LABELS: Record<string, string> = {
  ACTIVE: 'Active',
  ALUMNI: 'Alumni',
  PROSPECT: 'Prospect',
  WITHDRAWN: 'Withdrawn',
  ARCHIVED: 'Archived',
  ON_HOLD: 'On hold',
};

type ReportDef = {
  id: string;
  title: string;
  description: string;
  resource: string;
  format: 'csv' | 'xlsx' | 'json' | 'jsonl';
  icon: React.ReactNode;
  filter?: Record<string, unknown>;
};

const PREBUILT_REPORTS: ReportDef[] = [
  {
    id: 'students-all',
    title: 'All students',
    description: 'Every student in the tenant — full profile snapshot.',
    resource: 'students',
    format: 'csv',
    icon: <GroupsOutlinedIcon fontSize="small" />,
  },
  {
    id: 'students-active',
    title: 'Active students',
    description: 'Just the in-progress cohort (status = ACTIVE).',
    resource: 'students',
    format: 'csv',
    icon: <GroupsOutlinedIcon fontSize="small" />,
    filter: { status: 'ACTIVE' },
  },
  {
    id: 'reminders-pending',
    title: 'Pending reminders',
    description: 'Open reminders with their assignees and due dates.',
    resource: 'reminders',
    format: 'csv',
    icon: <NotificationsOutlinedIcon fontSize="small" />,
    filter: { status: 'PENDING' },
  },
  {
    id: 'enrollments-active',
    title: 'Active enrollments',
    description: 'Course enrollments currently in progress.',
    resource: 'enrollments',
    format: 'csv',
    icon: <ReceiptLongOutlinedIcon fontSize="small" />,
    filter: { status: 'ENROLLED' },
  },
  {
    id: 'expiries-90d',
    title: 'Upcoming expiries (90d)',
    description: 'Visas, passports, insurance and documents lapsing soon.',
    resource: 'students',
    format: 'csv',
    icon: <EventAvailableOutlinedIcon fontSize="small" />,
    filter: { upcoming_expiries_within_days: 90 },
  },
];

export default function ReportsPage() {
  const { enqueueSnackbar } = useSnackbar();
  const { user } = useAuth();
  const canExport = canWriteStudents(user?.role);
  const [exportingId, setExportingId] = useState<string | null>(null);

  const summaryQuery = useQuery<SummaryResponse>({
    queryKey: DASHBOARD_QK.summary(),
    queryFn: async () => {
      const res = await api.get<SummaryResponse>('/dashboard/summary');
      return res.data;
    },
  });

  // SVT-QA-2026-08 — stage lookup for the "Students per stage" chart.
  // The /dashboard/summary aggregation groups by stage_id only (cheap on the
  // backend); resolving the human-readable label here keeps the chart
  // readable to admins without changing the aggregation contract.
  const stagesQuery = useQuery<{ data: Array<{ id: string; key: string; label: string; color_hex?: string | null }> }>({
    queryKey: ['stages', 'for-reports'],
    queryFn: async () => {
      const res = await api.get<{ data: Array<{ id: string; key: string; label: string; color_hex?: string | null }> }>('/stages');
      return res.data;
    },
    staleTime: 5 * 60_000,
  });
  const stageLookup = new Map<string, { label: string; key: string }>();
  for (const s of stagesQuery.data?.data ?? []) {
    stageLookup.set(s.id, { label: s.label, key: s.key });
  }

  const statusCounts = new Map<string, number>();
  for (const s of summaryQuery.data?.data.by_status ?? []) {
    statusCounts.set(s.status, s.count);
  }
  const totalStudents = (summaryQuery.data?.data.by_status ?? []).reduce(
    (acc, s) => acc + s.count,
    0,
  );
  const cards = [
    { key: 'TOTAL', label: 'Total students', value: totalStudents },
    { key: 'ACTIVE', label: 'Active', value: statusCounts.get('ACTIVE') ?? 0 },
    { key: 'PROSPECT', label: 'Prospect', value: statusCounts.get('PROSPECT') ?? 0 },
    { key: 'ALUMNI', label: 'Alumni', value: statusCounts.get('ALUMNI') ?? 0 },
  ];

  const stageData = summaryQuery.data?.data.by_stage ?? [];
  const maxStageCount = stageData.reduce((m, s) => (s.count > m ? s.count : m), 1);

  // ---- Export builder (POST then poll) -----------------------------------
  const runReport = async (def: ReportDef) => {
    if (!canExport) return;
    setExportingId(def.id);
    try {
      const create = await api.post<{ id: string; status: ExportStatus }>('/exports', {
        resource: def.resource,
        format: def.format,
        filter: def.filter ?? {},
        redact_pii: true,
        locale: 'en',
        timezone: 'UTC',
      });
      rememberExportId(create.data.id);
      const jobId = create.data.id;
      enqueueSnackbar(`${def.title} queued — building…`, { variant: 'info' });

      // Poll up to 60s.
      const deadline = Date.now() + 60_000;
      let downloadUrl: string | null = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const status = await api.get<{
          id: string;
          status: ExportStatus;
          download_url?: string;
        }>(`/exports/${jobId}`);
        if (status.data.status === 'COMPLETED' && status.data.download_url) {
          downloadUrl = status.data.download_url;
          break;
        }
        if (status.data.status === 'FAILED') {
          throw new ApiError({
            type: 'about:blank',
            status: 500,
            title: 'Export failed',
          });
        }
      }
      if (!downloadUrl) {
        // Don't surface this as a hard error — the job will keep running and
        // appear on /exports. Tell the user where to find it.
        enqueueSnackbar(
          'Report still building — track it on /exports and download when ready.',
          { variant: 'info' },
        );
        return;
      }
      await downloadAuthedBlob(downloadUrl, `${def.resource}-${jobId}.${def.format}`);
      enqueueSnackbar(`${def.title} downloaded.`, { variant: 'success' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Export failed';
      enqueueSnackbar(msg, { variant: 'error' });
    } finally {
      setExportingId(null);
    }
  };

  return (
    <ListPageShell
      title="Reports"
      description="Pre-built reports plus a tenant-wide summary. Each report streams via the export pipeline."
      action={
        <>
          <Tooltip title="Refresh summary">
            <span>
              <IconButton
                aria-label="Refresh summary"
                onClick={() => summaryQuery.refetch()}
                disabled={summaryQuery.isFetching}
              >
                <RefreshOutlinedIcon />
              </IconButton>
            </span>
          </Tooltip>
          <Button
            variant="outlined"
            startIcon={<OpenInNewOutlinedIcon />}
            component={NextLink}
            href="/exports"
          >
            All exports
          </Button>
        </>
      }
      bareContent
    >
      <Stack spacing={3}>
        {/* Pre-built reports */}
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
            Pre-built reports
          </Typography>
          {!canExport ? (
            <Paper variant="outlined" sx={{ p: 2 }}>
              <Typography variant="body2" color="text.secondary">
                You need a counsellor or admin role to generate reports. Ask your tenant admin
                to grant access.
              </Typography>
            </Paper>
          ) : (
            <Box
              sx={{
                display: 'grid',
                gap: 2,
                gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' },
              }}
            >
              {PREBUILT_REPORTS.map((r) => {
                const busy = exportingId === r.id;
                const blocked = exportingId !== null && !busy;
                return (
                  <Card key={r.id} variant="outlined">
                    <CardActionArea
                      disabled={blocked || busy}
                      onClick={() => runReport(r)}
                      aria-label={`Generate report: ${r.title}`}
                      sx={{ p: 2, height: '100%' }}
                    >
                      <Stack spacing={1.5}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Box
                            sx={{
                              width: 36,
                              height: 36,
                              borderRadius: 1.25,
                              bgcolor: 'action.hover',
                              color: 'primary.main',
                              display: 'inline-flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            {r.icon}
                          </Box>
                          <Stack spacing={0.25} sx={{ flex: 1 }}>
                            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
                              {r.title}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              {r.resource} · {r.format.toUpperCase()}
                            </Typography>
                          </Stack>
                          {busy ? (
                            <CircularProgress size={18} />
                          ) : (
                            <FileDownloadOutlinedIcon fontSize="small" color="action" />
                          )}
                        </Stack>
                        <Typography variant="body2" color="text.secondary">
                          {r.description}
                        </Typography>
                      </Stack>
                    </CardActionArea>
                  </Card>
                );
              })}
            </Box>
          )}
        </Box>

        {/* Summary section */}
        <Box>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1.5 }}>
            Tenant summary
          </Typography>
          {summaryQuery.isLoading ? (
            <LoadingSkeleton variant="page" />
          ) : summaryQuery.isError ? (
            <ErrorState
              title="Could not load summary"
              description={
                summaryQuery.error instanceof ApiError
                  ? summaryQuery.error.detail || summaryQuery.error.title
                  : 'Unexpected error'
              }
              onRetry={() => summaryQuery.refetch()}
              requestId={
                summaryQuery.error instanceof ApiError ? summaryQuery.error.requestId : undefined
              }
            />
          ) : (
            <Stack spacing={2}>
              {/* Stat cards */}
              <Box
                sx={{
                  display: 'grid',
                  gap: 2,
                  gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
                }}
              >
                {cards.map((c) => (
                  <Card key={c.key} variant="outlined">
                    <CardContent>
                      <Typography variant="body2" color="text.secondary" sx={{ fontWeight: 500 }}>
                        {STATUS_LABELS[c.key] ?? c.label}
                      </Typography>
                      <Typography variant="h4" sx={{ fontWeight: 600, mt: 1 }}>
                        {c.value}
                      </Typography>
                    </CardContent>
                  </Card>
                ))}
              </Box>

              {/* Bar chart (CSS) */}
              <Card variant="outlined">
                <CardContent>
                  <Stack direction="row" justifyContent="space-between" sx={{ mb: 2 }}>
                    <Typography variant="h6" sx={{ fontWeight: 600 }}>
                      Students per stage
                    </Typography>
                    <Chip
                      size="small"
                      label={`${stageData.length} stage${stageData.length === 1 ? '' : 's'}`}
                      variant="outlined"
                    />
                  </Stack>
                  {stageData.length === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      No stage data yet — add students to populate this chart.
                    </Typography>
                  ) : (
                    <Stack spacing={1.5}>
                      {stageData.map((s) => {
                        const pct = Math.max(2, Math.round((s.count / maxStageCount) * 100));
                        // SVT-QA-2026-08 — resolve stage_id → label; fall back
                        // to the id fragment only when the lookup is still
                        // loading or the row was deleted. Never a bare UUID
                        // fragment in the happy path.
                        const meta = s.stage_id ? stageLookup.get(s.stage_id) : null;
                        const displayLabel = meta?.label
                          ?? (s.stage_id ? `Stage ${s.stage_id.slice(0, 8)}` : '(unassigned)');
                        return (
                          <Stack key={s.stage_id ?? '(none)'} spacing={0.5}>
                            <Stack direction="row" justifyContent="space-between">
                              <Typography
                                variant="caption"
                                sx={{ color: 'text.secondary' }}
                                noWrap
                              >
                                {displayLabel}
                              </Typography>
                              <Typography variant="caption" sx={{ fontWeight: 600 }}>
                                {s.count}
                              </Typography>
                            </Stack>
                            <Box
                              sx={{
                                height: 14,
                                borderRadius: 1,
                                bgcolor: 'action.hover',
                                overflow: 'hidden',
                              }}
                              aria-label={`${s.count} students in stage ${displayLabel}`}
                            >
                              <Box
                                sx={{
                                  width: `${pct}%`,
                                  height: '100%',
                                  background:
                                    'linear-gradient(90deg, #1A73E8 0%, #7E57C2 100%)',
                                  transition: 'width 200ms ease',
                                }}
                              />
                            </Box>
                          </Stack>
                        );
                      })}
                    </Stack>
                  )}
                </CardContent>
              </Card>

              {/* Status breakdown table */}
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle2" sx={{ mb: 1.5 }}>
                  Breakdown by status
                </Typography>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  {(summaryQuery.data?.data.by_status ?? []).map((s) => (
                    <Chip
                      key={s.status}
                      label={`${STATUS_LABELS[s.status] ?? s.status}: ${s.count}`}
                      variant="outlined"
                    />
                  ))}
                  {(summaryQuery.data?.data.by_status.length ?? 0) === 0 ? (
                    <Typography variant="body2" color="text.secondary">
                      No data yet.
                    </Typography>
                  ) : null}
                </Stack>
              </Paper>
            </Stack>
          )}
        </Box>
      </Stack>
    </ListPageShell>
  );
}
