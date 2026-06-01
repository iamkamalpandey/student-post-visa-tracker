// Refactored to SVT form-pattern per design pass.
'use client';

import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  FormControlLabel,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import { CreateSchoolRequest, UpdateSchoolRequest } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { useSaveBlockedReason } from '@/components/useSaveBlockedReason';
import { api, ApiError } from '@/lib/api';
import type { SchoolRow } from './types';

const FORM_BOX_SX = {
  '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
  '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
} as const;

type FormValues = {
  name: string;
  short_name: string;
  is_active: boolean;
};

const empty = (): FormValues => ({ name: '', short_name: '', is_active: true });

function fromSchool(s: SchoolRow): FormValues {
  return {
    name: s.name,
    short_name: s.short_name ?? '',
    is_active: s.is_active,
  };
}

function buildPayload(v: FormValues, isEdit: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { name: v.name.trim() };
  if (v.short_name.trim()) out['short_name'] = v.short_name.trim();
  if (isEdit) out['is_active'] = v.is_active;
  return out;
}

export type SchoolDialogProps = {
  open: boolean;
  institutionId: string;
  school: SchoolRow | null;
  onClose: () => void;
};

export default function SchoolDialog({
  open,
  institutionId,
  school,
  onClose,
}: SchoolDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const isEdit = Boolean(school);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: empty() });

  useEffect(() => {
    if (open) reset(school ? fromSchool(school) : empty());
  }, [open, school, reset]);

  const mut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (school) {
        const res = await api.patch(`/institutions/schools/${school.id}`, payload);
        return res.data;
      }
      const res = await api.post(`/institutions/${institutionId}/schools`, payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'School updated.' : 'School added.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['institutions', 'detail', institutionId] });
      void qc.invalidateQueries({
        queryKey: ['institutions', institutionId, 'schools'],
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
      const payload = buildPayload(values, isEdit);
      const schema = isEdit ? UpdateSchoolRequest : CreateSchoolRequest;
      const parsed = schema.safeParse(payload);
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
      title={isEdit ? 'Edit school' : 'New school'}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Add school',
        loadingLabel: 'Saving…',
        loading: submitting,
        formId: 'school-form',
        disabled: saveDisabled,
      }}
    >
      <Box component="form" id="school-form" onSubmit={onSubmit} noValidate sx={FORM_BOX_SX}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Grid container spacing={2.5}>
          <Grid item xs={12}>
            <LabeledField
              label="Name"
              required
              error={Boolean(errors.name)}
              helperText={errors.name?.message ?? ''}
              htmlFor="sch-name"
            >
              <TextField
                id="sch-name"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. School of Computer Science"
                error={Boolean(errors.name)}
                {...register('name', { required: 'Required' })}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12}>
            <LabeledField
              label="Short name"
              error={Boolean(errors.short_name)}
              helperText={errors.short_name?.message ?? ''}
              htmlFor="sch-short_name"
            >
              <TextField
                id="sch-short_name"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. SCS"
                error={Boolean(errors.short_name)}
                {...register('short_name')}
              />
            </LabeledField>
          </Grid>
          {isEdit ? (
            <Grid item xs={12}>
              <LabeledField label="Status">
                <Controller
                  name="is_active"
                  control={control}
                  render={({ field }) => (
                    <FormControlLabel
                      sx={{ m: 0, height: 44, alignItems: 'center' }}
                      control={
                        <Switch
                          checked={field.value}
                          onChange={(_, c) => field.onChange(c)}
                        />
                      }
                      label={field.value ? 'Active' : 'Inactive'}
                    />
                  )}
                />
              </LabeledField>
            </Grid>
          ) : null}
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
