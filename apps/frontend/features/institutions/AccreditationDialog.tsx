// Refactored to SVT form-pattern per design pass.
'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  TextField,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import { CreateInstitutionAccreditationRequest } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { useSaveBlockedReason } from '@/components/useSaveBlockedReason';
import { api, ApiError } from '@/lib/api';

const FORM_BOX_SX = {
  '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
  '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
  '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
} as const;

type FormValues = {
  body: string;
  accreditation_no: string;
  awarded_on: string;
  expires_on: string;
  scope: string;
};

const empty = (): FormValues => ({
  body: '',
  accreditation_no: '',
  awarded_on: '',
  expires_on: '',
  scope: '',
});

function buildPayload(v: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = { body: v.body.trim() };
  if (v.accreditation_no.trim()) out['accreditation_no'] = v.accreditation_no.trim();
  if (v.awarded_on.trim()) out['awarded_on'] = v.awarded_on;
  if (v.expires_on.trim()) out['expires_on'] = v.expires_on;
  if (v.scope.trim()) out['scope'] = v.scope.trim();
  return out;
}

export type AccreditationDialogProps = {
  open: boolean;
  institutionId: string;
  onClose: () => void;
};

export default function AccreditationDialog({
  open,
  institutionId,
  onClose,
}: AccreditationDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: empty() });

  useEffect(() => {
    if (open) reset(empty());
  }, [open, reset]);

  const mut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await api.post(
        `/institutions/${institutionId}/accreditations`,
        payload,
      );
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Accreditation added.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['institutions', 'detail', institutionId] });
      void qc.invalidateQueries({
        queryKey: ['institutions', institutionId, 'accreditations'],
      });
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (fe.path in (empty() as object)) {
            setError(fe.path as keyof FormValues, { type: 'server', message: fe.message });
          }
        }
        enqueueSnackbar(err.detail || err.title || 'Failed.', { variant: 'error' });
      } else {
        enqueueSnackbar('Network error.', { variant: 'error' });
      }
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      const payload = buildPayload(values);
      const parsed = CreateInstitutionAccreditationRequest.safeParse(payload);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const path = issue.path[0]?.toString();
          if (path && path in (empty() as object)) {
            setError(path as keyof FormValues, {
              type: 'validate',
              message: issue.message,
            });
          }
        }
        return;
      }
      await mut.mutateAsync(payload);
    } finally {
      setSubmitting(false);
    }
  });

  const { disabled: saveDisabled, reason: saveBlockedReason } = useSaveBlockedReason({
    isDirty,
    isSubmitting,
    submitting: submitting || mut.isPending,
  });

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="New accreditation"
      primaryAction={{
        label: 'Add accreditation',
        loadingLabel: 'Saving…',
        loading: submitting,
        formId: 'accreditation-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="accreditation-form"
        onSubmit={onSubmit}
        noValidate
        sx={FORM_BOX_SX}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Grid container spacing={2.5}>
          <Grid item xs={12}>
            <LabeledField
              label="Awarding body"
              required
              error={Boolean(errors.body)}
              helperText={errors.body?.message ?? ''}
              htmlFor="acc-body"
            >
              <TextField
                id="acc-body"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. AACSB International"
                error={Boolean(errors.body)}
                {...register('body', { required: 'Required' })}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12}>
            <LabeledField
              label="Accreditation number"
              error={Boolean(errors.accreditation_no)}
              helperText={errors.accreditation_no?.message ?? ''}
              htmlFor="acc-no"
            >
              <TextField
                id="acc-no"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. ACC-2024-0123"
                error={Boolean(errors.accreditation_no)}
                {...register('accreditation_no')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Awarded on"
              error={Boolean(errors.awarded_on)}
              helperText={errors.awarded_on?.message ?? ''}
              htmlFor="acc-awarded_on"
            >
              <TextField
                id="acc-awarded_on"
                type="date"
                fullWidth
                size="medium"
                hiddenLabel
                error={Boolean(errors.awarded_on)}
                {...register('awarded_on')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Expires on"
              error={Boolean(errors.expires_on)}
              helperText={errors.expires_on?.message ?? ''}
              htmlFor="acc-expires_on"
            >
              <TextField
                id="acc-expires_on"
                type="date"
                fullWidth
                size="medium"
                hiddenLabel
                error={Boolean(errors.expires_on)}
                {...register('expires_on')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12}>
            <LabeledField
              label="Scope"
              error={Boolean(errors.scope)}
              helperText={errors.scope?.message ?? 'Programs or units covered.'}
              htmlFor="acc-scope"
            >
              <TextField
                id="acc-scope"
                fullWidth
                hiddenLabel
                multiline
                minRows={2}
                placeholder="e.g. All MBA, MSc Finance and undergraduate business programs"
                error={Boolean(errors.scope)}
                {...register('scope')}
              />
            </LabeledField>
          </Grid>
        </Grid>
        {saveBlockedReason && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 1, textAlign: 'right' }}
          >
            {saveBlockedReason}
          </Typography>
        )}
      </Box>
    </AppDialog>
  );
}
