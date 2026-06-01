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
import {
  CreateProgramModuleRequest,
  UpdateProgramModuleRequest,
} from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { useSaveBlockedReason } from '@/components/useSaveBlockedReason';
import { api, ApiError } from '@/lib/api';
import type { ProgramModuleRow } from './types';

const FORM_BOX_SX = {
  '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
  '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
} as const;

type FormValues = {
  code: string;
  title: string;
  credits: string;
  semester: string;
  is_core: boolean;
  description: string;
};

const empty = (): FormValues => ({
  code: '',
  title: '',
  credits: '',
  semester: '',
  is_core: true,
  description: '',
});

function fromModule(m: ProgramModuleRow): FormValues {
  return {
    code: m.code,
    title: m.title,
    credits: m.credits ?? '',
    semester: m.semester != null ? String(m.semester) : '',
    is_core: m.is_core,
    description: m.description ?? '',
  };
}

function buildPayload(v: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    code: v.code.trim(),
    title: v.title.trim(),
    is_core: v.is_core,
  };
  if (v.credits.trim()) out['credits'] = v.credits.trim();
  if (v.semester.trim()) out['semester'] = Number(v.semester);
  if (v.description.trim()) out['description'] = v.description.trim();
  return out;
}

export type ModuleDialogProps = {
  open: boolean;
  programId: string;
  module: ProgramModuleRow | null;
  onClose: () => void;
};

export default function ModuleDialog({
  open,
  programId,
  module,
  onClose,
}: ModuleDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const isEdit = Boolean(module);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: empty() });

  useEffect(() => {
    if (open) reset(module ? fromModule(module) : empty());
  }, [open, module, reset]);

  const mut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (module) {
        const res = await api.patch(`/programs/modules/${module.id}`, payload);
        return res.data;
      }
      const res = await api.post(`/programs/${programId}/modules`, payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'Module updated.' : 'Module added.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['programs', 'detail', programId] });
      void qc.invalidateQueries({ queryKey: ['programs', programId, 'modules'] });
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
      const schema = isEdit ? UpdateProgramModuleRequest : CreateProgramModuleRequest;
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
      title={isEdit ? 'Edit module' : 'New module'}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Add module',
        loadingLabel: 'Saving…',
        loading: submitting,
        formId: 'module-form',
        disabled: saveDisabled,
      }}
    >
      <Box component="form" id="module-form" onSubmit={onSubmit} noValidate sx={FORM_BOX_SX}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Grid container spacing={2.5}>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Code"
              required
              error={Boolean(errors.code)}
              helperText={errors.code?.message ?? ''}
              htmlFor="mod-code"
            >
              <TextField
                id="mod-code"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. CS-101"
                error={Boolean(errors.code)}
                {...register('code', { required: 'Required' })}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Semester"
              error={Boolean(errors.semester)}
              helperText={errors.semester?.message ?? ''}
              htmlFor="mod-semester"
            >
              <TextField
                id="mod-semester"
                type="number"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="1"
                error={Boolean(errors.semester)}
                {...register('semester')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12}>
            <LabeledField
              label="Title"
              required
              error={Boolean(errors.title)}
              helperText={errors.title?.message ?? ''}
              htmlFor="mod-title"
            >
              <TextField
                id="mod-title"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. Introduction to Programming"
                error={Boolean(errors.title)}
                {...register('title', { required: 'Required' })}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Credits"
              error={Boolean(errors.credits)}
              helperText={errors.credits?.message ?? ''}
              htmlFor="mod-credits"
            >
              <TextField
                id="mod-credits"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="20.00"
                error={Boolean(errors.credits)}
                {...register('credits')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField label="Module type">
              <Controller
                name="is_core"
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
                    label={field.value ? 'Core module' : 'Elective'}
                  />
                )}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12}>
            <LabeledField
              label="Description"
              error={Boolean(errors.description)}
              helperText={errors.description?.message ?? ''}
              htmlFor="mod-description"
            >
              <TextField
                id="mod-description"
                fullWidth
                hiddenLabel
                multiline
                minRows={2}
                placeholder="Short summary shown on the module list"
                error={Boolean(errors.description)}
                {...register('description')}
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
