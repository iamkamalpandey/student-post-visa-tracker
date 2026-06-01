'use client';

// Refactored to SVT form-pattern per design pass.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import {
  Box,
  Button,
  Chip,
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
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import ListPageShell from '@/components/ListPageShell';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import StatusChip from '@/components/StatusChip';
import ConfirmDialog from '@/components/ConfirmDialog';
import LabeledField from '@/components/LabeledField';
import {
  downloadAuthedBlob,
  EXPORTS_QK,
  readRecentExportIds,
  type ExportStatus,
} from '@/features/io/util';
import NewExportDialog from '@/features/io/NewExportDialog';

type ExportJob = {
  id: string;
  status: ExportStatus;
  resource: string;
  format: string;
  redact_pii: boolean;
  sha256: string | null;
  expires_at: string | null;
  row_total: number | null;
  created_at: string;
  download_url?: string;
};

const STATUS_FILTERS: Array<ExportStatus | 'all'> = [
  'all',
  'QUEUED',
  'RUNNING',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
];

function relTime(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  const diff = then - Date.now();
  const abs = Math.abs(diff);
  const sec = Math.round(abs / 1000);
  if (sec < 60) return diff > 0 ? `in ${sec}s` : `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return diff > 0 ? `in ${min}m` : `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return diff > 0 ? `in ${hr}h` : `${hr}h ago`;
  const d = Math.round(hr / 24);
  return diff > 0 ? `in ${d}d` : `${d}d ago`;
}

