'use client';

// Admin lookup CRUD for SuperAgentType. Mirrors visa-types layout.

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Button,
  Card,
  CardContent,
  Chip,
  IconButton,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import DeleteOutlinedIcon from '@mui/icons-material/DeleteOutlined';

import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import ConfirmDialog from '@/components/ConfirmDialog';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import LabeledField from '@/components/LabeledField';

type Row = {
  id: string;
  key: string;
  label: string;
  description: string | null;
  is_active: boolean;
};

export default function SuperAgentTypesClient() {
  const router = useRouter();
  const { user } = useAuth();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  useEffect(() => {
    if (user && user.role !== 'ADMIN') router.replace('/');
  }, [user, router]);

  const [keyVal, setKey] = useState('');
  const [labelVal, setLabel] = useState('');
  const [descVal, setDesc] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ id: string; key: string } | null>(null);

  const listQ = useQuery({
    queryKey: ['super-agent-types'],
    queryFn: async () => {
      const res = await api.get<{ data: Row[] }>('/super-agent-types');
      return res.data;
    },
    enabled: user?.role === 'ADMIN',
  });

  const createM = useMutation({
    mutationFn: async () =>
      (await api.post<Row>('/super-agent-types', {
        key: keyVal.trim(),
        label: labelVal.trim(),
        description: descVal.trim() || undefined,
        is_active: true,
      })).data,
    onSuccess: () => {
      setKey('');
      setLabel('');
      setDesc('');
      void qc.invalidateQueries({ queryKey: ['super-agent-types'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? (err.detail || err.title) : err instanceof Error ? err.message : 'Operation failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  const deleteM = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/super-agent-types/${id}`);
    },
    onSuccess: () => {
      setPendingDelete(null);
      void qc.invalidateQueries({ queryKey: ['super-agent-types'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? (err.detail || err.title) : err instanceof Error ? err.message : 'Operation failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });
  const deleteErr = deleteM.error instanceof ApiError ? deleteM.error : null;

  if (!user || user.role !== 'ADMIN') return null;

  const rows = listQ.data?.data ?? [];
  const listErr = listQ.error instanceof ApiError ? listQ.error : null;
  const createErr = createM.error instanceof ApiError ? createM.error : null;

  return (
    <Stack spacing={3}>
      <Stack spacing={0.5}>
        <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: -0.3 }}>
          Super-agent types
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Categories used to classify super-agents (Aggregator, Referral partner, White-label, Consortium, Government).
        </Typography>
      </Stack>

      <Card variant="outlined">
        <CardContent>
          <Typography variant="subtitle1" sx={{ fontWeight: 600, mb: 1.5 }}>
            New type
          </Typography>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'flex-end' }}>
            <LabeledField label="Key" required helperText="SCREAMING_SNAKE_CASE">
              <TextField
                size="small"
                value={keyVal}
                onChange={(e) => setKey(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''))}
                placeholder="REFERRAL_PARTNER"
                inputProps={{ style: { height: 28 } }}
              />
            </LabeledField>
            <LabeledField label="Label" required>
              <TextField size="small" value={labelVal} onChange={(e) => setLabel(e.target.value)} />
            </LabeledField>
            <LabeledField label="Description">
              <TextField size="small" value={descVal} onChange={(e) => setDesc(e.target.value)} />
            </LabeledField>
            <Button
              variant="contained"
              startIcon={<AddOutlinedIcon />}
              disabled={!keyVal.trim() || !labelVal.trim() || createM.isPending}
              onClick={() => createM.mutate()}
            >
              Add
            </Button>
          </Stack>
          {createErr && (
            <Typography color="error" variant="body2" sx={{ mt: 1 }}>
              {createErr.detail ?? createErr.title}
            </Typography>
          )}
        </CardContent>
      </Card>

      {listQ.isLoading ? (
        <LoadingSkeleton rows={4} />
      ) : listQ.isError ? (
        <ErrorState
          title="Couldn’t load types"
          description={listErr?.detail ?? listErr?.title ?? 'Failed to load.'}
          requestId={listErr?.requestId}
          onRetry={() => void listQ.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState title="No types yet" description="Add a category to start classifying super-agents." />
      ) : (
        <Card variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Key</TableCell>
                <TableCell>Label</TableCell>
                <TableCell>Description</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right" />
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.id}>
                  <TableCell><code>{r.key}</code></TableCell>
                  <TableCell>{r.label}</TableCell>
                  <TableCell>{r.description ?? '—'}</TableCell>
                  <TableCell>
                    <Chip
                      size="small"
                      label={r.is_active ? 'Active' : 'Inactive'}
                      color={r.is_active ? 'success' : 'default'}
                      variant="outlined"
                    />
                  </TableCell>
                  <TableCell align="right">
                    <IconButton
                      size="small"
                      aria-label={`Delete ${r.key}`}
                      onClick={() => setPendingDelete({ id: r.id, key: r.key })}
                      disabled={deleteM.isPending}
                    >
                      <DeleteOutlinedIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete super-agent type?"
        description={
          pendingDelete
            ? `Delete type "${pendingDelete.key}"? This cannot be undone.`
            : undefined
        }
        confirmLabel={null}
        confirmText="Delete"
        onConfirm={async () => {
          if (!pendingDelete) return;
          await deleteM.mutateAsync(pendingDelete.id);
        }}
        onClose={() => setPendingDelete(null)}
        loading={deleteM.isPending}
        errorText={deleteErr?.detail ?? deleteErr?.title ?? null}
      />
    </Stack>
  );
}
