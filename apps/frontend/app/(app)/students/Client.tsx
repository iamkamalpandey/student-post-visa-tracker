'use client';

// Refactored to SVT form-pattern
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import {
  Box,
  Button,
  Checkbox,
  Chip,
  Drawer,
  FormControlLabel,
  IconButton,
  InputAdornment,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TablePagination,
  TableRow,
  TextField,
  Toolbar,
  Tooltip,
  Typography,
} from '@mui/material';
import PersonAddAlt1OutlinedIcon from '@mui/icons-material/PersonAddAlt1Outlined';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import FileDownloadOutlinedIcon from '@mui/icons-material/FileDownloadOutlined';
import ViewColumnOutlinedIcon from '@mui/icons-material/ViewColumnOutlined';

import EmptyState from '@/components/EmptyState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import ErrorState from '@/components/ErrorState';
import LabeledField from '@/components/LabeledField';
import StatusChip from '@/components/StatusChip';
import DensityToggle from '@/components/DensityToggle';
import ConfirmDialog from '@/components/ConfirmDialog';
import { useDensity } from '@/lib/useDensity';
import { usePrefetchStudent } from '@/lib/usePrefetchStudent';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { canWriteStudents } from '@/lib/auth-helpers';
import StudentQuickCreate from '@/features/students/StudentQuickCreate';
import type { StudentsResponse } from '@/features/students/types';

type StageOption = {
  id: string;
  key: string;
  label: string;
  sequence: number;
  category: string;
  color_hex?: string | null;
  is_initial?: boolean;
};

const STATUS_OPTION_VALUES: { value: string; key: 'all' | 'active' | 'onHold' | 'withdrawn' | 'completed' | 'deferred' }[] = [
  { value: '', key: 'all' },
  { value: 'ACTIVE', key: 'active' },
  { value: 'ON_HOLD', key: 'onHold' },
  { value: 'WITHDRAWN', key: 'withdrawn' },
  { value: 'COMPLETED', key: 'completed' },
  { value: 'DEFERRED', key: 'deferred' },
];

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

// SVT-WAVE-POLISH-2026-05 — Column visibility config. `key` is the persisted
// id; `code` and `name` are required (always-on) so the row stays scannable.
type ColumnKey = 'code' | 'name' | 'stage' | 'status' | 'nationality' | 'created';
const COLUMN_DEFS: { key: ColumnKey; required?: boolean; defaultVisible: boolean }[] = [
  { key: 'code', required: true, defaultVisible: true },
  { key: 'name', required: true, defaultVisible: true },
  { key: 'stage', defaultVisible: true },
  { key: 'status', defaultVisible: true },
  { key: 'nationality', defaultVisible: true },
  { key: 'created', defaultVisible: true },
];
const COLUMN_STORAGE_KEY = 'spv:students-cols';

