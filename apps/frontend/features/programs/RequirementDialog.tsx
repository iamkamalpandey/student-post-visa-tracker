// Refactored to SVT form-pattern per design pass.
'use client';

import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  FormControlLabel,
  MenuItem,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import {
  CreateProgramRequirementRequest,
  UpdateProgramRequirementRequest,
} from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { useSaveBlockedReason } from '@/components/useSaveBlockedReason';
import { api, ApiError } from '@/lib/api';
import {
  REQUIREMENT_CATEGORIES,
  type ProgramRequirementRow,
  type RequirementCategory,
} from './types';

const FORM_BOX_SX = {
  '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
  '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
} as const;

type FormValues = {
  category: RequirementCategory;
  label: string;
  details: string;
  min_value: string;
  unit: string;
  is_mandatory: boolean;
};

const empty = (): FormValues => ({
  category: 'LANGUAGE',
  label: '',
  details: '',
  min_value: '',
  unit: '',
  is_mandatory: true,
});

function fromRequirement(r: ProgramRequirementRow): FormValues {
  return {
    category: r.category,
    label: r.label,
    details: r.details ?? '',
    min_value: r.min_value ?? '',
    unit: r.unit ?? '',
    is_mandatory: r.is_mandatory,
  };
}

function buildPayload(v: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    category: v.category,
    label: v.label.trim(),
    is_mandatory: v.is_mandatory,
  };
  if (v.details.trim()) out['details'] = v.details.trim();
  if (v.min_value.trim()) out['min_value'] = v.min_value.trim();
  if (v.unit.trim()) out['unit'] = v.unit.trim();
  return out;
}

export type RequirementDialogProps = {
  open: boolean;
  programId: string;
  requirement: ProgramRequirementRow | null;
  onClose: () => void;
};

export default function RequirementDialog({
  open,
  programId,
  requirement,
  onClose,
}: RequirementDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const isEdit = Boolean(requirement);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: empty() });

  useEffect(() => {
    if (open) reset(requirement ? fromRequirement(requirement) : empty());
  }, [open, requirement, reset]);

  const mut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (requirement) {
        const res = await api.patch(`/programs/requirements/${requirement.id}`, payload);
        return res.data;
      }
      const res = await api.post(`/programs/${programId}/requirements`, payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'Requirement updated.' : 'Requirement added.', {
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['programs', 'detail', programId] });
      void qc.invalidateQueries({
        queryKey: ['programs', programId, 'requirements'],
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
      const schema = isEdit
        ? UpdateProgramRequirementRequest
        : CreateProgramRequirementRequest;
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
      title={isEdit ? 'Edit requirement' : 'New requirement'}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Add requirement',
        loadingLabel: 'Saving…',
        loading: submitting,
        formId: 'requirement-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="requirement-form"
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
              label="Category"
              required
              error={Boolean(errors.category)}
              helperText={errors.category?.message ?? ''}
              htmlFor="rq-category"
            >
              <Controller
                name="category"
                control={control}
                render={({ field }) => (
                  <TextField
                    {...field}
                    id="rq-category"
                    select
                    fullWidth
                    size="medium"
                    hiddenLabel
                    error={Boolean(errors.category)}
                  >
                    {REQUIREMENT_CATEGORIES.map((c) => (
                      <MenuItem key={c.value} value={c.value}>
                        {c.label}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField label="Required?">
              <Controller
                name="is_mandatory"
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
                    label={field.value ? 'Mandatory' : 'Optional'}
                  />
                )}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12}>
            <LabeledField
              label="Label"
              required
              error={Boolean(errors.label)}
              helperText={errors.label?.message ?? ''}
              htmlFor="rq-label"
            >
              <TextField
                id="rq-label"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. IELTS overall"
                error={Boolean(errors.label)}
                {...register('label', { required: 'Required' })}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Min value"
              error={Boolean(errors.min_value)}
              helperText={errors.min_value?.message ?? ''}
              htmlFor="rq-min_value"
            >
              <TextField
                id="rq-min_value"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="6.5"
                error={Boolean(errors.min_value)}
                {...register('min_value')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Unit"
              error={Boolean(errors.unit)}
              helperText={errors.unit?.message ?? ''}
              htmlFor="rq-unit"
            >
              <TextField
                id="rq-unit"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="band"
                error={Boolean(errors.unit)}
                {...register('unit')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12}>
            <LabeledField
              label="Details"
              error={Boolean(errors.details)}
              helperText={errors.details?.message ?? 'Sub-band, exemptions, equivalencies.'}
              htmlFor="rq-details"
            >
              <TextField
                id="rq-details"
                fullWidth
                hiddenLabel
                multiline
                minRows={2}
                placeholder="e.g. No band below 6.0, valid within 2 years of intake"
                error={Boolean(errors.details)}
                {...register('details')}
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