export default function ExportsPage() {
  const { user } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const t = useTranslations('exports');

  const [newOpen, setNewOpen] = useState(false);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [statusFilter, setStatusFilter] = useState<ExportStatus | 'all'>('all');
  const [resourceFilter, setResourceFilter] = useState<string>('all');
  const [cancelTarget, setCancelTarget] = useState<ExportJob | null>(null);

  const isViewer = user?.role === 'VIEWER';
  const canExport = !isViewer;

  useEffect(() => {
    setRecentIds(readRecentExportIds());
  }, []);

  const jobsQuery = useQuery<ExportJob[]>({
    queryKey: EXPORTS_QK.list(recentIds),
    queryFn: async () => {
      if (recentIds.length === 0) return [];
      const results = await Promise.allSettled(
        recentIds.map((id) => api.get<ExportJob>(`/exports/${id}`).then((r) => r.data)),
      );
      return results
        .filter((r): r is PromiseFulfilledResult<ExportJob> => r.status === 'fulfilled')
        .map((r) => r.value)
        .sort((a, b) => {
          const ax = a.created_at ?? '';
          const bx = b.created_at ?? '';
          return bx.localeCompare(ax);
        });
    },
    refetchInterval: (q) => {
      const data = q.state.data as ExportJob[] | undefined;
      if (!data) return 3000;
      return data.some((j) => j.status === 'QUEUED' || j.status === 'RUNNING') ? 3000 : false;
    },
  });

  const handleDownload = async (job: ExportJob) => {
    setDownloadingId(job.id);
    try {
      // Re-fetch to obtain a fresh signed URL (single-use nonce).
      const fresh = await api.get<ExportJob & { download_url?: string }>(`/exports/${job.id}`);
      const dl = fresh.data.download_url;
      if (!dl) {
        enqueueSnackbar('Download URL not available yet.', { variant: 'warning' });
        return;
      }
      const filename = `${job.resource}-${job.id}.${job.format}`;
      await downloadAuthedBlob(dl, filename);
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Download failed';
      enqueueSnackbar(msg, { variant: 'error' });
    } finally {
      setDownloadingId(null);
    }
  };

  const cancelMut = useMutation({
    mutationFn: async (id: string) => {
      await api.post(`/exports/${id}/cancel`, {});
    },
    onSuccess: () => {
      enqueueSnackbar('Export cancelled.', { variant: 'info' });
      void qc.invalidateQueries({ queryKey: EXPORTS_QK.all });
      setCancelTarget(null);
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Cancel failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

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

  const filters = (
    <>
      {/* Filter toolbar — size="small" by intent; SR-only labels via LabeledField. */}
      <LabeledField label="Status" srOnly htmlFor="exports-filter-status">
        <TextField
          id="exports-filter-status"
          select
          size="small"
          hiddenLabel
          placeholder="All statuses"
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as ExportStatus | 'all')}
          sx={{ minWidth: 180 }}
        >
          {STATUS_FILTERS.map((s) => (
            <MenuItem key={s} value={s}>
              {s === 'all' ? 'All statuses' : s}
            </MenuItem>
          ))}
        </TextField>
      </LabeledField>
      <LabeledField label="Resource" srOnly htmlFor="exports-filter-resource">
        <TextField
          id="exports-filter-resource"
          select
          size="small"
          hiddenLabel
          placeholder="All resources"
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
    </>
  );

  const isInline =
    jobsQuery.isLoading ||
    jobsQuery.isError ||
    (allRows.length === 0 && !jobsQuery.isFetching);

  return (
    <>
      <ListPageShell
        title="Exports"
        description="Server-streamed exports with optional PII redaction and SHA-256 integrity tags."
        action={
          <>
            <Tooltip title="Refresh">
              <span>
                <IconButton
                  aria-label={t('aria.refresh')}
                  onClick={() => qc.invalidateQueries({ queryKey: EXPORTS_QK.all })}
                  disabled={jobsQuery.isFetching}
                >
                  <RefreshIcon />
                </IconButton>
              </span>
            </Tooltip>
            {canExport ? (
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => setNewOpen(true)}>
                New export
              </Button>
            ) : null}
          </>
        }
        filters={filters}
        bareContent={isInline}
      >
        {jobsQuery.isLoading ? (
          <LoadingSkeleton variant="list" rows={6} />
        ) : jobsQuery.isError ? (
          <ErrorState
            title="Could not load exports"
            description={
              jobsQuery.error instanceof ApiError
                ? jobsQuery.error.detail || jobsQuery.error.title
                : 'Unexpected error'
            }
            onRetry={() => jobsQuery.refetch()}
            requestId={
              jobsQuery.error instanceof ApiError ? jobsQuery.error.requestId : undefined
            }
          />
        ) : allRows.length === 0 ? (
          <EmptyState
            title="No exports yet"
            description="Create one — CSV / XLSX / JSON / JSONL with redaction defaults to ON."
            actions={
              canExport ? (
                <Button variant="contained" startIcon={<AddIcon />} onClick={() => setNewOpen(true)}>
                  Create an export
                </Button>
              ) : undefined
            }
          />
        ) : rows.length === 0 ? (
          <Box sx={{ p: 2 }}>
            <EmptyState
              title="No exports match the filters"
              description="Try clearing the filters above."
            />
          </Box>
        ) : (
          <TableContainer component={Paper} variant="outlined" sx={{ border: 0 }}>
            <Table size="small" aria-label={t('aria.exportJobs')}>
              <TableHead>
                <TableRow>
                  <TableCell>Status</TableCell>
                  <TableCell>Resource</TableCell>
                  <TableCell>Format</TableCell>
                  <TableCell>PII</TableCell>
                  <TableCell>SHA-256</TableCell>
                  <TableCell>Expires</TableCell>
                  <TableCell align="right">Rows</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((job) => (
                  <TableRow key={job.id} hover>
                    <TableCell>
                      <StatusChip status={job.status} />
                    </TableCell>
                    <TableCell>{job.resource}</TableCell>
                    <TableCell>
                      <Chip size="small" label={job.format} variant="outlined" />
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        color={job.redact_pii ? 'success' : 'warning'}
                        label={job.redact_pii ? 'redacted' : 'full'}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell>
                      {job.sha256 ? (
                        <Tooltip title={job.sha256}>
                          <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
                            {job.sha256.slice(0, 12)}…
                          </Typography>
                        </Tooltip>
                      ) : (
                        '—'
                      )}
                    </TableCell>
                    <TableCell>
                      <Tooltip title={job.expires_at ?? ''}>
                        <span>{relTime(job.expires_at)}</span>
                      </Tooltip>
                    </TableCell>
                    <TableCell align="right">{job.row_total ?? '—'}</TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                        {job.status === 'COMPLETED' ? (
                          <Tooltip title="Download">
                            <span>
                              <IconButton
                                aria-label={`Download export ${job.id.slice(0, 8)}`}
                                size="small"
                                disabled={downloadingId === job.id}
                                onClick={() => handleDownload(job)}
                              >
                                {downloadingId === job.id ? (
                                  <CircularProgress size={16} />
                                ) : (
                                  <DownloadOutlinedIcon fontSize="small" />
                                )}
                              </IconButton>
                            </span>
                          </Tooltip>
                        ) : null}
                        {(job.status === 'QUEUED' || job.status === 'RUNNING') && canExport ? (
                          <Tooltip title="Cancel export">
                            <span>
                              <IconButton
                                aria-label={`Cancel export ${job.id.slice(0, 8)}`}
                                size="small"
                                color="warning"
                                onClick={() => setCancelTarget(job)}
                                disabled={cancelMut.isPending}
                              >
                                <CancelOutlinedIcon fontSize="small" />
                              </IconButton>
                            </span>
                          </Tooltip>
                        ) : null}
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </ListPageShell>

      <NewExportDialog
        open={newOpen}
        onClose={() => setNewOpen(false)}
        onCreated={(id) => {
          setRecentIds(readRecentExportIds());
          void qc.invalidateQueries({ queryKey: EXPORTS_QK.all });
          enqueueSnackbar(`Export ${id.slice(0, 8)} queued`, { variant: 'success' });
        }}
      />

      {cancelTarget ? (
        <ConfirmDialog
          open={Boolean(cancelTarget)}
          title="Cancel export"
          description={
            <Typography variant="body2">
              Cancel the {cancelTarget.resource} export queued{' '}
              {relTime(cancelTarget.created_at)}? Already-streamed bytes will be discarded.
            </Typography>
          }
          confirmText="Cancel export"
          cancelText="Keep running"
          loading={cancelMut.isPending}
          onConfirm={() => cancelMut.mutate(cancelTarget.id)}
          onClose={() => (cancelMut.isPending ? undefined : setCancelTarget(null))}
        />
      ) : null}
    </>
  );
}
