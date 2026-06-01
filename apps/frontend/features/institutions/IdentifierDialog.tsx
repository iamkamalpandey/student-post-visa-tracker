// Refactored to SVT form-pattern per design pass.
'use client';

import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import { CreateInstitutionIdentifierRequest } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { useSaveBlockedReason } from '@/components/useSaveBlockedReason';
import { api, ApiError } from '@/lib/api';
import { IDENTIFIER_SCHEMES, type IdentifierRow } from './types';

const FORM_BOX_SX = {
  '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
  '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
  '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
} as const;

type FormValues = {
  scheme: IdentifierRow['scheme'];
  value: string;
  issued_by: string;
  valid_from: string;
  valid_to: string;
};

const empty = (): FormValues => ({
  scheme: 'OTHER',
  value: '',
  issued_by: '',
  valid_from: '',
  valid_to: '',
});

function buildPayload(v: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    scheme: v.scheme,
    value: v.value.trim(),
  };
  if (v.issued_by.trim()) out['issued_by'] = v.issued_by.trim();
  if (v.valid_from.trim()) out['valid_from'] = v.valid_from;
  if (v.valid_to.trim()) out['valid_to'] = v.valid_to;
  return out;
}

export type IdentifierDialogProps = {
  open: boolean;
  institutionId: string;
  onClose: () => void;
};

export default function IdentifierDialog({
  open,
  institutionId,
  onClose,
}: IdentifierDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: empty() });

  useEffect(() => {
    if (open) reset(empty());
  }, [open, reset]);

  const mut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await api.post(`/institutions/${institutionId}/identifiers`, payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Identifier added.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['institutions', 'detail', institutionId] });
      void qc.invalidateQueries({
        queryKey: ['institutions', institutionId, 'identifiers'],
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
      const parsed = CreateInstitutionIdentifierRequest.safeParse(payload);
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
      title="New identifier"
      primaryAction={{
        label: 'Add identifier',
        loadingLabel: 'Saving…',
        loading: submitting,
        formId: 'identifier-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="identifier-form"
        onSubmit={onSubmit}
        noValidate
        sx={FORM_BOX_SX}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Grid container spacing={2.5}>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Scheme"
              required
              error={Boolean(errors.scheme)}
              helperText={errors.scheme?.message ?? ''}
              htmlFor="idf-scheme"
            >
              <Controller
                name="scheme"
                control={control}
                render={({ field }) => (
                  <TextField
                    {...field}
                    id="idf-scheme"
                    select
                    fullWidth
                    size="medium"
                    hiddenLabel
                    error={Boolean(errors.scheme)}
                  >
                    {IDENTIFIER_SCHEMES.map((s) => (
                      <MenuItem key={s.value} value={s.value}>
                        {s.label}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Value"
              required
              error={Boolean(errors.value)}
              helperText={errors.value?.message ?? ''}
              htmlFor="idf-value"
            >
              <TextField
                id="idf-value"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. 12345"
                error={Boolean(errors.value)}
                {...register('value', { required: 'Required' })}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12}>
            <LabeledField
              label="Issued by"
              error={Boolean(errors.issued_by)}
              helperText={errors.issued_by?.message ?? ''}
              htmlFor="idf-issued_by"
            >
              <TextField
                id="idf-issued_by"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. UK Office for Students"
                error={Boolean(errors.issued_by)}
                {...register('issued_by')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Valid from"
              error={Boolean(errors.valid_from)}
              helperText={errors.valid_from?.message ?? ''}
              htmlFor="idf-valid_from"
            >
              <TextField
                id="idf-valid_from"
                type="date"
                fullWidth
                size="medium"
                hiddenLabel
                error={Boolean(errors.valid_from)}
                {...register('valid_from')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Valid to"
              error={Boolean(errors.valid_to)}
              helperText={errors.valid_to?.message ?? ''}
              htmlFor="idf-valid_to"
            >
              <TextField
                id="idf-valid_to"
                type="date"
                fullWidth
                size="medium"
                hiddenLabel
                error={Boolean(errors.valid_to)}
                {...register('valid_to')}
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
