'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Button,
  Chip,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import PolicyOutlinedIcon from '@mui/icons-material/PolicyOutlined';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import CloudDownloadOutlinedIcon from '@mui/icons-material/CloudDownloadOutlined';
import { useAuth } from '@/lib/auth';
import { isAdmin } from '@/lib/auth-helpers';
import { api, ApiError } from '@/lib/api';
import { formatDateTime, formatRelative } from '@/lib/format';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import ListPageShell from '@/components/ListPageShell';
import StatusChip from '@/components/StatusChip';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import CreateDSARDialog from '@/features/privacy/CreateDSARDialog';
import UpdateDSARStatusDialog from '@/features/privacy/UpdateDSARStatusDialog';
import EditDSARDialog from '@/features/privacy/EditDSARDialog';

type DSARRow = {
  id: string;
  subject_type: string;
  subject_id: string;
  type: 'ACCESS' | 'PORTABILITY' | 'ERASURE' | 'RECTIFICATION' | 'RESTRICTION' | 'OBJECTION';
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'REJECTED' | 'EXPIRED';
  requested_at: string;
  due_by: string;
  completed_at: string | null;
  notes: string | null;
  // SVT-WAVE-PRIV-C1-2026-05 — set by the backend when an ACCESS/PORTABILITY
  // export bundle has been written to storage. The FE uses this as the
  // gate on the "Download export" action.
  export_storage_key?: string | null;
  // Server-derived (see backend dsar/service.ts decorate()). Optional so older
  // deployments that haven't shipped the FSM patch still render.
  is_overdue?: boolean;
  days_remaining?: number;
};

type RowMenuState = { anchor: HTMLElement; row: DSARRow } | null;

function isOverdue(due_by: string, completed_at: string | null): boolean {
  if (completed_at) return false;
  const ts = new Date(due_by).getTime();
  return Number.isFinite(ts) && ts < Date.now();
}

// Fallback used when the backend hasn't surfaced days_remaining yet.
function daysRemainingFallback(due_by: string): number {
  const ts = new Date(due_by).getTime();
  if (!Number.isFinite(ts)) return 0;
  return Math.ceil((ts - Date.now()) / (24 * 60 * 60 * 1000));
}

function ForbiddenState() {
  return (
    <Stack spacing={3}>
      <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
        DSAR requests
      </Typography>
      <EmptyState
        icon={<PolicyOutlinedIcon fontSize="medium" />}
        title="You don’t have access to this page"
        description="DSAR management is restricted to workspace administrators."
      />
    </Stack>
  );
}

