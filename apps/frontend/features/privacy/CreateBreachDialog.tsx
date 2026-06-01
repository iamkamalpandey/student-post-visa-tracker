'use client';

// Refactored to SVT form-pattern per design pass.

import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { z } from 'zod';
import {
  Box,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { CreateBreachRequest } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { api, ApiError } from '@/lib/api';

type FormValues = {
  detected_at: string; // datetime-local string
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  affected_subjects_count?: number;
  description: string;
  remediation?: string;
};

// Form-side schema: accept the datetime-local value (no offset) and convert
// to ISO 8601 with offset before zod validates against the API schema.
const FormSchema = z
  .object({
    detected_at: z
      .string()
      .min(1, 'Required')
      .transform((v) => new Date(v).toISOString()),
    severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
    affected_subjects_count: z
      .preprocess(
        (v) => (v === '' || v === undefined || v === null ? undefined : Number(v)),
        z.number().int().min(0).optional(),
      ),
    description: z.string().min(1).max(5000),
    remediation: z
      .preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z
        .string()
        .max(5000)
        .optional()),
  })
  .strict();

const SEVERITIES = [
  { value: 'LOW', label: 'Low' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'HIGH', label: 'High' },
  { value: 'CRITICAL', label: 'Critical' },
] as const;

export type CreateBreachDialogProps = {
  open: boolean;
  onClose: () => void;
};

export default function CreateBreachDialog({ open, onClose }: CreateBreachDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const queryClient = useQueryClient();

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    mode: 'onBlur',
    defaultValues: {
      detected_at: new Date().toISOString().slice(0, 16),
      severity: 'MEDIUM',
      affected_subjects_count: undefined,
      description: '',
      remediation: '',
    },
  });

  const createMut = useMutation({
    mutationFn: async (values: unknown) => {
      // values has been transformed by the form schema (detected_at -> ISO).
      const parsed = CreateBreachRequest.parse({
        ...(values as Record<string, unknown>),
        notification_sent: false,
      });
      const res = await api.post('/breach-incidents', parsed);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Breach incident recorded.', { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['breach-incidents'] });
      // SVT-WAVE42-DASH-INVALIDATE-2026-05 — pop the GDPR widget tile.
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      reset();
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (
            fe.path === 'detected_at' ||
            fe.path === 'severity' ||
            fe.path === 'affected_subjects_count' ||
            fe.path === 'description' ||
            fe.path === 'remediation'
          ) {
            setError(fe.path as keyof FormValues, { type: 'server', message: fe.message });
          }
        }
        enqueueSnackbar(err.detail || err.title || 'Failed to record incident.', {
          variant: 'error',
        });
      } else {
        enqueueSnackbar('Network error. Please try again.', { variant: 'error' });
      }
    },
  });

  const onSubmit = handleSubmit((values) => createMut.mutate(values));

  const handleClose = () => {
    if (isSubmitting) return;
    reset();
    onClose();
  };

  const saveDisabled = !isDirty || isSubmitting || createMut.isPending;
  const saveBlockedReason = !isDirty ? 'Make a change to enable saving' : null;

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title="Report breach incident"
      primaryAction={{
        label: 'Report incident',
        loadingLabel: 'Saving…',
        loading: isSubmitting,
        formId: 'create-breach-form',
        color: 'warning',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="create-breach-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="datetime-local"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        {/* Required-field legend. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Stack spacing={2.5}>
          <LabeledField
            label="Detected at"
            required
            error={Boolean(errors.detected_at)}
            helperText={errors.detected_at?.message ?? ''}
            htmlFor="breach-detected-at"
          >
            <TextField
              id="breach-detected-at"
              type="datetime-local"
              fullWidth
              hiddenLabel
              size="medium"
              error={Boolean(errors.detected_at)}
              {...register('detected_at')}
            />
          </LabeledField>
          <LabeledField
            label="Severity"
            required
            error={Boolean(errors.severity)}
            helperText={errors.severity?.message ?? ''}
            htmlFor="breach-severity"
          >
            <Controller
              name="severity"
              control={control}
              render={({ field }) => (
                <TextField
                  {...field}
                  id="breach-severity"
                  select
                  fullWidth
                  hiddenLabel
                  size="medium"
                  error={Boolean(errors.severity)}
                >
                  {SEVERITIES.map((s) => (
                    <MenuItem key={s.value} value={s.value}>
                      {s.label}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
          <LabeledField
            label="Affected subjects (count)"
            error={Boolean(errors.affected_subjects_count)}
            helperText={errors.affected_subjects_count?.message ?? 'Approximate is fine.'}
            htmlFor="breach-count"
          >
            <TextField
              id="breach-count"
              type="number"
              fullWidth
              hiddenLabel
              size="medium"
              placeholder="120"
              inputProps={{ min: 0, step: 1 }}
              error={Boolean(errors.affected_subjects_count)}
              {...register('affected_subjects_count')}
            />
          </LabeledField>
          <LabeledField
            label="Description"
            required
            error={Boolean(errors.description)}
            helperText={errors.description?.message ?? 'What happened, what data was exposed?'}
            htmlFor="breach-description"
          >
            <TextField
              id="breach-description"
              fullWidth
              hiddenLabel
              multiline
              minRows={3}
              placeholder="A misconfigured S3 bucket exposed CSV exports for 36 hours."
              error={Boolean(errors.description)}
              {...register('description')}
            />
          </LabeledField>
          <LabeledField
            label="Remediation"
            error={Boolean(errors.remediation)}
            helperText={errors.remediation?.message ?? 'Steps already taken, if any.'}
            htmlFor="breach-remediation"
          >
            <TextField
              id="breach-remediation"
              fullWidth
              hiddenLabel
              multiline
              minRows={2}
              placeholder="Bucket policy locked down; access logs reviewed."
              error={Boolean(errors.remediation)}
              {...register('remediation')}
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
