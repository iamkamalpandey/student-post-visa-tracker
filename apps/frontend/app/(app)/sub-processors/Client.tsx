'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Button,
  Chip,
  IconButton,
  Link as MuiLink,
  Stack,
  Tooltip,
  Typography,
} from '@mui/material';
import GroupsOutlinedIcon from '@mui/icons-material/GroupsOutlined';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import { useAuth } from '@/lib/auth';
import { isAdmin } from '@/lib/auth-helpers';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { safeHref } from '@/lib/safeHref';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import ListPageShell from '@/components/ListPageShell';
import ConfirmDialog from '@/components/ConfirmDialog';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import SubProcessorDialog, {
  type SubProcessorRow,
} from '@/features/privacy/SubProcessorDialog';

function ForbiddenState() {
  return (
    <Stack spacing={3}>
      <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
        Sub-processors
      </Typography>
      <EmptyState
        icon={<GroupsOutlinedIcon fontSize="medium" />}
        title="You don’t have access to this page"
        description="The sub-processor register is restricted to workspace administrators."
      />
    </Stack>
  );
}

export default function SubProcessorsPage() {
  const { user } = useAuth();
  const { enqueueSnackbar } = useSnackbar();
  const queryClient = useQueryClient();
  const admin = isAdmin(user?.role ?? null);

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SubProcessorRow | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SubProcessorRow | null>(null);

  const listQuery = useQuery<SubProcessorRow[]>({
    queryKey: ['sub-processors'],
    queryFn: async ({ signal }) => {
      // Backend may return either the bare array (legacy) or `{ data: [...] }`
      // (current envelope). Tolerate both so older deployments still work.
      const res = await api.get<SubProcessorRow[] | { data: SubProcessorRow[] }>(
        '/sub-processors',
        { params: { limit: 100 }, signal },
      );
      if (Array.isArray(res.data)) return res.data;
      return Array.isArray(res.data?.data) ? res.data.data : [];
    },
    enabled: admin,
  });

  const removeMut = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/sub-processors/${id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Sub-processor removed.', { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['sub-processors'] });
      setDeleteTarget(null);
    },
    onError: (err: unknown) => {
      const msg =
        err instanceof ApiError
          ? err.detail || err.title || 'Failed to remove sub-processor.'
          : 'Failed to remove sub-processor.';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const rows = useMemo(() => listQuery.data ?? [], [listQuery.data]);

  const columns: DataTableColumn<SubProcessorRow>[] = useMemo(
    () => [
      {
        key: 'name',
        label: 'Name',
        render: (r) => (
          <Typography component="span" variant="body2" sx={{ fontWeight: 600 }}>
            {r.name}
          </Typography>
        ),
      },
      {
        key: 'purpose',
        label: 'Purpose',
        render: (r) => (
          <Tooltip title={r.purpose} placement="top-start">
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
              {r.purpose}
            </Typography>
          </Tooltip>
        ),
      },
      {
        key: 'region',
        label: 'Region',
        render: (r) => <Chip size="small" label={r.region} variant="outlined" />,
      },
      {
        key: 'contract_url',
        label: 'Contract',
        render: (r) =>
          r.contract_url ? (
            // SVT-SEC-P1-FE1-2026-05 — scheme-allowlist before href to
            // neutralise javascript:/data:/vbscript: XSS from legacy rows.
            <MuiLink
              href={safeHref(r.contract_url)}
              target="_blank"
              rel="noopener noreferrer"
              underline="hover"
              sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}
            >
              View <OpenInNewOutlinedIcon fontSize="inherit" />
            </MuiLink>
          ) : (
            <Typography component="span" variant="body2" color="text.secondary">
              —
            </Typography>
          ),
      },
      {
        key: 'added_at',
        label: 'Added',
        render: (r) => (
          <Typography component="span" variant="body2" color="text.secondary">
            {formatDate(r.added_at)}
          </Typography>
        ),
      },
      {
        key: 'removed_at',
        label: 'Removed',
        render: (r) =>
          r.removed_at ? (
            <Chip size="small" label={formatDate(r.removed_at)} color="default" variant="outlined" />
          ) : (
            <Chip size="small" label="Active" color="success" />
          ),
        hideOnMobile: true,
      },
      {
        key: 'actions',
        label: '',
        align: 'right',
        width: 96,
        render: (r) => (
          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
            <Tooltip title="Edit">
              <IconButton size="small" onClick={() => setEditTarget(r)} aria-label={`Edit ${r.name}`}>
                <EditOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Remove">
              <IconButton
                size="small"
                color="error"
                onClick={() => setDeleteTarget(r)}
                aria-label={`Remove ${r.name}`}
              >
                <DeleteOutlineOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
        ),
      },
    ],
    [],
  );

  if (!admin) return <ForbiddenState />;

  return (
    <ListPageShell
      title="Sub-processors"
      description="Article 30 register of third parties processing personal data on our behalf."
      action={
        <Button
          variant="contained"
          startIcon={<AddOutlinedIcon />}
          onClick={() => setCreateOpen(true)}
        >
          Add sub-processor
        </Button>
      }
      bareContent
    >
      {listQuery.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : listQuery.isError ? (
        <ErrorState
          title="Couldn’t load sub-processors"
          description={
            listQuery.error instanceof ApiError
              ? listQuery.error.detail || listQuery.error.title
              : 'Please try again.'
          }
          onRetry={() => listQuery.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<GroupsOutlinedIcon fontSize="medium" />}
          title="No sub-processors yet"
          description="Add the third parties (storage, email, analytics) you rely on so they appear in your public list."
          actions={
            <Button
              variant="contained"
              startIcon={<AddOutlinedIcon />}
              onClick={() => setCreateOpen(true)}
            >
              Add sub-processor
            </Button>
          }
        />
      ) : (
        <DataTable<SubProcessorRow> columns={columns} rows={rows} getRowId={(r) => r.id} />
      )}

      <SubProcessorDialog
        open={createOpen}
        subProcessor={null}
        onClose={() => setCreateOpen(false)}
      />
      <SubProcessorDialog
        open={Boolean(editTarget)}
        subProcessor={editTarget}
        onClose={() => setEditTarget(null)}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="Remove sub-processor?"
        description={
          deleteTarget ? (
            <Typography component="span">
              <Typography component="span" sx={{ fontWeight: 700 }}>
                {deleteTarget.name}
              </Typography>{' '}
              will be removed from the register. This is destructive — for an audit trail of
              decommissioned vendors prefer editing and setting a removed-at date.
            </Typography>
          ) : null
        }
        confirmLabel={deleteTarget?.name ?? null}
        confirmText="Remove"
        loading={removeMut.isPending}
        onConfirm={() => {
          if (deleteTarget) removeMut.mutate(deleteTarget.id);
        }}
        onClose={() => setDeleteTarget(null)}
      />
    </ListPageShell>
  );
}
