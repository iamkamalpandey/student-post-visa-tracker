// Refactored to SVT form-pattern
'use client';

import { useEffect, useId, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import {
  Box,
  Button,
  CircularProgress,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import RefreshIcon from '@mui/icons-material/Refresh';
import DownloadOutlinedIcon from '@mui/icons-material/DownloadOutlined';
import ReplayOutlinedIcon from '@mui/icons-material/ReplayOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LabeledField from '@/components/LabeledField';
import StatusChip from '@/components/StatusChip';
import ConfirmDialog from '@/components/ConfirmDialog';
import {
  downloadAuthedBlob,
  IMPORTS_QK,
  newIdempotencyKey,
  readRecentImportIds,
} from '@/features/io/util';

type ImportStatus =
  | 'UPLOADED'
  | 'PARSING'
  | 'VALIDATING'
  | 'DRY_RUN_READY'
  | 'APPLYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

type ImportJobRow = {
  id: string;
  resource: string;
  status: ImportStatus;
  source_filename: string;
  created_at: string;
  row_total: number | null;
  row_created: number | null;
  row_updated: number | null;
  row_skipped: number | null;
  row_failed: number | null;
  mapping_json: Record<string, string> | null;
  error_report_key: string | null;
  result_key: string | null;
};

const STATUS_FILTERS: Array<ImportStatus | 'all'> = [
  'all',
  'UPLOADED',
  'PARSING',
  'VALIDATING',
  'DRY_RUN_READY',
  'APPLYING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
];

const CANCELLABLE_STATUSES: ReadonlySet<ImportStatus> = new Set([
  'UPLOADED',
  'PARSING',
  'VALIDATING',
  'DRY_RUN_READY',
  'APPLYING',
]);

export default function ImportsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const fmt = useFormat();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const t = useTranslations('imports');
  const [downloading, setDownloading] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<ImportStatus | 'all'>('all');
  const [resourceFilter, setResourceFilter] = useState<string>('all');
  const [cancelTarget, setCancelTarget] = useState<ImportJobRow | null>(null);

  // Stable ids for sr-only `<label htmlFor>` associations on toolbar selects.
  const statusFilterId = useId();
  const resourceFilterId = useId();

  const isViewer = user?.role === 'VIEWER';
  const canWrite = !isViewer;

  // Backend doesn't expose a list endpoint for ImportJobs in the routes shown.
  // Fall back to a "recent jobs" cache stored in sessionStorage so the user sees
  // the jobs they kicked off in this browser.
  const [recentIds, setRecentIds] = useState<string[]>([]);
  useEffect(() => {
    setRecentIds(readRecentImportIds());
  }, []);

  const jobsQuery = useQuery<ImportJobRow[]>({
    queryKey: IMPORTS_QK.list(recentIds),
    queryFn: async () => {
      if (recentIds.length === 0) return [];
      const results = await Promise.allSettled(
        recentIds.map((id) => api.get<ImportJobRow>(`/imports/${id}`).then((r) => r.data)),
      );
      return results
        .filter((r): r is PromiseFulfilledResult<ImportJobRow> => r.status === 'fulfilled')
        .map((r) => r.value)
        .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
    },
    refetchInterval: 5000,
  });

  const reapplyMut = useMutation({
    mutationFn: async (job: ImportJobRow) => {
      const idem = newIdempotencyKey();
      const res = await api.post(
        `/imports/${job.id}/apply`,
        { mapping_json: job.mapping_json ?? {} },
        { headers: { 'Idempotency-Key': idem } },
      );
      return res.data;
    },
    onSuccess: (_d, job) => {
      enqueueSnackbar(`Re-applied import ${job.id.slice(0, 8)}`, { variant: 'success' });
      void qc.invalidateQueries({ queryKey: IMPORTS_QK.all });
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof ApiError ? err.detail || err.title : 'Could not re-apply import job';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const cancelMut = useMutation({
    mutationFn: async (job: ImportJobRow) => {
      const res = await api.post(`/imports/${job.id}/cancel`, {});
      return res.data;
    },
    onSuccess: (_d, job) => {
      enqueueSnackbar(`Cancelled import ${job.id.slice(0, 8)}`, { variant: 'info' });
      void qc.invalidateQueries({ queryKey: IMPORTS_QK.all });
      setCancelTarget(null);
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Cancel failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const handleDownload = async (jobId: string, kind: 'errors' | 'result') => {
    setDownloading(`${jobId}:${kind}`);
    try {
      const filename = kind === 'errors' ? `errors-${jobId}.jsonl` : `result-${jobId}.jsonl`;
      await downloadAuthedBlob(
        `/imports/${jobId}/${kind === 'errors' ? 'errors.jsonl' : 'result.jsonl'}`,
        filename,
      );
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Download failed';
      enqueueSnackbar(msg, { variant: 'error' });
    } finally {
      setDownloading(null);
    }
  };

  const allRows = jobsQuery.data ?? [];
  const resourceOptions = useMemo(() => {
    const set = new Set<string>();
    for (const r of allRows) set.add(r.resource);
    return Array.from(set).sort();
  }, [allRows]);

  const rows = useMemo(
    () =>
      allRows.filter((j) => {
        if (statusFilter !== 'all' && j.status !== statusFilter) return false;
        if (resourceFilter !== 'all' && j.resource !== resourceFilter) return false;
        return true;
      }),
    [allRows, statusFilter, resourceFilter],
  );

  const hasFilter = statusFilter !== 'all' || resourceFilter !== 'all';

  return (
    <>
      <Stack spacing={3}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} justifyContent="space-between">
          <Stack spacing={0.5}>
            <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
              Imports
            </Typography>
            <Typography variant="body1" color="text.secondary">
              Bulk-load students, institutions, programs, enrollments, and program fees with a dry-run preview.
            </Typography>
          </Stack>
          <Stack direction="row" spacing={1.5}>
            <Tooltip title="Refresh">
              <span>
                <IconButton
                  aria-label={t('aria.refresh')}
                  onClick={() => qc.invalidateQueries({ queryKey: IMPORTS_QK.all })}
                  disabled={jobsQuery.isFetching}
                >
                  <RefreshIcon />
                </IconButton>
              </span>
            </Tooltip>
            {canWrite ? (
              <Button
                component={Link}
                href="/imports/new"
                variant="contained"
                startIcon={<AddIcon />}
              >
                New import
              </Button>
            ) : null}
          </Stack>
        </Stack>

        {/* Filter toolbar — each control wrapped in <LabeledField srOnly htmlFor>
            so the AT tree retains a real label even though the visible chrome
            stays compact (size="small"). */}
        <Paper variant="outlined" sx={{ px: 2, py: 1.5 }}>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={1.5}
            alignItems={{ md: 'center' }}
          >
            <LabeledField label="Status" srOnly htmlFor={statusFilterId}>
              <TextField
                id={statusFilterId}
                select
                size="small"
                hiddenLabel
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as ImportStatus | 'all')}
                sx={{ minWidth: 180 }}
              >
                {STATUS_FILTERS.map((s) => (
                  <MenuItem key={s} value={s}>
                    {s === 'all' ? 'All statuses' : s}
                  </MenuItem>
                ))}
              </TextField>
            </LabeledField>
            <LabeledField label="Resource" srOnly htmlFor={resourceFilterId}>
              <TextField
                id={resourceFilterId}
                select
                size="small"
                hiddenLabel
                value={resourceFilter}
                onChange={(e) => setResourceFilter(e.target.value)}
                sx={{ minWidth: 180 }}
                disabled={resourceOptions.length === 0}
              >
                <MenuItem value="all">All resources</MenuItem>
                {resourceOptions.map((r) => (
                  <MenuItem key={r} value={r}>
                    {r}
                  </MenuItem>
                ))}
              </TextField>
            </LabeledField>
            {hasFilter ? (
              <Button
                onClick={() => {
                  setStatusFilter('all');
                  setResourceFilter('all');
                }}
                size="small"
              >
                Reset
              </Button>
            ) : null}
          </Stack>
        </Paper>

        {jobsQuery.isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        ) : jobsQuery.isError ? (
          <ErrorState
            title="Could not load import jobs"
            description={
              jobsQuery.error instanceof ApiError
                ? jobsQuery.error.detail || jobsQuery.error.title
                : 'Unexpected error'
            }
            onRetry={() => jobsQuery.refetch()}
          />
        ) : allRows.length === 0 ? (
          <EmptyState
            title="No import jobs yet"
            description="Kick off a new import to see dry-run reports, error JSONL, and result downloads here."
            actions={
              canWrite ? (
                <Button
                  component={Link}
                  href="/imports/new"
                  variant="contained"
                  startIcon={<AddIcon />}
                >
                  Start an import
                </Button>
              ) : undefined
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No import jobs match the filters"
            description="Try clearing the filters above."
          />
        ) : (
          <TableContainer component={Paper} variant="outlined">
            <Table size="small" aria-label={t('aria.importJobs')}>
              <TableHead>
                <TableRow>
                  <TableCell>Status</TableCell>
                  <TableCell>Resource</TableCell>
                  <TableCell>File</TableCell>
                  <TableCell>Uploaded</TableCell>
                  <TableCell align="right">Rows created</TableCell>
                  <TableCell align="right">Rows updated</TableCell>
                  <TableCell align="right">Rows skipped</TableCell>
                  <TableCell align="right">Rows failed</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((job) => {
                  const dlErrorsKey = `${job.id}:errors`;
                  const dlResultKey = `${job.id}:result`;
                  const canCancel = canWrite && CANCELLABLE_STATUSES.has(job.status);
                  return (
                    <TableRow key={job.id} hover>
                      <TableCell>
                        {/* StatusChip primitive — icon + text, never colour-only (WCAG 1.4.1). */}
                        <StatusChip status={job.status} />
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>
                          {job.resource}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" sx={{ fontFamily: 'monospace' }} noWrap>
                          {job.source_filename}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Tooltip title={fmt.dateTime(job.created_at)}>
                          <span>{fmt.relative(job.created_at)}</span>
                        </Tooltip>
                      </TableCell>
                      <TableCell align="right">{job.row_created ?? 0}</TableCell>
                      <TableCell align="right">{job.row_updated ?? 0}</TableCell>
                      <TableCell align="right">{job.row_skipped ?? 0}</TableCell>
                      <TableCell align="right">{job.row_failed ?? 0}</TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                          <Tooltip title="View / continue">
                            <IconButton
                              aria-label={t('aria.viewContinue')}
                              size="small"
                              component={Link}
                              href={`/imports/new?job=${job.id}`}
                            >
                              <VisibilityOutlinedIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Download errors.jsonl">
                            <span>
                              <IconButton
                                aria-label={t('aria.downloadErrors')}
                                size="small"
                                disabled={!job.error_report_key || downloading === dlErrorsKey}
                                onClick={() => handleDownload(job.id, 'errors')}
                              >
                                {downloading === dlErrorsKey ? (
                                  <CircularProgress size={16} />
                                ) : (
                                  <DownloadOutlinedIcon fontSize="small" />
                                )}
                              </IconButton>
                            </span>
                          </Tooltip>
                          <Tooltip title="Download result.jsonl">
                            <span>
                              <IconButton
                                aria-label={t('aria.downloadResult')}
                                size="small"
                                disabled={!job.result_key || downloading === dlResultKey}
                                onClick={() => handleDownload(job.id, 'result')}
                              >
                                {downloading === dlResultKey ? (
                                  <CircularProgress size={16} />
                                ) : (
                                  <DownloadOutlinedIcon fontSize="small" color="primary" />
                                )}
                              </IconButton>
                            </span>
                          </Tooltip>
                          {canWrite ? (
                            <Tooltip title="Re-apply with same mapping">
                              <span>
                                <IconButton
                                  aria-label={t('aria.reapply')}
                                  size="small"
                                  disabled={
                                    reapplyMut.isPending ||
                                    job.status === 'APPLYING' ||
                                    !job.mapping_json
                                  }
                                  onClick={() => reapplyMut.mutate(job)}
                                >
                                  <ReplayOutlinedIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          ) : null}
                          {canCancel ? (
                            <Tooltip title="Cancel import">
                              <span>
                                <IconButton
                                  aria-label={`Cancel import ${job.id.slice(0, 8)}`}
                                  size="small"
                                  color="warning"
                                  disabled={cancelMut.isPending}
                                  onClick={() => setCancelTarget(job)}
                                >
                                  <CancelOutlinedIcon fontSize="small" />
                                </IconButton>
                              </span>
                            </Tooltip>
                          ) : null}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Stack>

      {cancelTarget ? (
        <ConfirmDialog
          open
          title="Cancel import?"
          description={`This will stop import ${cancelTarget.id.slice(0, 8)} (${cancelTarget.resource}).`}
          confirmText="Cancel import"
          cancelText="Keep running"
          loading={cancelMut.isPending}
          destructive
          onConfirm={() => cancelMut.mutate(cancelTarget)}
          onClose={() => setCancelTarget(null)}
        />
      ) : null}
    </>
  );
}
