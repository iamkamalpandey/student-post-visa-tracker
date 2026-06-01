'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Box,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { UpdateDSARRequest, DSARStatusEnum } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { isAdmin } from '@/lib/auth-helpers';

type DSARStatus = (typeof DSARStatusEnum.options)[number];

type DSARRow = {
  id: string;
  status: DSARStatus;
  notes: string | null;
};

type FormValues = {
  status?: DSARStatus;
  notes?: string;
};

// Mirror of apps/backend/src/modules/dsar/service.ts TRANSITIONS. Kept here so
// the dropdown only shows reachable states and the user is told about reason
// requirements before they hit submit.
type TransitionRule = {
  to: DSARStatus;
  adminOnly: boolean;
  requireReason: boolean;
};

const FSM: Record<DSARStatus, TransitionRule[]> = {
  PENDING: [
    { to: 'IN_PROGRESS', adminOnly: false, requireReason: false },
  ],
  IN_PROGRESS: [
    { to: 'COMPLETED',   adminOnly: false, requireReason: false },
    { to: 'REJECTED',    adminOnly: true,  requireReason: true  },
    { to: 'EXPIRED',     adminOnly: true,  requireReason: false },
  ],
  COMPLETED: [
    { to: 'IN_PROGRESS', adminOnly: true,  requireReason: true  },
  ],
  REJECTED: [
    { to: 'IN_PROGRESS', adminOnly: true,  requireReason: true  },
  ],
  EXPIRED: [], // terminal
};

const REASON_MIN_CHARS = 10;

function statusLabel(s: DSARStatus): string {
  return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, ' ');
}

export type UpdateDSARStatusDialogProps = {
  open: boolean;
  request: DSARRow | null;
  onClose: () => void;
};

export default function UpdateDSARStatusDialog({
  open,
  request,
  onClose,
}: UpdateDSARStatusDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const admin = isAdmin(user?.role ?? null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    watch,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(UpdateDSARRequest),
    mode: 'onBlur',
    defaultValues: { status: 'IN_PROGRESS', notes: '' },
  });

  useEffect(() => {
    if (request) {
      reset({ status: request.status, notes: request.notes ?? '' });
    }
  }, [request, reset]);

  // Computed allowed targets based on current row status + caller role.
  const options = useMemo(() => {
    if (!request) return [];
    const rules = FSM[request.status] ?? [];
    return rules
      .filter((r) => admin || !r.adminOnly)
      .map((r) => ({
        value: r.to,
        label: statusLabel(r.to) + (r.adminOnly ? ' (admin)' : ''),
        adminOnly: r.adminOnly,
        requireReason: r.requireReason,
      }));
  }, [request, admin]);

  const selectedTarget = watch('status');
  const selectedRule = useMemo(() => {
    if (!request || !selectedTarget) return null;
    return (FSM[request.status] ?? []).find((r) => r.to === selectedTarget) ?? null;
  }, [request, selectedTarget]);

  const reasonRequired = Boolean(selectedRule?.requireReason);

  const updateMut = useMutation({
    mutationFn: async (values: FormValues) => {
      if (!request) throw new Error('No request');
      const payload: Record<string, unknown> = {};
      if (values.status) payload['status'] = values.status;
      if (values.notes !== undefined && values.notes.trim() !== '') {
        payload['notes'] = values.notes.trim();
      }
      const res = await api.patch(`/dsar/${request.id}`, payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('DSAR updated.', { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['dsar'] });
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (fe.path === 'status' || fe.path === 'notes') {
            setError(fe.path as keyof FormValues, { type: 'server', message: fe.message });
          }
        }
        enqueueSnackbar(err.detail || err.title || 'Failed to update DSAR.', {
          variant: 'error',
        });
      } else {
        enqueueSnackbar('Network error. Please try again.', { variant: 'error' });
      }
    },
  });

  const onSubmit = handleSubmit((values) => {
    if (reasonRequired) {
      const reason = (values.notes ?? '').trim();
      if (reason.length < REASON_MIN_CHARS) {
        setError('notes', {
          type: 'manual',
          message: `Reason is required (min ${REASON_MIN_CHARS} characters).`,
        });
        return;
      }
    }
    updateMut.mutate(values);
  });

  const handleClose = () => {
    if (isSubmitting) return;
    onClose();
  };

  const noTargets = options.length === 0 && Boolean(request);
  const saveDisabled = !isDirty || isSubmitting || updateMut.isPending || !request || noTargets;
  const saveBlockedReason = !isDirty ? 'Make a change to enable saving' : null;

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title="Update DSAR status"
      primaryAction={{
        label: 'Save',
        loadingLabel: 'Saving…',
        loading: isSubmitting,
        formId: 'update-dsar-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="update-dsar-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        {/* Required-field legend. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Stack spacing={2.5}>
          {noTargets ? (
            <Alert severity="info">
              This request is in a terminal state ({request ? statusLabel(request.status) : ''}) and
              has no further transitions available to your role.
            </Alert>
          ) : null}

          <LabeledField
            label="Status"
            required
            error={Boolean(errors.status)}
            helperText={errors.status?.message ?? ''}
            htmlFor="dsar-status"
          >
            <Controller
              name="status"
              control={control}
              render={({ field }) => (
                <TextField
                  {...field}
                  id="dsar-status"
                  value={field.value ?? ''}
                  select
                  fullWidth
                  hiddenLabel
                  size="medium"
                  disabled={noTargets}
                  error={Boolean(errors.status)}
                >
                  {/* Always include the current status so the dropdown isn't empty
                      when the user opens the dialog without intending to change it. */}
                  {request ? (
                    <MenuItem value={request.status} disabled>
                      {statusLabel(request.status)} (current)
                    </MenuItem>
                  ) : null}
                  {options.map((s) => (
                    <MenuItem key={s.value} value={s.value}>
                      {s.label}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
          <LabeledField
            label={reasonRequired ? `Reason (min ${REASON_MIN_CHARS} chars)` : 'Notes'}
            required={reasonRequired}
            error={Boolean(errors.notes)}
            helperText={errors.notes?.message ?? (reasonRequired ? 'Explain why this transition is being made — recorded in the audit log.' : '')}
            htmlFor="dsar-status-notes"
          >
            <TextField
              id="dsar-status-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={3}
              placeholder={reasonRequired ? 'Identity could not be verified after three attempts.' : 'Optional context for the audit trail.'}
              error={Boolean(errors.notes)}
              {...register('notes')}
            />
          </LabeledField>
          {saveBlockedReason && (
            <Tooltip title="">
              <Typography variant="caption" color="text.secondary">
                {saveBlockedReason}
              </Typography>
            </Tooltip>
          )}
        </Stack>
      </Box>
    </AppDialog>
  );
}
