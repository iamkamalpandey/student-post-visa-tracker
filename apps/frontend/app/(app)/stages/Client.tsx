'use client';

// Refactored to SVT form-pattern per design pass.
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  IconButton,
  MenuItem,
  Skeleton,
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
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ArrowUpwardIcon from '@mui/icons-material/ArrowUpward';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import ArrowDownwardOutlinedIcon from '@mui/icons-material/ArrowDownwardOutlined';
import { useAuth } from '@/lib/auth';
import { ApiError, api } from '@/lib/api';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import ConfirmDialog from '@/components/ConfirmDialog';
import LabeledField from '@/components/LabeledField';
import StageEditDialog from '@/features/stages/StageEditDialog';
import TransitionMatrix from '@/features/stages/TransitionMatrix';
import type { Stage, VisaTypeOption } from '@/features/stages/types';

type ApiList<T> = { data: T[] };

const CATEGORY_LABEL: Record<string, string> = {
  PRE_DEPARTURE: 'Pre-departure',
  IN_TRANSIT: 'In transit',
  POST_ARRIVAL: 'Post-arrival',
  ENROLLED: 'Enrolled',
  COMPLETED: 'Completed',
  EXCEPTION: 'Exception',
  IN_PROGRESS: 'In progress',
};

export default function StagesPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const t = useTranslations('stages');

  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<Stage | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Stage | null>(null);
  // v6: '' = all, 'null' = generic only, otherwise visa-type uuid.
  const [visaTypeFilter, setVisaTypeFilter] = useState<string>('');

  const stagesQuery = useQuery({
    queryKey: ['stages', visaTypeFilter || 'all'],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (visaTypeFilter) params.visa_type_id = visaTypeFilter;
      const res = await api.get<ApiList<Stage>>('/stages', { params });
      return res.data.data;
    },
  });

  // v6: load the visa-types catalogue for the filter dropdown. Admin-only — the
  // /visa-types endpoint requires admin for mutations but list reads are allowed
  // for any authenticated user.
  const visaTypesQuery = useQuery({
    queryKey: ['visa-types', null],
    queryFn: async () => {
      const res = await api.get<ApiList<VisaTypeOption>>('/visa-types');
      return res.data.data;
    },
    enabled: isAdmin,
  });

  const ordered = useMemo(
    () => [...(stagesQuery.data ?? [])].sort((a, b) => a.sequence - b.sequence),
    [stagesQuery.data],
  );

  // Reorder swaps two adjacent stages' sequence values in a single batch.
  const reorderMutation = useMutation({
    mutationFn: async (items: { id: string; sequence: number }[]) => {
      await api.post('/stages/reorder', { items });
    },
    onMutate: async (items) => {
      await qc.cancelQueries({ queryKey: ['stages'] });
      const prev = qc.getQueryData<Stage[]>(['stages']);
      if (prev) {
        const seqMap = new Map(items.map((i) => [i.id, i.sequence]));
        const next = prev.map((s) => (seqMap.has(s.id) ? { ...s, sequence: seqMap.get(s.id)! } : s));
        qc.setQueryData(['stages'], next);
      }
      return { prev };
    },
    onError: (err, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(['stages'], ctx.prev);
      const msg = err instanceof ApiError ? err.detail || err.title : 'Reorder failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['stages'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/stages/${id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Stage deleted', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['stages'] });
      void qc.invalidateQueries({ queryKey: ['stages', 'transitions'] });
      closeDeleteDialog();
    },
    onError: (err) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Delete failed';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });

  function openCreate() {
    setEditing(null);
    setEditorOpen(true);
  }
  function openEdit(stage: Stage) {
    if (!isAdmin) return;
    setEditing(stage);
    setEditorOpen(true);
  }
  function closeEditor() {
    setEditorOpen(false);
    setEditing(null);
  }
  function closeDeleteDialog() {
    setDeleteTarget(null);
  }

  function move(stage: Stage, direction: -1 | 1) {
    const idx = ordered.findIndex((s) => s.id === stage.id);
    if (idx === -1) return;
    const swapIdx = idx + direction;
    if (swapIdx < 0 || swapIdx >= ordered.length) return;
    const other = ordered[swapIdx];
    if (!other) return;
    reorderMutation.mutate([
      { id: stage.id, sequence: other.sequence },
      { id: other.id, sequence: stage.sequence },
    ]);
  }

  const nextSequence =
    ordered.length === 0 ? 0 : Math.max(...ordered.map((s) => s.sequence)) + 10;

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        spacing={2}
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        justifyContent="space-between"
      >
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
            Lifecycle stages
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Configure the stages students pass through after their visa is approved. Reorder,
            rename, and define which transitions are allowed.
          </Typography>
        </Box>
        {isAdmin ? (
          <Button variant="contained" startIcon={<AddIcon />} onClick={openCreate}>
            New stage
          </Button>
        ) : null}
      </Stack>

      {!isAdmin ? (
        <Alert severity="info">
          You have read-only access. Only administrators can edit lifecycle stages or transitions.
        </Alert>
      ) : null}

      {isAdmin ? (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems="center">
          {/* Filter toolbar — small input + SR-only label. */}
          <LabeledField label="Visa type" srOnly htmlFor="stages-filter-visa-type">
            <TextField
              id="stages-filter-visa-type"
              select
              size="small"
              hiddenLabel
              placeholder="All visa types"
              value={visaTypeFilter}
              onChange={(e) => setVisaTypeFilter(e.target.value)}
              sx={{ minWidth: 240 }}
            >
              <MenuItem value="">All visa types</MenuItem>
              <MenuItem value="null">Generic (no visa-type pin)</MenuItem>
              {(visaTypesQuery.data ?? []).map((vt) => (
                <MenuItem key={vt.id} value={vt.id}>
                  {vt.country_code} · {vt.name}
                </MenuItem>
              ))}
            </TextField>
          </LabeledField>
          <Typography variant="caption" color="text.secondary">
            Filter the stage list by which visa workflow they apply to.
          </Typography>
        </Stack>
      ) : null}

      <Card variant="outlined">
        <CardContent sx={{ p: 0 }}>
          {stagesQuery.isLoading ? (
            <Box sx={{ p: 3 }}>
              <Skeleton variant="rectangular" height={64} sx={{ mb: 1 }} />
              <Skeleton variant="rectangular" height={64} sx={{ mb: 1 }} />
              <Skeleton variant="rectangular" height={64} />
            </Box>
          ) : stagesQuery.isError ? (
            <Box sx={{ p: 3 }}>
              <ErrorState
                title="Could not load stages"
                description={
                  stagesQuery.error instanceof ApiError
                    ? stagesQuery.error.detail || stagesQuery.error.title
                    : 'Please try again.'
                }
                onRetry={() => stagesQuery.refetch()}
              />
            </Box>
          ) : ordered.length === 0 ? (
            <Box sx={{ p: 3 }}>
              <EmptyState
                title="No lifecycle stages defined"
                description={
                  isAdmin
                    ? "Click “New stage” to create the first one — students will move through these as their journey progresses."
                    : 'An administrator hasn’t set up any lifecycle stages yet.'
                }
                actions={
                  isAdmin ? (
                    <Button
                      variant="contained"
                      startIcon={<AddIcon />}
                      onClick={openCreate}
                    >
                      New stage
                    </Button>
                  ) : undefined
                }
              />
            </Box>
          ) : (
            <TableContainer>
              <Table size="small" aria-label={t('aria.table')}>
                <TableHead>
                  <TableRow
                    sx={{
                      '& .MuiTableCell-head': {
                        fontSize: 12,
                        fontWeight: 600,
                        letterSpacing: 0.4,
                        textTransform: 'uppercase',
                        color: 'text.secondary',
                        borderTop: (t) => `1px solid ${t.palette.divider}`,
                        borderBottom: (t) => `1px solid ${t.palette.divider}`,
                        bgcolor: (t) => t.palette.action.hover,
                      },
                    }}
                  >
                    <TableCell sx={{ width: 60 }}>Order</TableCell>
                    <TableCell>Stage</TableCell>
                    <TableCell>Category</TableCell>
                    <TableCell>Color</TableCell>
                    <TableCell>Flags</TableCell>
                    <TableCell align="right">SLA (h)</TableCell>
                    {isAdmin ? (
                      <TableCell align="right" sx={{ width: 200 }}>
                        Actions
                      </TableCell>
                    ) : null}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {ordered.map((stage, idx) => {
                    const isFirst = idx === 0;
                    const isLast = idx === ordered.length - 1;
                    return (
                      <StageRow
                        key={stage.id}
                        stage={stage}
                        index={idx}
                        isFirst={isFirst}
                        isLast={isLast}
                        showArrowAfter={!isLast}
                        canEdit={isAdmin}
                        onEdit={() => openEdit(stage)}
                        onDelete={() => setDeleteTarget(stage)}
                        onMoveUp={() => move(stage, -1)}
                        onMoveDown={() => move(stage, 1)}
                        disabled={reorderMutation.isPending}
                      />
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </CardContent>
      </Card>

      <Card variant="outlined">
        <CardContent>
          <TransitionMatrix stages={ordered} canEdit={isAdmin} />
        </CardContent>
      </Card>

      {/* Edit / create dialog */}
      <StageEditDialog
        open={editorOpen}
        stage={editing}
        nextSequence={nextSequence}
        onClose={closeEditor}
      />

      {/* Typed-confirmation delete dialog */}
      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete stage"
        description={
          deleteTarget ? (
            <Typography variant="body2" color="text.secondary">
              This permanently removes the stage. The API will refuse if students are currently
              sitting on it.
            </Typography>
          ) : null
        }
        confirmLabel={deleteTarget?.key ?? null}
        confirmText="Delete stage"
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteTarget) deleteMutation.mutate(deleteTarget.id);
        }}
        onClose={closeDeleteDialog}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Row + connecting-arrow renderer kept inline so the page stays one file.
// ---------------------------------------------------------------------------

type RowProps = {
  stage: Stage;
  index: number;
  isFirst: boolean;
  isLast: boolean;
  showArrowAfter: boolean;
  canEdit: boolean;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
};

function StageRow({
  stage,
  index,
  isFirst,
  isLast,
  showArrowAfter,
  canEdit,
  disabled,
  onEdit,
  onDelete,
  onMoveUp,
  onMoveDown,
}: RowProps) {
  const t = useTranslations('stages');
  const colSpan = canEdit ? 7 : 6;
  return (
    <>
      <TableRow
        hover={canEdit}
        sx={{
          cursor: canEdit ? 'pointer' : 'default',
          '& > *': { borderBottom: 'unset' },
        }}
        onClick={canEdit ? onEdit : undefined}
      >
        <TableCell>
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
            {index + 1}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            seq {stage.sequence}
          </Typography>
        </TableCell>
        <TableCell>
          <Stack spacing={0.25}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {stage.label}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
              {stage.key}
            </Typography>
          </Stack>
        </TableCell>
        <TableCell>
          <Chip
            size="small"
            label={CATEGORY_LABEL[stage.category] ?? stage.category}
            variant="outlined"
          />
        </TableCell>
        <TableCell>
          <Stack direction="row" spacing={1} alignItems="center">
            <Box
              sx={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                bgcolor: stage.color_hex ?? 'action.disabledBackground',
                border: (t) => `1px solid ${t.palette.divider}`,
              }}
              aria-hidden
            />
            <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
              {stage.color_hex ?? '—'}
            </Typography>
          </Stack>
        </TableCell>
        <TableCell>
          <Stack direction="row" spacing={0.5} flexWrap="wrap">
            {stage.is_initial ? <Chip size="small" color="primary" label="initial" /> : null}
            {stage.is_terminal ? <Chip size="small" color="success" label="terminal" /> : null}
            {!stage.is_active ? <Chip size="small" color="default" label="inactive" /> : null}
            {!stage.is_initial && !stage.is_terminal && stage.is_active ? (
              <Typography variant="caption" color="text.secondary">
                —
              </Typography>
            ) : null}
          </Stack>
        </TableCell>
        <TableCell align="right">
          <Typography variant="body2">{stage.sla_hours ?? '—'}</Typography>
        </TableCell>
        {canEdit ? (
          <TableCell
            align="right"
            onClick={(e) => e.stopPropagation()}
            sx={{ whiteSpace: 'nowrap' }}
          >
            <Tooltip title="Move up">
              <span>
                <IconButton
                  size="small"
                  onClick={onMoveUp}
                  disabled={disabled || isFirst}
                  aria-label={t('aria.moveUp')}
                >
                  <ArrowUpwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Move down">
              <span>
                <IconButton
                  size="small"
                  onClick={onMoveDown}
                  disabled={disabled || isLast}
                  aria-label={t('aria.moveDown')}
                >
                  <ArrowDownwardIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Edit">
              <IconButton size="small" onClick={onEdit} aria-label={t('aria.edit')}>
                <EditOutlinedIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="Delete">
              <IconButton
                size="small"
                onClick={onDelete}
                aria-label={t('aria.delete')}
                color="error"
              >
                <DeleteOutlineIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </TableCell>
        ) : null}
      </TableRow>
      {showArrowAfter ? (
        <TableRow>
          <TableCell
            colSpan={colSpan}
            sx={{
              py: 0.25,
              borderBottom: 'none',
              bgcolor: 'background.default',
            }}
          >
            <Stack direction="row" spacing={1} alignItems="center" sx={{ pl: 1 }}>
              <ArrowDownwardOutlinedIcon
                fontSize="small"
                sx={{ color: 'text.disabled' }}
                aria-hidden
              />
              <Divider sx={{ flex: 1 }} />
            </Stack>
          </TableCell>
        </TableRow>
      ) : null}
    </>
  );
}
