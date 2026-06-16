// Refactored to SVT form-pattern
// Lifted from app/(app)/reminders/Client.tsx — page-level <ListPageShell>
// header is dropped (parent /inbox renders heading + tabs). Filters, query
// keys, mutations, dialogs and row actions are preserved verbatim so the
// TanStack cache (`['reminders', filters]`) keeps working across the move.
//
// Filter toolbar inputs are wrapped in <LabeledField srOnly htmlFor> so AT
// users get the same affordance sighted users get from the placeholder /
// floating label. URL `?tab=tasks&status=PENDING` deep-links wire straight
// into local filter state via `useSearchParams()` in the initialiser below.

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import {
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  IconButton,
  InputAdornment,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import DoneAllOutlinedIcon from '@mui/icons-material/DoneAllOutlined';
import SnoozeOutlinedIcon from '@mui/icons-material/SnoozeOutlined';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import NotificationsActiveOutlinedIcon from '@mui/icons-material/NotificationsActiveOutlined';

import DataTable, { type DataTableColumn } from '@/components/DataTable';
import StatusChip from '@/components/StatusChip';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import ErrorState from '@/components/ErrorState';
import EmptyState from '@/components/EmptyState';
import ConfirmDialog from '@/components/ConfirmDialog';
import LabeledField from '@/components/LabeledField';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { canWriteStudents, isAdmin } from '@/lib/auth-helpers';
import { useReminders, useUsersLite, type ReminderRow } from '@/lib/queries';
import { formatDate, formatRelative } from '@/lib/format';
import CreateReminderDialog from '@/features/reminders/CreateReminderDialog';
import EditReminderDialog from '@/features/reminders/EditReminderDialog';
import SnoozeDialog from '@/features/reminders/SnoozeDialog';
import {
  REMINDER_STATUSES,
  REMINDER_TYPES,
  REMINDER_TYPE_COLORS,
  assigneeLabel,
  prettifyType,
  studentLabel,
  type Reminder,
  type ReminderType,
} from '@/features/reminders/types';

const PAGE_SIZE_OPTIONS = [25, 50, 100];

function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

// Hours-based comparison so we don't drop into "yesterday" at 11:59pm UTC
// because the server formatted with a different offset than the browser.
function dueBucket(dueOn: string): 'overdue' | 'soon' | 'ok' {
  if (!dueOn) return 'ok';
  const due = new Date(`${dueOn}T23:59:59`).getTime();
  const now = Date.now();
  const diffMs = due - now;
  const day = 24 * 60 * 60 * 1000;
  if (diffMs < 0) return 'overdue';
  // Treat "today" as overdue-orange so counsellors don't lose same-day items.
  if (diffMs < day) return 'overdue';
  if (diffMs < 7 * day) return 'soon';
  return 'ok';
}

function dueColors(bucket: 'overdue' | 'soon' | 'ok'): { bg: string; fg: string } {
  switch (bucket) {
    case 'overdue':
      return { bg: '#FFEBEE', fg: '#B71C1C' };
    case 'soon':
      return { bg: '#FFF8E1', fg: '#8D6E00' };
    default:
      return { bg: '#E8F5E9', fg: '#2E7D32' };
  }
}

function TypeChip({ type }: { type: string }) {
  const swatch = REMINDER_TYPE_COLORS[type as ReminderType] ?? null;
  return (
    <Chip
      size="small"
      label={prettifyType(type)}
      sx={{
        bgcolor: swatch?.bg ?? 'action.selected',
        color: swatch?.fg ?? 'text.primary',
        fontWeight: 600,
        border: 'none',
      }}
    />
  );
}

function DueBadge({ dueOn }: { dueOn: string }) {
  const bucket = dueBucket(dueOn);
  const { bg, fg } = dueColors(bucket);
  const t = useTranslations('reminders.list.badges');
  const label =
    bucket === 'overdue' ? t('overdue') : bucket === 'soon' ? t('dueSoon') : null;
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <Typography variant="body2" sx={{ fontWeight: 500 }}>
        {formatDate(dueOn)}
      </Typography>
      {label ? (
        <Chip
          size="small"
          label={label}
          sx={{ bgcolor: bg, color: fg, fontWeight: 600, border: 'none', height: 20 }}
        />
      ) : null}
    </Stack>
  );
}

