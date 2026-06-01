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
import { CreateDepartmentRequest, UpdateDepartmentRequest } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { useSaveBlockedReason } from '@/components/useSaveBlockedReason';
import { api, ApiError } from '@/lib/api';
import type { DepartmentRow } from './types';

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

function fromDepartment(d: DepartmentRow): FormValues {
  return {
    name: d.name,
    short_name: d.short_name ?? '',
    is_active: d.is_active,
  };
}

export type DepartmentDialogProps = {
  open: boolean;
  institutionId: string;
  schoolId: string;
  department: DepartmentRow | null;
  onClose: () => void;
};

export default function DepartmentDialog({
  open,
  institutionId,
  schoolId,
  department,
  onClose,
}: DepartmentDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const isEdit = Boolean(department);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: empty() });

  useEffect(() => {
    if (open) reset(department ? fromDepartment(department) : empty());
  }, [open, department, reset]);

  const mut = useMutation({
    mutationFn: async (values: FormValues) => {
      if (department) {
        const payload: Record<string, unknown> = { name: values.name.trim() };
        if (values.short_name.trim()) payload['short_name'] = values.short_name.trim();
        payload['is_active'] = values.is_active;
        const parsed = UpdateDepartmentRequest.safeParse(payload);
        if (!parsed.success) {
          throw new Error(parsed.error.issues[0]?.message ?? 'Invalid');
        }
        const res = await api.patch(`/institutions/departments/${department.id}`, payload);
        return res.data;
      }
      const payload: Record<string, unknown> = {
        school_id: schoolId,
        name: values.name.trim(),
      };
      if (values.short_name.trim()) payload['short_name'] = values.short_name.trim();
      const parsed = CreateDepartmentRequest.safeParse(payload);
      if (!parsed.success) {
        throw new Error(parsed.error.issues[0]?.message ?? 'Invalid');
      }
      const res = await api.post(
        `/institutions/schools/${schoolId}/departments`,
        payload,
      );
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'Department updated.' : 'Department added.', {
        variant: 'success',
      });
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
      } else if (err instanceof Error) {
        enqueueSnackbar(err.message, { variant: 'error' });
      }
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      await mut.mutateAsync(values);
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
      title={isEdit ? 'Edit department' : 'New department'}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Add department',
        loadingLabel: 'Saving…',
        loading: submitting,
        formId: 'department-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="department-form"
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
              label="Name"
              required
              error={Boolean(errors.name)}
              helperText={errors.name?.message ?? ''}
              htmlFor="dep-name"
            >
              <TextField
                id="dep-name"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. Department of Software Engineering"
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
              htmlFor="dep-short_name"
            >
              <TextField
                id="dep-short_name"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. SE"
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