function readStoredColumns(): Record<ColumnKey, boolean> {
  const defaults = Object.fromEntries(
    COLUMN_DEFS.map((c) => [c.key, c.defaultVisible]),
  ) as Record<ColumnKey, boolean>;
  if (typeof window === 'undefined') return defaults;
  try {
    const raw = window.localStorage.getItem(COLUMN_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<Record<ColumnKey, boolean>>;
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

const dateFmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function relativeFromNow(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diffSec = Math.round((then - now) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 60) return dateFmt.format(diffSec, 'second');
  if (abs < 3600) return dateFmt.format(Math.round(diffSec / 60), 'minute');
  if (abs < 86400) return dateFmt.format(Math.round(diffSec / 3600), 'hour');
  if (abs < 86400 * 30) return dateFmt.format(Math.round(diffSec / 86400), 'day');
  if (abs < 86400 * 365) return dateFmt.format(Math.round(diffSec / (86400 * 30)), 'month');
  return dateFmt.format(Math.round(diffSec / (86400 * 365)), 'year');
}

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function StudentsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { enqueueSnackbar } = useSnackbar();
  const t = useTranslations('students.list');
  const tCommon = useTranslations('common');
  const { user } = useAuth();
  const canWrite = canWriteStudents(user?.role);

  const [search, setSearch] = useState<string>(() => searchParams?.get('search') ?? '');
  const [stageId, setStageId] = useState<string>(() => searchParams?.get('stage_id') ?? '');
  const [status, setStatus] = useState<string>(() => searchParams?.get('status') ?? '');
  // SVT-WAVE39-STUDENT-SLA-FILTER-2026-05 — URL-driven toggle. Comes from
  // the /inbox SLA tile. Pinned client state so the filter chip can clear it.
  const [slaBreached, setSlaBreached] = useState<boolean>(
    () => searchParams?.get('sla_breached') === 'true',
  );
  const [pageSize, setPageSize] = useState<number>(() => {
    const n = Number(searchParams?.get('limit'));
    return PAGE_SIZE_OPTIONS.includes(n) ? n : 25;
  });
  const [pageIndex, setPageIndex] = useState<number>(() => {
    const n = Number(searchParams?.get('page'));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [density] = useDensity();
  const tableSize: 'small' | 'medium' = density === 'compact' ? 'small' : 'medium';
  const prefetch = usePrefetchStudent();

  // SVT-WAVE-POLISH-2026-05 — bulk-select state. Keyed by student.id so
  // selections survive page/sort changes within the same filter window.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // Column visibility (persisted). Drawer state for the toggle UI.
  const [columns, setColumns] = useState<Record<ColumnKey, boolean>>(() => {
    // Defaults match SSR; hydrate from localStorage in an effect below.
    return Object.fromEntries(
      COLUMN_DEFS.map((c) => [c.key, c.defaultVisible]),
    ) as Record<ColumnKey, boolean>;
  });
  const [columnsOpen, setColumnsOpen] = useState(false);
  useEffect(() => {
    setColumns(readStoredColumns());
  }, []);
  const setColumnVisible = useCallback((key: ColumnKey, visible: boolean) => {
    setColumns((prev) => {
      const next = { ...prev, [key]: visible };
      try {
        window.localStorage.setItem(COLUMN_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // ignore localStorage write failures (private mode)
      }
      return next;
    });
  }, []);
  const isColVisible = (key: ColumnKey) =>
    COLUMN_DEFS.find((c) => c.key === key)?.required ? true : columns[key];

  // Bulk-action dialogs.
  const [bulkAction, setBulkAction] = useState<null | 'export'>(null);
  const [bulkBusy, setBulkBusy] = useState(false);

  // SVT-WAVE-POLISH-2026-05 — `c` keyboard shortcut: AppShell dispatches a
  // `spv:open-create-student` window event; whichever surface is mounted
  // catches it. On /students that's this component.
  useEffect(() => {
    if (!canWrite) return;
    const onOpen = () => setCreateOpen(true);
    window.addEventListener('spv:open-create-student', onOpen);
    return () => window.removeEventListener('spv:open-create-student', onOpen);
  }, [canWrite]);

  const debouncedSearch = useDebounced(search, 300);

  // Sync URL — filters, page size, AND page index are bookmarkable now.
  useEffect(() => {
    const params = new URLSearchParams();
    if (debouncedSearch) params.set('search', debouncedSearch);
    if (stageId) params.set('stage_id', stageId);
    if (status) params.set('status', status);
    if (slaBreached) params.set('sla_breached', 'true');
    if (pageSize !== 25) params.set('limit', String(pageSize));
    if (pageIndex !== 0) params.set('page', String(pageIndex));
    const qs = params.toString();
    router.replace(qs ? `/students?${qs}` : '/students');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, stageId, status, slaBreached, pageSize, pageIndex]);

  // Filter changes reset page + clear selection. Page-only navigation does
  // not clear selection so a user can multi-select across pages.
  useEffect(() => {
    setPageIndex(0);
    clearSelection();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, stageId, status, slaBreached, pageSize]);

  // Stages (for the filter and StudentQuickCreate)
  const stagesQuery = useQuery({
    queryKey: ['stages'],
    queryFn: async (): Promise<StageOption[]> => {
      const res = await api.get<{ data: StageOption[] }>('/stages');
      return res.data.data;
    },
    staleTime: 5 * 60_000,
  });

  // Students list — server-driven query string
  const listQuery = useQuery<StudentsResponse, ApiError>({
    queryKey: ['students', { search: debouncedSearch, stageId, status, slaBreached, pageSize }],
    queryFn: async () => {
      const params: Record<string, string | number> = { limit: pageSize };
      if (debouncedSearch) params['search'] = debouncedSearch;
      if (stageId) params['stage_id'] = stageId;
      if (status) params['status'] = status;
      if (slaBreached) params['sla_breached'] = 'true';
      const res = await api.get<StudentsResponse>('/students', { params });
      return res.data;
    },
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    if (listQuery.error) {
      enqueueSnackbar(listQuery.error.detail || listQuery.error.title || t('failedToLoad'), {
        variant: 'error',
      });
    }
  }, [listQuery.error, enqueueSnackbar, t]);

  const rows = listQuery.data?.data ?? [];
  const total = listQuery.data?.page.total ?? rows.length;

  const stagesById = useMemo(() => {
    const map = new Map<string, StageOption>();
    for (const s of stagesQuery.data ?? []) map.set(s.id, s);
    return map;
  }, [stagesQuery.data]);

  const handleResetFilters = () => {
    setSearch('');
    setStageId('');
    setStatus('');
    setSlaBreached(false);
  };

  // SVT-WAVE-HIGH-4-2026-05 — students list export (CSV).
  //
  // Reuses the existing /exports pipeline (POST → poll → download URL). Filter
  // shape mirrors what the list query sends so the export is an exact
  // representation of what the user sees on screen. Backend already enforces
  // RBAC + PII redaction via redact_pii: true (counsellors get masked
  // passport/sponsor data; ADMIN can fetch full-PII via a separate flag).
  const [exporting, setExporting] = useState(false);
  const handleExport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const filter: Record<string, string | boolean> = {};
      if (debouncedSearch) filter['search'] = debouncedSearch;
      if (stageId) filter['stage_id'] = stageId;
      if (status) filter['status'] = status;
      if (slaBreached) filter['sla_breached'] = true;
      const create = await api.post<{ id: string }>('/exports', {
        resource: 'students',
        format: 'csv',
        filter,
        redact_pii: true,
        locale: 'en',
        timezone: 'UTC',
      });
      const jobId = create.data.id;
      enqueueSnackbar('Export queued — building…', { variant: 'info' });
      const deadline = Date.now() + 60_000;
      let downloadUrl: string | null = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        const status2 = await api.get<{ status: string; download_url?: string }>(
          `/exports/${jobId}`,
        );
        if (status2.data.status === 'COMPLETED' && status2.data.download_url) {
          downloadUrl = status2.data.download_url;
          break;
        }
        if (status2.data.status === 'FAILED') {
          throw new Error('Export job failed');
        }
      }
      if (!downloadUrl) {
        enqueueSnackbar('Export still building — check Reports for the file.', { variant: 'warning' });
        return;
      }
      // Trigger browser download.
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = `students-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      enqueueSnackbar('Export ready — downloading.', { variant: 'success' });
    } catch (err) {
      const msg = err instanceof ApiError ? err.detail || err.title : err instanceof Error ? err.message : 'Export failed';
      enqueueSnackbar(msg, { variant: 'error' });
    } finally {
      setExporting(false);
    }
  };

  const showEmpty =
    !listQuery.isLoading &&
    !listQuery.isError &&
    rows.length === 0 &&
    !debouncedSearch &&
    !stageId &&
    !status &&
    !slaBreached;

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        justifyContent="space-between"
      >
        <Stack spacing={0.75}>
          <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
            {t('title')}
          </Typography>
          <Typography variant="body1" color="text.secondary">
            {t('description')}
          </Typography>
        </Stack>
        {canWrite && (
          <Button
            variant="contained"
            startIcon={<PersonAddAlt1OutlinedIcon />}
            onClick={() => setCreateOpen(true)}
          >
            {t('addStudent')}
          </Button>
        )}
      </Stack>

      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
          <LabeledField label={t('searchPlaceholder')} srOnly htmlFor="students-filter-search">
            <TextField
              id="students-filter-search"
              size="small"
              placeholder={t('searchPlaceholder')}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              sx={{ flexGrow: 1, minWidth: 220, width: '100%' }}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchOutlinedIcon fontSize="small" />
                  </InputAdornment>
                ),
                endAdornment: search ? (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      aria-label={t('clearSearch')}
                      onClick={() => setSearch('')}
                    >
                      <ClearOutlinedIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
              }}
            />
          </LabeledField>
          <LabeledField label={t('stage')} srOnly htmlFor="students-filter-stage">
            <TextField
              id="students-filter-stage"
              size="small"
              select
              hiddenLabel
              value={stageId}
              onChange={(e) => setStageId(e.target.value)}
              sx={{ minWidth: 200, width: '100%' }}
            >
              <MenuItem value="">{t('allStages')}</MenuItem>
              {(stagesQuery.data ?? []).map((s) => (
                <MenuItem key={s.id} value={s.id}>
                  {s.label}
                </MenuItem>
              ))}
            </TextField>
          </LabeledField>
          <LabeledField label={t('statusLabel')} srOnly htmlFor="students-filter-status">
            <TextField
              id="students-filter-status"
              size="small"
              select
              hiddenLabel
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              sx={{ minWidth: 180, width: '100%' }}
            >
              {STATUS_OPTION_VALUES.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {t(`statusOptions.${o.key}`)}
                </MenuItem>
              ))}
            </TextField>
          </LabeledField>
          {/* SVT-WAVE39-STUDENT-SLA-FILTER-2026-05 — chip toggles the
              boolean filter; URL stays in sync via the useEffect above. */}
          <Chip
            size="small"
            color={slaBreached ? 'warning' : 'default'}
            variant={slaBreached ? 'filled' : 'outlined'}
            label="SLA breached"
            onClick={() => setSlaBreached((v) => !v)}
            onDelete={slaBreached ? () => setSlaBreached(false) : undefined}
          />
          {(search || stageId || status || slaBreached) && (
            <Button onClick={handleResetFilters} size="small" startIcon={<ClearOutlinedIcon />}>
              {tCommon('reset')}
            </Button>
          )}
          {/* SVT-WAVE-HIGH-4-2026-05 — CSV export of the current filter. */}
          <Button
            size="small"
            variant="outlined"
            startIcon={<FileDownloadOutlinedIcon />}
            onClick={handleExport}
            disabled={exporting || listQuery.isLoading}
            aria-label="Export students list to CSV"
          >
            {exporting ? 'Exporting…' : 'Export CSV'}
          </Button>
          <Tooltip title="Choose columns" arrow>
            <IconButton
              size="small"
              aria-label="Choose columns"
              onClick={() => setColumnsOpen(true)}
            >
              <ViewColumnOutlinedIcon fontSize="small" />
            </IconButton>
          </Tooltip>
          <DensityToggle />
          <IconButton
            size="small"
            aria-label={t('refresh')}
            onClick={() => listQuery.refetch()}
            disabled={listQuery.isFetching}
          >
            <RefreshOutlinedIcon fontSize="small" />
          </IconButton>
        </Stack>
      </Paper>

      {/* SVT-WAVE-POLISH-2026-05 — bulk-action toolbar. Appears when rows
          are selected. Actions confirmed via ConfirmDialog with the count. */}
      {selected.size > 0 ? (
        <Paper
          variant="outlined"
          sx={{
            px: 2,
            py: 1,
            borderRadius: 2,
            borderColor: 'primary.main',
            bgcolor: (t) => t.palette.action.hover,
          }}
          role="toolbar"
          aria-label="Bulk actions"
        >
          <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap">
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {selected.size} selected
            </Typography>
            <Box sx={{ flex: 1 }} />
            <Button size="small" variant="outlined" onClick={() => setBulkAction('export')}>
              Export selected
            </Button>
            <Button size="small" onClick={clearSelection}>
              Clear
            </Button>
          </Stack>
        </Paper>
      ) : null}

      {listQuery.isLoading ? (
        <LoadingSkeleton variant="list" rows={6} />
      ) : listQuery.isError ? (
        <ErrorState
          title={t('couldNotLoad')}
          description={listQuery.error?.detail || listQuery.error?.title}
          onRetry={() => listQuery.refetch()}
          requestId={listQuery.error?.requestId}
        />
      ) : showEmpty ? (
        <EmptyState
          icon={<GroupsOutlinedIcon fontSize="medium" />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
          actions={
            canWrite ? (
              <Button
                variant="contained"
                startIcon={<PersonAddAlt1OutlinedIcon />}
                onClick={() => setCreateOpen(true)}
              >
                {t('addStudent')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Paper variant="outlined" sx={{ borderRadius: 2 }}>
          <TableContainer>
            <Table size={tableSize} aria-label={t('ariaLabel')}>
              <TableHead>
                <TableRow
                  sx={{
                    '& .MuiTableCell-head': {
                      fontSize: 12,
                      fontWeight: 600,
                      letterSpacing: 0.4,
                      textTransform: 'uppercase',
                      color: 'text.secondary',
                      borderTop: (theme) => `1px solid ${theme.palette.divider}`,
                      borderBottom: (theme) => `1px solid ${theme.palette.divider}`,
                      bgcolor: (theme) => theme.palette.action.hover,
                    },
                  }}
                >
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      indeterminate={selected.size > 0 && selected.size < rows.length}
                      checked={rows.length > 0 && selected.size === rows.length}
                      onChange={(e) => {
                        if (e.target.checked) setSelected(new Set(rows.map((r) => r.id)));
                        else clearSelection();
                      }}
                      inputProps={{ 'aria-label': 'Select all rows on this page' }}
                    />
                  </TableCell>
                  {isColVisible('code') && <TableCell>{t('columns.code')}</TableCell>}
                  {isColVisible('name') && <TableCell>{t('columns.name')}</TableCell>}
                  {isColVisible('stage') && <TableCell>{t('columns.stage')}</TableCell>}
                  {isColVisible('status') && <TableCell>{t('columns.status')}</TableCell>}
                  {isColVisible('nationality') && <TableCell>{t('columns.nationality')}</TableCell>}
                  {isColVisible('created') && <TableCell>{t('columns.created')}</TableCell>}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7}>
                      <Stack
                        spacing={1}
                        alignItems="center"
                        sx={{ py: 4, color: 'text.secondary' }}
                      >
                        {/* SVT-WAVE53-EMPTY-STATE-2026-05 — special-case the
                            SLA-breach filter so admins land here from the
                            KPI tile and immediately understand a quiet day
                            is good news. */}
                        {slaBreached && rows.length === 0 ? (
                          <>
                            <Typography variant="body2" sx={{ color: 'success.main' }}>
                              No SLA breaches — every active student is inside their stage SLA.
                            </Typography>
                            <Button size="small" onClick={handleResetFilters}>
                              Show all students
                            </Button>
                          </>
                        ) : (
                          <>
                            <Typography variant="body2">
                              {t('noMatchesHint')}
                            </Typography>
                            <Button size="small" onClick={handleResetFilters}>
                              {t('clearFilters')}
                            </Button>
                          </>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                ) : (
                  rows.map((row) => {
                    const joined = row.current_stage;
                    const catalog = row.current_stage_id ? stagesById.get(row.current_stage_id) : null;
                    const stage = joined ?? catalog ?? null;
                    // The /students endpoint omits color_hex; pull it from the catalog.
                    const colorHex = catalog?.color_hex ?? joined?.color_hex ?? null;
                    const isSelected = selected.has(row.id);
                    return (
                        <TableRow
                          hover
                          key={row.id}
                          selected={isSelected}
                          onClick={(e) => {
                            // Clicking inside the checkbox cell shouldn't navigate.
                            if ((e.target as HTMLElement).closest('[data-row-cb]')) return;
                            router.push(`/students/${row.id}`);
                          }}
                          onMouseEnter={() => prefetch.onEnter(row.id, `/students/${row.id}`)}
                          onMouseLeave={prefetch.onLeave}
                          sx={{ cursor: 'pointer' }}
                          tabIndex={0}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') router.push(`/students/${row.id}`);
                            if (e.key === ' ') {
                              e.preventDefault();
                              setSelected((prev) => {
                                const next = new Set(prev);
                                if (next.has(row.id)) next.delete(row.id);
                                else next.add(row.id);
                                return next;
                              });
                            }
                          }}
                        >
                          <TableCell padding="checkbox" data-row-cb>
                            <Checkbox
                              size="small"
                              checked={isSelected}
                              onChange={(e) => {
                                setSelected((prev) => {
                                  const next = new Set(prev);
                                  if (e.target.checked) next.add(row.id);
                                  else next.delete(row.id);
                                  return next;
                                });
                              }}
                              inputProps={{ 'aria-label': `Select ${row.student_code}` }}
                            />
                          </TableCell>
                          {isColVisible('code') && (
                            <TableCell>
                              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                                {row.student_code}
                              </Typography>
                            </TableCell>
                          )}
                          {isColVisible('name') && (
                            <TableCell>
                              <Typography variant="body2" sx={{ fontWeight: 500 }}>
                                {row.given_name} {row.family_name}
                              </Typography>
                            </TableCell>
                          )}
                          {isColVisible('stage') && (
                            <TableCell>
                              {stage ? (
                                <Chip
                                  size="small"
                                  label={stage.label}
                                  sx={
                                    colorHex
                                      ? {
                                          bgcolor: `${colorHex}1f`,
                                          color: colorHex,
                                          fontWeight: 500,
                                          borderColor: colorHex,
                                        }
                                      : { fontWeight: 500 }
                                  }
                                  variant={colorHex ? 'outlined' : 'filled'}
                                />
                              ) : (
                                <Typography variant="caption" color="text.disabled">
                                  –
                                </Typography>
                              )}
                            </TableCell>
                          )}
                          {isColVisible('status') && (
                            <TableCell>
                              <StatusChip status={row.status} />
                            </TableCell>
                          )}
                          {isColVisible('nationality') && (
                            <TableCell>{row.nationality_code}</TableCell>
                          )}
                          {isColVisible('created') && (
                            <TableCell>
                              <Typography variant="body2" color="text.secondary">
                                {relativeFromNow(row.created_at)}
                              </Typography>
                            </TableCell>
                          )}
                        </TableRow>
                      );
                  })
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div"
            count={total}
            page={pageIndex}
            rowsPerPage={pageSize}
            rowsPerPageOptions={PAGE_SIZE_OPTIONS}
            onPageChange={(_, p) => setPageIndex(p)}
            onRowsPerPageChange={(e) => setPageSize(parseInt(e.target.value, 10))}
            // Note: cursor pagination only supports forward navigation server-side.
            // For now we render the current page-size window and rely on filters
            // for navigation; the page count is informational.
          />
        </Paper>
      )}

      <StudentQuickCreate
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        stages={stagesQuery.data ?? []}
      />

      {/* SVT-WAVE-POLISH-2026-05 — column visibility drawer. Required
          columns (code, name) can't be toggled off. Stored under
          spv:students-cols. */}
      <Drawer
        anchor="right"
        open={columnsOpen}
        onClose={() => setColumnsOpen(false)}
        PaperProps={{ sx: { width: 320 } }}
      >
        <Box sx={{ p: 2.5 }}>
          <Typography variant="h6" sx={{ fontWeight: 600, mb: 0.5 }}>
            Columns
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Toggle the columns shown in this view. Saved for next visit.
          </Typography>
          <Stack spacing={0.5}>
            {COLUMN_DEFS.map((col) => {
              const label = t(`columns.${col.key}`);
              return (
                <FormControlLabel
                  key={col.key}
                  control={
                    <Checkbox
                      checked={isColVisible(col.key)}
                      disabled={col.required}
                      onChange={(e) => setColumnVisible(col.key, e.target.checked)}
                    />
                  }
                  label={
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography variant="body2">{label}</Typography>
                      {col.required ? (
                        <Chip size="small" label="required" variant="outlined" sx={{ height: 18 }} />
                      ) : null}
                    </Stack>
                  }
                />
              );
            })}
          </Stack>
        </Box>
      </Drawer>

      <ConfirmDialog
        open={bulkAction === 'export'}
        onClose={() => (bulkBusy ? undefined : setBulkAction(null))}
        title="Export selected students?"
        description={
          <Typography variant="body2">
            Build a CSV of the <strong>{selected.size}</strong> selected
            student{selected.size === 1 ? '' : 's'}. PII is redacted for
            counsellor exports per tenant policy.
          </Typography>
        }
        confirmText="Export"
        destructive={false}
        loading={bulkBusy}
        onConfirm={async () => {
          if (bulkBusy) return;
          setBulkBusy(true);
          try {
            const ids = Array.from(selected);
            const create = await api.post<{ id: string }>('/exports', {
              resource: 'students',
              format: 'csv',
              filter: { ids },
              redact_pii: true,
              locale: 'en',
              timezone: 'UTC',
            });
            const jobId = create.data.id;
            enqueueSnackbar(`Export queued for ${ids.length} students…`, { variant: 'info' });
            const deadline = Date.now() + 60_000;
            let downloadUrl: string | null = null;
            while (Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 1500));
              const s = await api.get<{ status: string; download_url?: string }>(
                `/exports/${jobId}`,
              );
              if (s.data.status === 'COMPLETED' && s.data.download_url) {
                downloadUrl = s.data.download_url;
                break;
              }
              if (s.data.status === 'FAILED') throw new Error('Export job failed');
            }
            if (!downloadUrl) {
              enqueueSnackbar('Still building — check Reports.', { variant: 'warning' });
            } else {
              const a = document.createElement('a');
              a.href = downloadUrl;
              a.download = `students-${new Date().toISOString().slice(0, 10)}.csv`;
              document.body.appendChild(a);
              a.click();
              document.body.removeChild(a);
              enqueueSnackbar('Export ready — downloading.', { variant: 'success' });
              clearSelection();
            }
          } catch (err) {
            const msg = err instanceof ApiError ? err.detail || err.title : err instanceof Error ? err.message : 'Export failed';
            enqueueSnackbar(msg, { variant: 'error' });
          } finally {
            setBulkBusy(false);
            setBulkAction(null);
          }
        }}
      />
    </Stack>
  );
}
