'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Box,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import GavelOutlinedIcon from '@mui/icons-material/GavelOutlined';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import { DSARTypeEnum } from '@spv/zod-schemas';

import { api, ApiError } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';

type DSARType = (typeof DSARTypeEnum.options)[number];

export type EditDSARRow = {
  id: string;
  subject_type: string;
  subject_id: string;
  type: DSARType;
  due_by: string;
  notes: string | null;
  // Optimistic-concurrency: set when the backend exposes a `version` field.
  // The server currently doesn't, so the conditional If-Match below will be
  // omitted whenever this is undefined.
  version?: number | null;
};

type FormValues = {
  type: DSARType;
  due_by: string; // datetime-local string (YYYY-MM-DDTHH:mm)
  subject_type: 'student' | 'user' | string;
  subject_id: string;
  notes: string;
};

const DSAR_TYPES = DSARTypeEnum.options.map((t) => ({
  value: t,
  label: t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' '),
}));

const SUBJECT_TYPES = [
  { value: 'student', label: 'Student' },
  { value: 'user', label: 'User' },
];

// Backend `UpdateDSARRequest` (strict zod) currently only allows `status`,
// `export_storage_key`, and `notes`. Everything else is presented read-only;
// when the backend grows fields/regulatory carve-outs, drop the readOnly
// treatment and add the field to the PATCH payload.
const PATCHABLE_FIELDS: Set<keyof FormValues> = new Set(['notes']);