export default function DSARPage() {
  const { user } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const queryClient = useQueryClient();
  const admin = isAdmin(user?.role ?? null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<DSARRow | null>(null);
  const [editFullTarget, setEditFullTarget] = useState<DSARRow | null>(null);
  const [rowMenu, setRowMenu] = useState<RowMenuState>(null);
  // SVT-WAVE-HIGH-5-2026-05 — type + status client-side filter chips.
  const [typeFilter, setTypeFilter] = useState<DSARRow['type'] | 'ALL'>('ALL');
  const [statusFilter, setStatusFilter] = useState<DSARRow['status'] | 'ALL'>('ALL');

  const listQuery = useQuery<DSARRow[]>({
    queryKey: ['dsar'],
    queryFn: async ({ signal }) => {
      // Backend may return either the bare array (legacy) or `{ data: [...] }`
      // (current envelope). Tolerate both so older deployments still work.
      const res = await api.get<DSARRow[] | { data: DSARRow[] }>('/dsar', {
        params: { limit: 100 },
        signal,
      });
      if (Array.isArray(res.data)) return res.data;
      return Array.isArray(res.data?.data) ? res.data.data : [];
    },
    enabled: admin,
  });

  // SVT-WAVE-PRIV-C1-2026-05 — request a freshly-signed download URL for the
  // ACCESS/PORTABILITY export bundle and open it in a new tab. The backend
  // mints a single-use 24h nonce; we never persist the URL because it dies
  // after one redemption.
  const downloadExport = async (row: DSARRow) => {
    try {
      const res = await api.get<{ data: { url: string; expiresAt: string } }>(
        `/dsar/${row.id}/export`,
      );
      const url = res.data?.data?.url;
      if (!url) throw new Error('No download URL returned');
      // Hand the URL straight to the browser. The endpoint streams the bundle
      // with Content-Disposition: attachment so the browser downloads rather
      // than navigates away.
      window.open(url, '_blank', 'noopener');
    } catch (err: unknown) {
      const msg =
        err instanceof ApiError
          ? err.detail || err.title || 'Failed to fetch export bundle.'
          : err instanceof Error
            ? err.message
            : 'Failed to fetch export bundle.';
      enqueueSnackbar(msg, { variant: 'error' });
    }
  };

  const patchMut = useMutation({
    mutationFn: async (vars: { id: string; status: DSARRow['status'] }) => {
      const res = await api.patch(`/dsar/${vars.id}`, { status: vars.status });
      return res.data;
    },
    onSuccess: (_data, vars) => {
      enqueueSnackbar(`DSAR marked ${vars.status.toLowerCase().replace('_', ' ')}.`, {
        variant: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: ['dsar'] });
      // SVT-WAVE42-DASH-INVALIDATE-2026-05 — DSAR widget reads
      // /dsar/dashboard-summary; status transitions move rows in/out of
      // open/overdue/due-soon buckets.
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof ApiError
          ? err.detail || err.title || 'Failed to update DSAR.'
          : 'Failed to update DSAR.';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const allRows = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const rows = useMemo(() => {
    return allRows.filter((r) => {
      if (typeFilter !== 'ALL' && r.type !== typeFilter) return false;
      if (statusFilter !== 'ALL' && r.status !== statusFilter) return false;
      return true;
    });
  }, [allRows, typeFilter, statusFilter]);

  const columns: DataTableColumn<DSARRow>[] = useMemo(
    () => [
      {
        key: 'subject_type',
        label: 'Subject type',
        render: (r) => <Chip size="small" label={r.subject_type} variant="outlined" />,
      },
      {
        key: 'subject_id',
        label: 'Subject',
        render: (r) =>
          r.subject_type === 'student' ? (
            <Link
              href={`/students/${r.subject_id}`}
              style={{
                color: 'inherit',
                textDecoration: 'underline dotted',
                fontFamily: 'monospace',
                fontSize: 12,
              }}
            >
              {r.subject_id.slice(0, 8)}…
            </Link>
          ) : (
            <Typography component="span" sx={{ fontFamily: 'monospace', fontSize: 12 }}>
              {r.subject_id.slice(0, 8)}…
            </Typography>
          ),
      },
      {
        key: 'type',
        label: 'Type',
        render: (r) => <Chip size="small" label={r.type} color="info" />,
      },
      {
        key: 'status',
        label: 'Status',
        render: (r) => <StatusChip status={r.status} />,
      },
      {
        key: 'days_remaining',
        label: 'Due',
        render: (r) => {
          // Hide the countdown for terminal states — they no longer have a clock.
          if (r.status === 'COMPLETED' || r.status === 'REJECTED' || r.status === 'EXPIRED') {
            return (
              <Typography component="span" variant="body2" color="text.secondary">
                —
              </Typography>
            );
          }
          const days =
            typeof r.days_remaining === 'number'
              ? r.days_remaining
              : daysRemainingFallback(r.due_by);
          let color: 'error' | 'warning' | 'default' = 'default';
          let label: string;
          if (days < 0) {
            color = 'error';
            label = `Overdue (${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'})`;
          } else if (days <= 7) {
            color = 'warning';
            label = `Due in ${days} day${days === 1 ? '' : 's'}`;
          } else {
            label = `Due in ${days} days`;
          }
          return (
            <Tooltip title={formatDateTime(r.due_by)}>
              <Chip size="small" color={color} variant={color === 'default' ? 'outlined' : 'filled'} label={label} />
            </Tooltip>
          );
        },
      },
      {
        key: 'requested_at',
        label: 'Requested',
        render: (r) => (
          <Tooltip title={formatDateTime(r.requested_at)}>
            <Typography component="span" variant="body2" color="text.secondary">
              {formatRelative(r.requested_at)}
            </Typography>
          </Tooltip>
        ),
      },
      {
        key: 'due_by',
        label: 'Due by',
        render: (r) => {
          const overdue = isOverdue(r.due_by, r.completed_at);
          return (
            <Typography
              component="span"
              variant="body2"
              sx={{
                color: overdue ? 'error.main' : 'text.primary',
                fontWeight: overdue ? 700 : 500,
              }}
            >
              {formatDateTime(r.due_by)}
              {overdue ? ' · OVERDUE' : ''}
            </Typography>
          );
        },
      },
      {
        key: 'completed_at',
        label: 'Completed',
        render: (r) => (
          <Typography component="span" variant="body2" color="text.secondary">
            {r.completed_at ? formatDateTime(r.completed_at) : '—'}
          </Typography>
        ),
        hideOnMobile: true,
      },
      {
        key: 'actions',
        label: '',
        align: 'right',
        width: 56,
        render: (r) => (
          <IconButton
            size="small"
            aria-label={`Actions for DSAR ${r.id.slice(0, 8)}`}
            onClick={(e) => setRowMenu({ anchor: e.currentTarget, row: r })}
          >
            <MoreVertOutlinedIcon fontSize="small" />
          </IconButton>
        ),
      },
    ],
    [],
  );

  if (!admin) return <ForbiddenState />;

  // SVT-WAVE23-DSAR-SLA-2026-05 — overdue / due-soon banner mirroring breach.
  // Counts over the un-filtered set so the alert is honest even when the
  // user has narrowed the table to e.g. COMPLETED only.
  const overdueDsarCount = allRows.filter((r) => r.is_overdue === true).length;
  const dueSoonDsarCount = allRows.filter((r) =>
    r.status !== 'COMPLETED' && r.status !== 'REJECTED' && r.status !== 'EXPIRED' &&
    typeof r.days_remaining === 'number' && r.days_remaining >= 0 && r.days_remaining <= 3
  ).length;

  return (
    <ListPageShell
      title="DSAR requests"
      description="Data Subject Access Requests under GDPR. The 30-day clock starts when the request is logged."
      action={
        <Button
          variant="contained"
          startIcon={<AddOutlinedIcon />}
          onClick={() => setCreateOpen(true)}
        >
          New DSAR
        </Button>
      }
      bareContent
    >
      {(overdueDsarCount > 0 || dueSoonDsarCount > 0) && (
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          spacing={1}
          sx={{ mb: 2 }}
        >
          {overdueDsarCount > 0 && (
            <Chip
              color="error"
              label={`${overdueDsarCount} overdue — past 30d clock, regulator response required`}
              sx={{ fontWeight: 600 }}
            />
          )}
          {dueSoonDsarCount > 0 && (
            <Chip
              color="warning"
              label={`${dueSoonDsarCount} due within 3 days`}
            />
          )}
        </Stack>
      )}

      {/* SVT-WAVE-HIGH-5-2026-05 — type + status filter chips. */}
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
            Type:
          </Typography>
          {(['ALL', 'ACCESS', 'PORTABILITY', 'ERASURE', 'RECTIFICATION', 'RESTRICTION', 'OBJECTION'] as const).map((s) => (
            <Chip
              key={s}
              label={s === 'ALL' ? 'All' : s}
              size="small"
              variant={typeFilter === s ? 'filled' : 'outlined'}
              color={typeFilter === s ? 'primary' : 'default'}
              onClick={() => setTypeFilter(s)}
              aria-pressed={typeFilter === s}
            />
          ))}
          <Typography variant="caption" color="text.secondary" sx={{ mx: 0.5, fontWeight: 600 }}>
            Status:
          </Typography>
          {(['ALL', 'PENDING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED', 'EXPIRED'] as const).map((s) => (
            <Chip
              key={s}
              label={s === 'ALL' ? 'All' : s.replace('_', ' ')}
              size="small"
              variant={statusFilter === s ? 'filled' : 'outlined'}
              color={statusFilter === s ? 'primary' : 'default'}
              onClick={() => setStatusFilter(s)}
              aria-pressed={statusFilter === s}
            />
          ))}
          {(typeFilter !== 'ALL' || statusFilter !== 'ALL') && (
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
          title="Couldn’t load DSAR requests"
          description={
            listQuery.error instanceof ApiError
              ? listQuery.error.detail || listQuery.error.title
              : 'Please try again.'
          }
          onRetry={() => listQuery.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<PolicyOutlinedIcon fontSize="medium" />}
          title="No DSAR requests yet"
          description="Subjects can submit access, portability, erasure or other requests. Track and resolve them here."
          actions={
            <Button
              variant="contained"
              startIcon={<AddOutlinedIcon />}
              onClick={() => setCreateOpen(true)}
            >
              New DSAR
            </Button>
          }
        />
      ) : (
        <DataTable<DSARRow>
          columns={columns}
          rows={rows}
          getRowId={(r) => r.id}
          ariaLabel="DSAR requests"
        />
      )}

      <Menu
        anchorEl={rowMenu?.anchor ?? null}
        open={Boolean(rowMenu)}
        onClose={() => setRowMenu(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem
          // Quick-action: only valid forward transition into IN_PROGRESS without a
          // reason is PENDING -> IN_PROGRESS. Reverting from COMPLETED/REJECTED needs
          // a reason — that path goes through "Edit status & notes" instead.
          disabled={rowMenu?.row.status !== 'PENDING' || patchMut.isPending}
          onClick={() => {
            if (rowMenu) patchMut.mutate({ id: rowMenu.row.id, status: 'IN_PROGRESS' });
            setRowMenu(null);
          }}
        >
          <ListItemIcon>
            <PlayArrowOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Mark in progress
        </MenuItem>
        <MenuItem
          disabled={rowMenu?.row.status !== 'IN_PROGRESS' || patchMut.isPending}
          onClick={() => {
            if (rowMenu) patchMut.mutate({ id: rowMenu.row.id, status: 'COMPLETED' });
            setRowMenu(null);
          }}
        >
          <ListItemIcon>
            <CheckCircleOutlineIcon fontSize="small" color="success" />
          </ListItemIcon>
          Mark completed
        </MenuItem>
        <MenuItem
          // Reject requires a reason — direct it to the dialog.
          disabled={rowMenu?.row.status !== 'IN_PROGRESS' || patchMut.isPending}
          onClick={() => {
            if (rowMenu) setEditTarget(rowMenu.row);
            setRowMenu(null);
          }}
          sx={{ color: 'error.main' }}
        >
          <ListItemIcon>
            <BlockOutlinedIcon fontSize="small" color="error" />
          </ListItemIcon>
          Reject
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (rowMenu) setEditTarget(rowMenu.row);
            setRowMenu(null);
          }}
        >
          <ListItemIcon>
            <EditOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Edit status & notes
        </MenuItem>
        <MenuItem
          onClick={() => {
            if (rowMenu) setEditFullTarget(rowMenu.row);
            setRowMenu(null);
          }}
        >
          <ListItemIcon>
            <EditOutlinedIcon fontSize="small" />
          </ListItemIcon>
          Edit DSAR
        </MenuItem>
        {/* SVT-WAVE-PRIV-C1-2026-05 — Download export bundle. Only enabled for
            COMPLETED ACCESS/PORTABILITY requests that have a stamped
            export_storage_key (bundle generation can lag the status flip in
            edge cases; we never offer a download until the bundle exists). */}
        {rowMenu &&
          (rowMenu.row.type === 'ACCESS' || rowMenu.row.type === 'PORTABILITY') &&
          rowMenu.row.status === 'COMPLETED' &&
          rowMenu.row.export_storage_key ? (
          <MenuItem
            onClick={() => {
              if (rowMenu) void downloadExport(rowMenu.row);
              setRowMenu(null);
            }}
          >
            <ListItemIcon>
              <CloudDownloadOutlinedIcon fontSize="small" color="primary" />
            </ListItemIcon>
            Download export
          </MenuItem>
        ) : null}
      </Menu>

      <CreateDSARDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      <UpdateDSARStatusDialog
        open={Boolean(editTarget)}
        request={editTarget}
        onClose={() => setEditTarget(null)}
      />
      <EditDSARDialog
        open={Boolean(editFullTarget)}
        request={editFullTarget}
        onClose={() => setEditFullTarget(null)}
      />
    </ListPageShell>
  );
}
