'use client';

// Inline editor for a stage's checklist items. Mounted inside StageEditDialog
// below the existing fields. ADMIN+COUNSELLOR can add/edit; ADMIN-only can
// delete (matches the backend's role policy).
//
// The dialog stays open while edits happen — every change is its own request,
// no batched save. This mirrors the screenshot's "list-of-rows + add new" UX
// from CMST.
//
// We invalidate ['stages', stageId, 'checklist-items'] after every mutation so
// the CurrentStageChecklist for any open student detail view picks up changes
// on its next refetch.

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  Button,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import CheckIcon from '@mui/icons-material/Check';

import { ApiError, api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { canWriteStudents } from '@/lib/auth-helpers';
import ConfirmDialog from '@/components/ConfirmDialog';

type ChecklistItem = {
  id: string;
  stage_id: string;
  label: string;
  description: string | null;
  sequence: number;
  is_required: boolean;
  is_active: boolean;
};

type Props = {
  /** Stage id this editor edits. Pass null/undefined to render an info hint. */
  stageId: string | null;
};

export default function StageChecklistEditor({ stageId }: Props) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { user } = useAuth();
  const canWrite = canWriteStudents(user?.role);
  const isAdmin = user?.role === 'ADMIN';

  const [newLabel, setNewLabel] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<ChecklistItem | null>(null);

  const queryKey = ['stages', stageId, 'checklist-items'] as const;
  const itemsQuery = useQuery({
    queryKey,
    enabled: Boolean(stageId),
    queryFn: async () => {
      const res = await api.get(`/stages/${stageId}/checklist-items`);
      return ((res.data as { data: ChecklistItem[] }).data) ?? [];
    },
  });

  const createMutation = useMutation({
    mutationFn: async (label: string) => {
      const res = await api.post(`/stages/${stageId}/checklist-items`, { label });
      return res.data as ChecklistItem;
    },
    onSuccess: () => {
      setNewLabel('');
      void qc.invalidateQueries({ queryKey });
    },
    onError: (err: unknown) => {
      enqueueSnackbar(err instanceof ApiError ? err.detail || err.title : 'Add failed', {
        variant: 'error',
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: Partial<ChecklistItem> }) => {
      const res = await api.patch(`/stages/checklist-items/${id}`, patch);
      return res.data as ChecklistItem;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey }),
    onError: (err: unknown) => {
      enqueueSnackbar(err instanceof ApiError ? err.detail || err.title : 'Save failed', {
        variant: 'error',
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await api.delete(`/stages/checklist-items/${id}`);
    },
    onSuccess: () => {
      setConfirmDelete(null);
      void qc.invalidateQueries({ queryKey });
      enqueueSnackbar('Item removed', { variant: 'success' });
    },
    onError: (err: unknown) => {
      enqueueSnackbar(err instanceof ApiError ? err.detail || err.title : 'Delete failed', {
        variant: 'error',
      });
    },
  });

  if (!stageId) {
    return (
      <Typography variant="caption" color="text.secondary">
        Save the stage first, then add checklist tasks here.
      </Typography>
    );
  }

  const items = itemsQuery.data ?? [];

  return (
    <Stack spacing={1.5}>
      {items.length === 0 && !itemsQuery.isLoading ? (
        <Typography variant="caption" color="text.secondary">
          No tasks yet. Add the first one below.
        </Typography>
      ) : null}

      {items.map((item) => (
        <ChecklistRow
          key={item.id}
          item={item}
          canWrite={canWrite}
          canDelete={isAdmin}
          onUpdate={(patch) => updateMutation.mutate({ id: item.id, patch })}
          onDelete={() => setConfirmDelete(item)}
        />
      ))}

      {canWrite ? (
        <Box
          component="form"
          onSubmit={(e) => {
            e.preventDefault();
            const trimmed = newLabel.trim();
            if (!trimmed) return;
            createMutation.mutate(trimmed);
          }}
          sx={{ display: 'flex', gap: 1, mt: 1 }}
        >
          <TextField
            size="small"
            placeholder="e.g. Pre-departure briefing"
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            fullWidth
            inputProps={{ maxLength: 200 }}
          />
          <Button
            type="submit"
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            disabled={!newLabel.trim() || createMutation.isPending}
          >
            Add
          </Button>
        </Box>
      ) : null}

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        onClose={() => (deleteMutation.isPending ? undefined : setConfirmDelete(null))}
        title="Remove checklist task?"
        description={
          confirmDelete ? (
            <Typography variant="body2">
              Remove <strong>{confirmDelete.label}</strong> from this stage&apos;s checklist?
              Existing student progress is preserved for audit but the task will no longer
              appear in new checklists.
            </Typography>
          ) : null
        }
        confirmText="Remove"
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (confirmDelete) deleteMutation.mutate(confirmDelete.id);
        }}
      />
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Row: label is editable inline (blur to save). Delete on the right.
// ---------------------------------------------------------------------------

function ChecklistRow({
  item,
  canWrite,
  canDelete,
  onUpdate,
  onDelete,
}: {
  item: ChecklistItem;
  canWrite: boolean;
  canDelete: boolean;
  onUpdate: (patch: Partial<ChecklistItem>) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(item.label);

  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <TextField
        size="small"
        value={draft}
        disabled={!canWrite}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const next = draft.trim();
          if (next && next !== item.label) onUpdate({ label: next });
          else if (!next) setDraft(item.label);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        fullWidth
        inputProps={{ maxLength: 200 }}
      />
      {draft.trim() && draft !== item.label ? (
        <Tooltip title="Press Enter or blur to save">
          <CheckIcon fontSize="small" color="action" />
        </Tooltip>
      ) : null}
      {canDelete ? (
        <Tooltip title="Remove task">
          <IconButton size="small" onClick={onDelete} aria-label={`Remove ${item.label}`}>
            <DeleteOutlineIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      ) : null}
    </Stack>
  );
}