export default function RemindersTab() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { user } = useAuth();
  const admin = isAdmin(user?.role);
  const canWrite = canWriteStudents(user?.role);
  const t = useTranslations('reminders.list');
  const tToast = useTranslations('reminders.list.toasts');
  const tCommon = useTranslations('common');

  // ---- Filters (URL-synced under /inbox?tab=tasks&...) ------------------
  const [q, setQ] = useState<string>(() => searchParams?.get('q') ?? '');
  const [status, setStatus] = useState<string>(() => searchParams?.get('status') ?? 'PENDING');
  const [type, setType] = useState<string>(() => searchParams?.get('type') ?? 'all');
  const [assignedToId, setAssignedToId] = useState<string>(() => {
    const fromUrl = searchParams?.get('assigned_to_id');
    if (fromUrl) return fromUrl;
    return admin ? '' : (user?.id ?? '');
  });
  const [dueFrom, setDueFrom] = useState<string>(() => searchParams?.get('due_from') ?? '');
  const [dueTo, setDueTo] = useState<string>(() => searchParams?.get('due_to') ?? '');
  const [pageSize, setPageSize] = useState<number>(() => {
    const n = Number(searchParams?.get('limit'));
    return PAGE_SIZE_OPTIONS.includes(n) ? n : 25;
  });
  const [pageIndex, setPageIndex] = useState(0);

  const debouncedQ = useDebounced(q, 300);

  // Sync filters → URL, preserving ?tab=tasks so a deep-link share lands on
  // the right inbox tab with the same filter state.
  useEffect(() => {
    const params = new URLSearchParams();
    params.set('tab', 'tasks');
    if (debouncedQ) params.set('q', debouncedQ);
    if (status && status !== 'all') params.set('status', status);
    if (type && type !== 'all') params.set('type', type);
    if (assignedToId) params.set('assigned_to_id', assignedToId);
    if (dueFrom) params.set('due_from', dueFrom);
    if (dueTo) params.set('due_to', dueTo);
    if (pageSize !== 25) params.set('limit', String(pageSize));
    router.replace(`/inbox?${params.toString()}`);
    setPageIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedQ, status, type, assignedToId, dueFrom, dueTo, pageSize]);

  const listQuery = useReminders({
    q: debouncedQ || undefined,
    status: status === 'all' ? undefined : status,
    type: type === 'all' ? undefined : type,
    assigned_to_id: assignedToId || undefined,
    due_from: dueFrom || undefined,
    due_to: dueTo || undefined,
    limit: pageSize,
  });
  const usersQuery = useUsersLite(admin);

  useEffect(() => {
    if (listQuery.error) {
      enqueueSnackbar(
        listQuery.error instanceof ApiError
          ? listQuery.error.detail || listQuery.error.title || t('failedToLoad')
          : t('failedToLoad'),
        { variant: 'error' },
      );
    }
  }, [listQuery.error, enqueueSnackbar, t]);

  const allRows: ReminderRow[] = listQuery.data?.data ?? [];
  const rows = useMemo(() => {
    if (!debouncedQ) return allRows;
    const needle = debouncedQ.toLowerCase();
    return allRows.filter((r) => r.title?.toLowerCase().includes(needle));
  }, [allRows, debouncedQ]);
  const total = listQuery.data?.page.total ?? rows.length;

  function bumpCaches() {
    qc.invalidateQueries({ queryKey: ['reminders'] });
  }

  const ackMutation = useMutation<unknown, ApiError, string>({
    mutationFn: async (id) => (await api.post(`/reminders/${id}/acknowledge`)).data,
    onSuccess: () => {
      enqueueSnackbar(tToast('acknowledged'), { variant: 'success' });
      bumpCaches();
    },
    onError: (err) =>
      enqueueSnackbar(err.detail || err.title || tToast('ackError'), { variant: 'error' }),
  });

  const dismissMutation = useMutation<unknown, ApiError, string>({
    mutationFn: async (id) => (await api.post(`/reminders/${id}/dismiss`)).data,
    onSuccess: () => {
      enqueueSnackbar(tToast('dismissed'), { variant: 'success' });
      bumpCaches();
    },
    onError: (err) =>
      enqueueSnackbar(err.detail || err.title || tToast('dismissError'), { variant: 'error' }),
  });

  const deleteMutation = useMutation<unknown, ApiError, string>({
    mutationFn: async (id) => (await api.delete(`/reminders/${id}`)).data,
    onSuccess: () => {
      enqueueSnackbar(tToast('deleted'), { variant: 'success' });
      bumpCaches();
      setDeleteTarget(null);
    },
    onError: (err) =>
      enqueueSnackbar(err.detail || err.title || tToast('deleteError'), { variant: 'error' }),
  });

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Reminder | null>(null);
  const [snoozeTarget, setSnoozeTarget] = useState<Reminder | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Reminder | null>(null);
  const [rowMenu, setRowMenu] = useState<{ anchor: HTMLElement; row: Reminder } | null>(null);

  function closeMenu() {
    setRowMenu(null);
  }

  const hasFilter =
    Boolean(debouncedQ) ||
    (status && status !== 'PENDING') ||
    (type && type !== 'all') ||
    Boolean(assignedToId) ||
    Boolean(dueFrom) ||
    Boolean(dueTo);

  function resetFilters() {
    setQ('');
    setStatus('PENDING');
    setType('all');
    setAssignedToId(admin ? '' : (user?.id ?? ''));
    setDueFrom('');
    setDueTo('');
  }

  const usersOptions = usersQuery.data ?? [];
  const selectedAssignee = usersOptions.find((u) => u.id === assignedToId) ?? null;

  const filters = (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      spacing={1.5}
      alignItems={{ xs: 'stretch', md: 'center' }}
      flexWrap="wrap"
      useFlexGap
    >
      <LabeledField label={t('searchPlaceholder')} srOnly htmlFor="reminders-filter-search">
        <TextField
          id="reminders-filter-search"
          size="small"
          hiddenLabel
          placeholder={t('searchPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          sx={{ flexGrow: 1, minWidth: 220, width: '100%' }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchOutlinedIcon fontSize="small" />
              </InputAdornment>
            ),
            endAdornment: q ? (
              <InputAdornment position="end">
                <IconButton size="small" aria-label={t('clearSearch')} onClick={() => setQ('')}>
                  <ClearOutlinedIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ) : undefined,
          }}
        />
      </LabeledField>
      <LabeledField label={t('statusLabel')} srOnly htmlFor="reminders-filter-status">
        <TextField
          id="reminders-filter-status"
          size="small"
          select
          hiddenLabel
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          sx={{ minWidth: 160 }}
        >
          <MenuItem value="all">{t('allStatuses')}</MenuItem>
          {REMINDER_STATUSES.map((s) => (
            <MenuItem key={s} value={s}>
              {prettifyType(s)}
            </MenuItem>
          ))}
        </TextField>
      </LabeledField>
      <LabeledField label={t('typeLabel')} srOnly htmlFor="reminders-filter-type">
        <TextField
          id="reminders-filter-type"
          size="small"
          select
          hiddenLabel
          value={type}
          onChange={(e) => setType(e.target.value)}
          sx={{ minWidth: 200 }}
        >
          <MenuItem value="all">{t('allTypes')}</MenuItem>
          {REMINDER_TYPES.map((rt) => (
            <MenuItem key={rt} value={rt}>
              {prettifyType(rt)}
            </MenuItem>
          ))}
        </TextField>
      </LabeledField>
      {admin ? (
        <LabeledField label={t('assignedTo')} srOnly htmlFor="reminders-filter-assignee">
          <Autocomplete
            id="reminders-filter-assignee"
            options={usersOptions}
            loading={usersQuery.isLoading}
            value={selectedAssignee}
            onChange={(_, v) => setAssignedToId(v?.id ?? '')}
            getOptionLabel={(o) =>
              assigneeLabel({
                id: o.id,
                given_name: o.given_name,
                family_name: o.family_name,
                display_name: o.display_name,
              })
            }
            isOptionEqualToValue={(a, b) => a.id === b.id}
            size="small"
            sx={{ minWidth: 220 }}
            renderInput={(params) => (
              <TextField
                {...params}
                hiddenLabel
                placeholder={t('assignedTo')}
                inputProps={{
                  ...params.inputProps,
                  'aria-label': t('assignedTo'),
                }}
              />
            )}
          />
        </LabeledField>
      ) : (
        <LabeledField label={t('assignedTo')} srOnly htmlFor="reminders-filter-assignee-me">
          <TextField
            id="reminders-filter-assignee-me"
            size="small"
            hiddenLabel
            value={t('me')}
            disabled
            sx={{ minWidth: 140 }}
          />
        </LabeledField>
      )}
      <LabeledField label={t('dueFrom')} srOnly htmlFor="reminders-filter-due-from">
        <TextField
          id="reminders-filter-due-from"
          size="small"
          hiddenLabel
          type="date"
          value={dueFrom}
          onChange={(e) => setDueFrom(e.target.value)}
          inputProps={{ 'aria-label': t('dueFrom') }}
          sx={{ minWidth: 150 }}
        />
      </LabeledField>
      <LabeledField label={t('dueTo')} srOnly htmlFor="reminders-filter-due-to">
        <TextField
          id="reminders-filter-due-to"
          size="small"
          hiddenLabel
          type="date"
          value={dueTo}
          onChange={(e) => setDueTo(e.target.value)}
          inputProps={{ 'aria-label': t('dueTo') }}
          sx={{ minWidth: 150 }}
        />
      </LabeledField>
      {hasFilter ? (
        <Button onClick={resetFilters} size="small" startIcon={<ClearOutlinedIcon />}>
          {tCommon('reset')}
        </Button>
      ) : null}
      <Tooltip title={t('refresh')}>
        <span>
          <IconButton
            size="small"
            aria-label={t('refreshReminders')}
            onClick={() => listQuery.refetch()}
            disabled={listQuery.isFetching}
          >
            {listQuery.isFetching ? (
              <CircularProgress size={18} />
            ) : (
              <RefreshOutlinedIcon fontSize="small" />
            )}
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  );

  const columns: DataTableColumn<Reminder>[] = [
    {
      key: 'type',
      label: t('columns.type'),
      width: 160,
      render: (r) => <TypeChip type={r.type} />,
    },
    {
      key: 'title',
      label: t('columns.title'),
      render: (r) => (
        <Stack spacing={0.25}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {r.title}
          </Typography>
          {r.description ? (
            <Typography variant="caption" color="text.secondary" noWrap sx={{ maxWidth: 360 }}>
              {r.description}
            </Typography>
          ) : null}
        </Stack>
      ),
    },
    {
      key: 'student',
      label: t('columns.student'),
      hideOnMobile: true,
      render: (r) =>
        r.student ? (
          <Link
            href={`/students/${r.student.id}`}
            onClick={(e) => e.stopPropagation()}
            style={{ color: 'inherit', textDecoration: 'none' }}
          >
            <Typography variant="body2" sx={{ fontWeight: 500 }}>
              {studentLabel(r.student)}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
              {r.student.student_code}
            </Typography>
          </Link>
        ) : (
          <Typography variant="caption" color="text.disabled">
            —
          </Typography>
        ),
    },
    {
      key: 'due_on',
      label: t('columns.dueOn'),
      width: 200,
      render: (r) => <DueBadge dueOn={r.due_on} />,
    },
    {
      key: 'scheduled_for',
      label: t('columns.scheduled'),
      hideOnMobile: true,
      render: (r) => (
        <Tooltip title={r.scheduled_for}>
          <Typography variant="body2" color="text.secondary">
            {formatRelative(r.scheduled_for)}
          </Typography>
        </Tooltip>
      ),
    },
    {
      key: 'assigned_to',
      label: t('columns.assignedTo'),
      hideOnMobile: true,
      render: (r) => (
        <Typography variant="body2" color="text.secondary">
          {assigneeLabel(r.assigned_to ?? null)}
        </Typography>
      ),
    },
    {
      key: 'status',
      label: t('columns.status'),
      width: 140,
      render: (r) => <StatusChip status={r.status} />,
    },
    {
      key: 'actions',
      label: '',
      width: 56,
      align: 'right',
      render: (r) => (
        <IconButton
          size="small"
          aria-label={t('rowActions')}
          onClick={(e) => {
            e.stopPropagation();
            setRowMenu({ anchor: e.currentTarget, row: r as Reminder });
          }}
        >
          <MoreVertOutlinedIcon fontSize="small" />
        </IconButton>
      ),
    },
  ];

  return (
    <>
      <Stack spacing={2}>
        {/* Per-tab filter strip + primary action. Replaces the page header
            action slot of the standalone /reminders page. */}
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1.5}
          justifyContent="space-between"
          alignItems={{ xs: 'stretch', sm: 'flex-end' }}
        >
          <Box sx={{ flexGrow: 1 }}>
            <Paper variant="outlined" sx={{ px: 2, py: 1.5 }}>
              {filters}
            </Paper>
          </Box>
          {canWrite ? (
            <Button
              variant="contained"
              startIcon={<AddOutlinedIcon />}
              onClick={() => setCreateOpen(true)}
              sx={{ alignSelf: { xs: 'stretch', sm: 'flex-end' }, whiteSpace: 'nowrap' }}
            >
              {t('newReminder')}
            </Button>
          ) : null}
        </Stack>

        {listQuery.isLoading ? (
          <LoadingSkeleton variant="list" rows={6} />
        ) : listQuery.isError ? (
          <ErrorState
            title={t('couldNotLoad')}
            description={
              listQuery.error instanceof ApiError
                ? listQuery.error.detail || listQuery.error.title
                : undefined
            }
            onRetry={() => listQuery.refetch()}
            requestId={
              listQuery.error instanceof ApiError ? listQuery.error.requestId : undefined
            }
          />
        ) : rows.length === 0 && !hasFilter && status === 'PENDING' ? (
          <EmptyState
            icon={<NotificationsActiveOutlinedIcon fontSize="medium" />}
            title={t('emptyTitle')}
            description={t('emptyDescription')}
            actions={
              canWrite ? (
                <Button
                  variant="contained"
                  startIcon={<AddOutlinedIcon />}
                  onClick={() => setCreateOpen(true)}
                >
                  {t('newReminder')}
                </Button>
              ) : null
            }
          />
        ) : (
          <Paper variant="outlined">
            <DataTable<Reminder>
              columns={columns}
              rows={rows as Reminder[]}
              rowCount={total}
              getRowId={(r) => r.id}
              onRowClick={(r) => r.metadata?.href ?? undefined}
              page={pageIndex}
              pageSize={pageSize}
              rowsPerPageOptions={PAGE_SIZE_OPTIONS}
              onPageChange={setPageIndex}
              onPageSizeChange={(s) => setPageSize(s)}
              ariaLabel="Reminders"
              emptyTitle={t('noMatchTitle')}
              emptyDescription={t('noMatchDescription')}
            />
          </Paper>
        )}
      </Stack>

      {/* --- Row action menu --- */}
      {(() => {
        const currentUserId = user?.id ?? null;
        const row = rowMenu?.row;
        const isOwn = row
          ? row.assigned_to_id === currentUserId || row.assigned_to_id == null
          : false;
        const canMutate = canWrite && (admin || isOwn);
        const ackEligible =
          row && (row.status === 'PENDING' || row.status === 'SENT');
        return (
          <Menu
            anchorEl={rowMenu?.anchor ?? null}
            open={Boolean(rowMenu)}
            onClose={closeMenu}
            anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
            transformOrigin={{ vertical: 'top', horizontal: 'right' }}
          >
            {ackEligible && canMutate ? (
              <MenuItem
                onClick={() => {
                  if (rowMenu) ackMutation.mutate(rowMenu.row.id);
                  closeMenu();
                }}
              >
                <ListItemIcon>
                  <DoneAllOutlinedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('actions.acknowledge')}</ListItemText>
              </MenuItem>
            ) : null}
            {canMutate ? (
              <MenuItem
                onClick={() => {
                  if (rowMenu) setSnoozeTarget(rowMenu.row);
                  closeMenu();
                }}
                disabled={row?.status === 'DISMISSED'}
              >
                <ListItemIcon>
                  <SnoozeOutlinedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('actions.snooze')}</ListItemText>
              </MenuItem>
            ) : null}
            {canMutate ? (
              <MenuItem
                onClick={() => {
                  if (rowMenu) dismissMutation.mutate(rowMenu.row.id);
                  closeMenu();
                }}
                disabled={row?.status === 'DISMISSED'}
              >
                <ListItemIcon>
                  <CancelOutlinedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('actions.dismiss')}</ListItemText>
              </MenuItem>
            ) : null}
            {canWrite ? (
              <MenuItem
                onClick={() => {
                  if (rowMenu) setEditTarget(rowMenu.row);
                  closeMenu();
                }}
              >
                <ListItemIcon>
                  <EditOutlinedIcon fontSize="small" />
                </ListItemIcon>
                <ListItemText>{t('actions.edit')}</ListItemText>
              </MenuItem>
            ) : null}
            {admin ? (
              <MenuItem
                onClick={() => {
                  if (rowMenu) setDeleteTarget(rowMenu.row);
                  closeMenu();
                }}
                sx={{ color: 'error.main' }}
              >
                <ListItemIcon>
                  <DeleteOutlineOutlinedIcon fontSize="small" color="error" />
                </ListItemIcon>
                <ListItemText>{t('actions.delete')}</ListItemText>
              </MenuItem>
            ) : null}
          </Menu>
        );
      })()}

      {/* --- Dialogs --- */}
      {createOpen ? (
        <CreateReminderDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      ) : null}
      {editTarget ? (
        <EditReminderDialog
          open={Boolean(editTarget)}
          onClose={() => setEditTarget(null)}
          reminder={editTarget}
        />
      ) : null}
      {snoozeTarget ? (
        <SnoozeDialog
          open={Boolean(snoozeTarget)}
          onClose={() => setSnoozeTarget(null)}
          reminder={snoozeTarget}
        />
      ) : null}
      {deleteTarget ? (
        <ConfirmDialog
          open={Boolean(deleteTarget)}
          onClose={() => (deleteMutation.isPending ? undefined : setDeleteTarget(null))}
          title={t('deleteTitle')}
          description={
            <Typography variant="body2">
              {t('deleteDescription')}
            </Typography>
          }
          confirmLabel={deleteTarget.title}
          confirmText={t('deleteConfirm')}
          loading={deleteMutation.isPending}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
        />
      ) : null}
    </>
  );
}