function isoToLocalDatetime(iso: string): string {
  if (!iso) return '';
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export type EditDSARDialogProps = {
  open: boolean;
  request: EditDSARRow | null;
  onClose: () => void;
};

export default function EditDSARDialog({ open, request, onClose }: EditDSARDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const queryClient = useQueryClient();

  const defaults: FormValues = useMemo(
    () => ({
      type: request?.type ?? 'ACCESS',
      due_by: request ? isoToLocalDatetime(request.due_by) : '',
      subject_type: request?.subject_type ?? 'student',
      subject_id: request?.subject_id ?? '',
      notes: request?.notes ?? '',
    }),
    [request],
  );

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, isSubmitting, dirtyFields, isDirty },
  } = useForm<FormValues>({
    mode: 'onBlur',
    defaultValues: defaults,
  });

  // Re-seed every time we open with a new row.
  useEffect(() => {
    if (open && request) reset(defaults);
  }, [open, request, defaults, reset]);

  const updateMut = useMutation({
    mutationFn: async (values: FormValues) => {
      if (!request) throw new Error('No request');
      const payload: Record<string, unknown> = {};
      // Only send the fields the backend currently accepts.
      if (values.notes.trim() !== (request.notes ?? '').trim()) {
        payload['notes'] = values.notes.trim();
      }
      // Build optional If-Match header from row.version (backend may add it later).
      const headers: Record<string, string> = {};
      if (typeof request.version === 'number') {
        headers['If-Match'] = `"${request.version}"`;
      }
      // If nothing patchable changed but the user hit Save, surface a no-op
      // toast rather than calling the API for nothing.
      if (Object.keys(payload).length === 0) {
        return { _noop: true } as const;
      }
      const res = await api.patch(`/dsar/${request.id}`, payload, { headers });
      return res.data;
    },
    onSuccess: (data) => {
      const nonPatchableTouched = Object.keys(dirtyFields).some(
        (k) => !PATCHABLE_FIELDS.has(k as keyof FormValues),
      );
      if ((data as { _noop?: boolean })?._noop && !nonPatchableTouched) {
        enqueueSnackbar('No changes to save.', { variant: 'info' });
      } else if (nonPatchableTouched) {
        enqueueSnackbar(
          'Saved. Note: type / due-by / subject changes are not yet supported by the backend and were ignored.',
          { variant: 'warning' },
        );
      } else {
        enqueueSnackbar('DSAR updated.', { variant: 'success' });
      }
      void queryClient.invalidateQueries({ queryKey: ['dsar'] });
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          const leaf = fe.path.split('.').pop();
          if (leaf && (leaf in defaults)) {
            setError(leaf as keyof FormValues, { type: 'server', message: fe.message });
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

  const onSubmit = handleSubmit((values) => updateMut.mutate(values));

  const saveDisabled = !isDirty || isSubmitting || updateMut.isPending || !request;
  const saveBlockedReason = !isDirty ? 'Make a change to enable saving' : null;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Edit DSAR"
      subtitle={
        request
          ? `Request ${request.id.slice(0, 8)}… · created for ${request.subject_type}`
          : undefined
      }
      maxWidth="md"
      primaryAction={{
        label: 'Save changes',
        loadingLabel: 'Saving…',
        loading: isSubmitting || updateMut.isPending,
        formId: 'edit-dsar-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="edit-dsar-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="datetime-local"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        <Alert severity="info" variant="outlined" sx={{ mb: 2 }}>
          DSAR records are regulatory evidence — fields below are presented for
          context. Editing is currently limited to <strong>Notes</strong>; other
          fields will become editable once the backend supports them.
        </Alert>

        <FormSection
          title="Request"
          subtitle="Type, deadline and subject — read-only until backend support lands"
          icon={<GavelOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Type"
                helperText={errors.type?.message ?? 'Backend support pending.'}
                error={Boolean(errors.type)}
                htmlFor="dsar-edit-type"
              >
                <Controller
                  name="type"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      id="dsar-edit-type"
                      select
                      fullWidth
                      hiddenLabel
                      size="medium"
                      disabled
                      error={Boolean(errors.type)}
                    >
                      {DSAR_TYPES.map((opt) => (
                        <MenuItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>

            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Due by"
                helperText={errors.due_by?.message ?? 'Backend support pending.'}
                error={Boolean(errors.due_by)}
                htmlFor="dsar-edit-due-by"
              >
                <TextField
                  id="dsar-edit-due-by"
                  type="datetime-local"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  disabled
                  error={Boolean(errors.due_by)}
                  {...register('due_by')}
                />
              </LabeledField>
            </Grid>

            <Grid item xs={12} sm={4}>
              <LabeledField
                label="Subject type"
                helperText={errors.subject_type?.message ?? 'Backend support pending.'}
                error={Boolean(errors.subject_type)}
                htmlFor="dsar-edit-subject-type"
              >
                <Controller
                  name="subject_type"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      id="dsar-edit-subject-type"
                      select
                      fullWidth
                      hiddenLabel
                      size="medium"
                      disabled
                      error={Boolean(errors.subject_type)}
                    >
                      {SUBJECT_TYPES.map((opt) => (
                        <MenuItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>

            <Grid item xs={12} sm={8}>
              <LabeledField
                label="Subject ID"
                encrypted
                helperText={errors.subject_id?.message ?? 'Backend support pending.'}
                error={Boolean(errors.subject_id)}
                htmlFor="dsar-edit-subject-id"
              >
                <TextField
                  id="dsar-edit-subject-id"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  disabled
                  inputProps={{ style: { fontFamily: 'monospace' } }}
                  error={Boolean(errors.subject_id)}
                  {...register('subject_id')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Notes"
          subtitle="Editable. Appended to the audit trail."
          icon={<StickyNote2OutlinedIcon />}
          iconColor="muted"
          compact
        >
          <LabeledField
            label="Notes"
            error={Boolean(errors.notes)}
            helperText={
              errors.notes?.message ??
              'Editable. Notes are appended to the request audit trail.'
            }
            htmlFor="dsar-edit-notes"
          >
            <TextField
              id="dsar-edit-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={4}
              placeholder="Identity verified via passport scan; export queued."
              inputProps={{ maxLength: 2000 }}
              error={Boolean(errors.notes)}
              {...register('notes')}
            />
          </LabeledField>
        </FormSection>

        {saveBlockedReason && (
          <Tooltip title="">
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {saveBlockedReason}
            </Typography>
          </Tooltip>
        )}
      </Box>
    </AppDialog>
  );
}
