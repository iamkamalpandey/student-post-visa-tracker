'use client';

// Per-student "current stage checklist" — shown at the TOP of the JourneyTab.
// Renders the items defined for the student's current stage, hydrated with
// their personal completion progress. A small percentage ring provides at-a-
// glance visibility on overall completion.
//
// Toggling a checkbox POSTs an upsert to /students/:id/checklist-progress.
// Notes are optional per item; we save on blur.
//
// Two queries fan out:
//   * items:    /stages/:stageId/checklist-items   (definitions)
//   * progress: /students/:id/checklist-progress?stage_id=:stageId
// Combined into a single render list keyed by item.id.

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  Card,
  CardContent,
  Checkbox,
  CircularProgress,
  Divider,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import EditNoteOutlinedIcon from '@mui/icons-material/EditNoteOutlined';

import { ApiError, api } from '@/lib/api';
import { useCanWrite } from '@/features/students/sectionShared';

type ChecklistItem = {
  id: string;
  stage_id: string;
  label: string;
  description: string | null;
  sequence: number;
  is_required: boolean;
  is_active: boolean;
};

type ProgressRow = {
  id: string;
  student_id: string;
  stage_id: string;
  checklist_item_id: string;
  completed_at: string | null;
  notes: string | null;
};

type Props = {
  studentId: string;
  /** The student's current stage; null if they're somehow stage-less. */
  currentStageId: string | null;
  /** Optional label for the section heading. */
  stageLabel?: string | null;
};

export default function CurrentStageChecklist({ studentId, currentStageId, stageLabel }: Props) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const [openNotesFor, setOpenNotesFor] = useState<string | null>(null);

  const enabled = Boolean(currentStageId);
  const itemsQueryKey = ['stages', currentStageId, 'checklist-items'] as const;
  const progressQueryKey = [
    'students',
    studentId,
    'checklist-progress',
    currentStageId,
  ] as const;

  const itemsQuery = useQuery({
    queryKey: itemsQueryKey,
    enabled,
    queryFn: async () => {
      const res = await api.get(`/stages/${currentStageId}/checklist-items`);
      return ((res.data as { data: ChecklistItem[] }).data) ?? [];
    },
  });

  const progressQuery = useQuery({
    queryKey: progressQueryKey,
    enabled,
    queryFn: async () => {
      const res = await api.get(
        `/students/${studentId}/checklist-progress?stage_id=${currentStageId}`,
      );
      return ((res.data as { data: ProgressRow[] }).data) ?? [];
    },
  });

  const upsertMutation = useMutation({
    mutationFn: async (payload: {
      checklist_item_id: string;
      completed: boolean;
      notes?: string | null;
    }) => {
      const res = await api.post(`/students/${studentId}/checklist-progress`, payload);
      return res.data as ProgressRow;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: progressQueryKey }),
    onError: (err: unknown) => {
      enqueueSnackbar(err instanceof ApiError ? err.detail || err.title : 'Save failed', {
        variant: 'error',
      });
    },
  });

  // Merge progress into items by id.
  const rows = useMemo(() => {
    const items = itemsQuery.data ?? [];
    const progressById = new Map<string, ProgressRow>();
    for (const p of progressQuery.data ?? []) progressById.set(p.checklist_item_id, p);
    return items.map((item) => ({
      item,
      progress: progressById.get(item.id) ?? null,
    }));
  }, [itemsQuery.data, progressQuery.data]);

  const total = rows.length;
  const completed = rows.filter((r) => r.progress?.completed_at).length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  if (!enabled) return null;
  if (itemsQuery.isLoading) return null;
  if (total === 0 && !itemsQuery.error) return null; // nothing configured for this stage — keep UI quiet

  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}>
      <CardContent>
        <Stack
          direction="row"
          spacing={2}
          alignItems="center"
          justifyContent="space-between"
          sx={{ mb: 1 }}
        >
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Stage checklist{stageLabel ? ` — ${stageLabel}` : ''}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {completed} of {total} complete
            </Typography>
          </Box>
          <CompletionRing pct={pct} />
        </Stack>
        <Divider sx={{ mb: 1.5 }} />
        <Stack spacing={0.5}>
          {rows.map(({ item, progress }) => {
            const isDone = Boolean(progress?.completed_at);
            const noteOpen = openNotesFor === item.id;
            return (
              <Box key={item.id}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Checkbox
                    size="small"
                    checked={isDone}
                    disabled={!canWrite || upsertMutation.isPending}
                    onChange={(e) =>
                      upsertMutation.mutate({
                        checklist_item_id: item.id,
                        completed: e.target.checked,
                      })
                    }
                  />
                  <Box sx={{ flex: 1 }}>
                    <Typography
                      variant="body2"
                      sx={{
                        textDecoration: isDone ? 'line-through' : 'none',
                        color: isDone ? 'text.secondary' : 'text.primary',
                      }}
                    >
                      {item.label}
                      {item.is_required ? null : (
                        <Typography
                          component="span"
                          variant="caption"
                          color="text.secondary"
                          sx={{ ml: 1 }}
                        >
                          (optional)
                        </Typography>
                      )}
                    </Typography>
                    {item.description ? (
                      <Typography variant="caption" color="text.secondary" display="block">
                        {item.description}
                      </Typography>
                    ) : null}
                  </Box>
                  <Tooltip title={progress?.notes ? 'Edit note' : 'Add note'}>
                    <IconButton
                      size="small"
                      onClick={() => setOpenNotesFor(noteOpen ? null : item.id)}
                      aria-label={`Notes for ${item.label}`}
                    >
                      <EditNoteOutlinedIcon
                        fontSize="small"
                        color={progress?.notes ? 'primary' : 'action'}
                      />
                    </IconButton>
                  </Tooltip>
                </Stack>
                {noteOpen ? (
                  <NotesField
                    initial={progress?.notes ?? ''}
                    disabled={!canWrite || upsertMutation.isPending}
                    onSave={(notes) =>
                      upsertMutation.mutate({
                        checklist_item_id: item.id,
                        completed: isDone,
                        notes,
                      })
                    }
                  />
                ) : progress?.notes ? (
                  <Typography
                    variant="caption"
                    color="text.secondary"
                    sx={{ display: 'block', pl: 5, pb: 0.5 }}
                  >
                    {progress.notes}
                  </Typography>
                ) : null}
              </Box>
            );
          })}
        </Stack>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Completion ring — a small SVG circle with the percentage label inside.
// ---------------------------------------------------------------------------

function CompletionRing({ pct }: { pct: number }) {
  return (
    <Box sx={{ position: 'relative', display: 'inline-flex' }}>
      <CircularProgress
        variant="determinate"
        value={pct}
        size={48}
        thickness={4}
        sx={{ color: pct === 100 ? 'success.main' : 'primary.main' }}
      />
      <Box
        sx={{
          top: 0,
          left: 0,
          bottom: 0,
          right: 0,
          position: 'absolute',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Typography variant="caption" sx={{ fontWeight: 600 }}>
          {pct}%
        </Typography>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Inline notes editor: saves on blur, no separate save button.
// ---------------------------------------------------------------------------

function NotesField({
  initial,
  disabled,
  onSave,
}: {
  initial: string;
  disabled: boolean;
  onSave: (notes: string) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <Box sx={{ pl: 5, py: 0.5 }}>
      <TextField
        size="small"
        multiline
        minRows={1}
        maxRows={4}
        fullWidth
        placeholder="Add a note (saved on blur)"
        value={value}
        disabled={disabled}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => {
          if (value !== initial) onSave(value);
        }}
        inputProps={{ maxLength: 2000 }}
      />
    </Box>
  );
}
