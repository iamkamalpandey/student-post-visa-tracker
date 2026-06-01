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
import SchoolOutlinedIcon from '@mui/icons-material/SchoolOutlined';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import EventRepeatOutlinedIcon from '@mui/icons-material/EventRepeatOutlined';
import { UpdateProgramRequest } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';
import { useSaveBlockedReason } from '@/components/useSaveBlockedReason';
import { api, ApiError } from '@/lib/api';
import {
  ACADEMIC_LEVELS,
  DELIVERY_MODES,
  DURATION_PATTERNS,
  DURATION_PATTERN_TERMS_PER_YEAR,
  type AcademicLevel,
  type DeliveryMode,
  type DurationPattern,
  type ProgramRow,
} from './types';

const FORM_BOX_SX = {
  '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
  '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
  '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
} as const;

type FormValues = {
  code: string;
  name: string;
  short_name: string;
  level: AcademicLevel;
  field_of_study: string;
  isced_code: string;
  delivery_mode: DeliveryMode;
  language_of_instruction: string;
  duration_months: string;
  credit_hours: string;
  description: string;
  url: string;
  is_active: boolean;
  duration_pattern: DurationPattern | '';
  terms_per_year: string;
};

function fromProgram(p: ProgramRow): FormValues {
  return {
    code: p.code ?? '',
    name: p.name,
    short_name: p.short_name ?? '',
    level: p.level,
    field_of_study: p.field_of_study ?? '',
    isced_code: p.isced_code ?? '',
    delivery_mode: p.delivery_mode,
    language_of_instruction: p.language_of_instruction,
    duration_months: String(p.duration_months),
    credit_hours: p.credit_hours != null ? String(p.credit_hours) : '',
    description: p.description ?? '',
    url: p.url ?? '',
    is_active: p.is_active,
    duration_pattern: p.duration_pattern ?? '',
    terms_per_year: p.terms_per_year != null ? String(p.terms_per_year) : '',
  };
}

const empty = (): FormValues => ({
  code: '',
  name: '',
  short_name: '',
  level: 'BACHELORS',
  field_of_study: '',
  isced_code: '',
  delivery_mode: 'IN_PERSON',
  language_of_instruction: 'en',
  duration_months: '',
  credit_hours: '',
  description: '',
  url: '',
  is_active: true,
  duration_pattern: '',
  terms_per_year: '',
});

function buildDiff(initial: FormValues, current: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const optionalStrings: (keyof FormValues)[] = [
    'code',
    'short_name',
    'field_of_study',
    'isced_code',
    'description',
    'url',
  ];
  const requiredStrings: (keyof FormValues)[] = ['name', 'language_of_instruction'];
  for (const k of optionalStrings) {
    if (initial[k] !== current[k]) {
      const v = (current[k] as string).trim();
      out[k] = v === '' ? undefined : v;
    }
  }
  for (const k of requiredStrings) {
    if (initial[k] !== current[k]) {
      out[k] = (current[k] as string).trim();
    }
  }
  if (initial.level !== current.level) out['level'] = current.level;
  if (initial.delivery_mode !== current.delivery_mode) {
    out['delivery_mode'] = current.delivery_mode;
  }
  if (initial.duration_months !== current.duration_months) {
    out['duration_months'] = Number(current.duration_months);
  }
  if (initial.credit_hours !== current.credit_hours) {
    const v = current.credit_hours.trim();
    out['credit_hours'] = v === '' ? undefined : Number(v);
  }
  if (initial.is_active !== current.is_active) out['is_active'] = current.is_active;
  if (initial.duration_pattern !== current.duration_pattern) {
    out['duration_pattern'] = current.duration_pattern || undefined;
  }
  if (initial.terms_per_year !== current.terms_per_year) {
    const v = current.terms_per_year.trim();
    out['terms_per_year'] = v === '' ? undefined : Number(v);
  }
  return out;
}

export type EditProgramDialogProps = {
  open: boolean;
  program: ProgramRow | null;
  onClose: () => void;
};

export default function EditProgramDialog({ open, program, onClose }: EditProgramDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [initial, setInitial] = useState<FormValues | null>(null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    setValue,
    watch,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: empty() });

  useEffect(() => {
    if (open && program) {
      const v = fromProgram(program);
      reset(v);
      setInitial(v);
    }
  }, [open, program, reset]);

  // Auto-fill terms_per_year when the cadence pattern changes — but only if
  // the user hasn't already entered something. Never clobber an existing value.
  const watchedPattern = watch('duration_pattern');
  useEffect(() => {
    if (!watchedPattern) return;
    const current = watch('terms_per_year');
    if (current && current.trim() !== '') return;
    const suggested = DURATION_PATTERN_TERMS_PER_YEAR[watchedPattern];
    if (suggested != null) {
      setValue('terms_per_year', String(suggested), { shouldDirty: true });
    }
    // Fires only when the cadence pattern changes; `watch`/`setValue` are
    // stable RHF references and including them adds noise without changing behaviour.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchedPattern]);

  const mut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (!program) throw new Error('No program');
      const res = await api.patch(`/programs/${program.id}`, payload, {
        headers: { 'If-Match': `"${program.version}"` },
      });
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Program updated.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['programs'] });
      void qc.invalidateQueries({ queryKey: ['programs', 'detail', program?.id] });
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (initial && fe.path in (initial as object)) {
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
    if (!initial) return;
    setSubmitting(true);
    try {
      const payload = buildDiff(initial, values);
      if (Object.keys(payload).length === 0) {
        onClose();
        return;
      }
      const parsed = UpdateProgramRequest.safeParse(payload);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const path = issue.path[0]?.toString();
          if (path && initial && path in (initial as object)) {
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

  const { disabled: saveBlockedFromForm, reason: saveBlockedReason } = useSaveBlockedReason({
    isDirty,
    isSubmitting,
    submitting: submitting || mut.isPending,
  });
  const saveDisabled = !program || saveBlockedFromForm;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Edit program"
      maxWidth="md"
      primaryAction={{
        label: 'Save changes',
        loadingLabel: 'Saving…',
        loading: submitting,
        formId: 'edit-program-form',
        disabled: saveDisabled,
      }}
    >
      {program ? (
        <Box
          component="form"
          id="edit-program-form"
          onSubmit={onSubmit}
          noValidate
          sx={FORM_BOX_SX}
        >
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
            <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
            Required
          </Typography>

          {/* --- Identity ------------------------------------------- */}
          <FormSection
            title="Program identity"
            subtitle="Names, code and academic level"
            icon={<SchoolOutlinedIcon />}
            iconColor="muted"
            compact
          >
            <Grid container spacing={2.5}>
              <Grid item xs={12} sm={6}>
                <LabeledField
                  label="Name"
                  required
                  error={Boolean(errors.name)}
                  helperText={errors.name?.message ?? ''}
                  htmlFor="ep-name"
                >
                  <TextField
                    id="ep-name"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="e.g. BSc (Hons) Computer Science"
                    error={Boolean(errors.name)}
                    {...register('name', { required: 'Required' })}
                  />
                </LabeledField>
              </Grid>
              <Grid item xs={12} sm={6}>
                <LabeledField
                  label="Short name"
                  error={Boolean(errors.short_name)}
                  helperText={errors.short_name?.message ?? ''}
                  htmlFor="ep-short_name"
                >
                  <TextField
                    id="ep-short_name"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="e.g. BSc CS"
                    error={Boolean(errors.short_name)}
                    {...register('short_name')}
                  />
                </LabeledField>
              </Grid>
              <Grid item xs={12} sm={4}>
                <LabeledField
                  label="Code"
                  error={Boolean(errors.code)}
                  helperText={errors.code?.message ?? ''}
                  htmlFor="ep-code"
                >
                  <TextField
                    id="ep-code"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="e.g. CS-BSC-01"
                    error={Boolean(errors.code)}
                    {...register('code')}
                  />
                </LabeledField>
              </Grid>
              <Grid item xs={12} sm={4}>
                <LabeledField
                  label="Level"
                  required
                  error={Boolean(errors.level)}
                  helperText={errors.level?.message ?? ''}
                  htmlFor="ep-level"
                >
                  <Controller
                    name="level"
                    control={control}
                    render={({ field }) => (
                      <TextField
                        {...field}
                        id="ep-level"
                        select
                        fullWidth
                        size="medium"
                        hiddenLabel
                        error={Boolean(errors.level)}
                      >
                        {ACADEMIC_LEVELS.map((l) => (
                          <MenuItem key={l.value} value={l.value}>
                            {l.label}
                          </MenuItem>
                        ))}
                      </TextField>
                    )}
                  />
                </LabeledField>
              </Grid>
              <Grid item xs={12} sm={4}>
                <LabeledField
                  label="Delivery"
                  error={Boolean(errors.delivery_mode)}
                  helperText={errors.delivery_mode?.message ?? ''}
                  htmlFor="ep-delivery"
                >
                  <Controller
                    name="delivery_mode"
                    control={control}
                    render={({ field }) => (
                      <TextField
                        {...field}
                        id="ep-delivery"
                        select
                        fullWidth
                        size="medium"
                        hiddenLabel
                        error={Boolean(errors.delivery_mode)}
                      >
                        {DELIVERY_MODES.map((d) => (
                          <MenuItem key={d.value} value={d.value}>
                            {d.label}
                          </MenuItem>
                        ))}
                      </TextField>
                    )}
                  />
                </LabeledField>
              </Grid>
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
            </Grid>
          </FormSection>

          {/* --- Curriculum ----------------------------------------- */}
          <FormSection
            title="Curriculum"
            subtitle="Field of study, language and duration"
            icon={<MenuBookOutlinedIcon />}
            iconColor="muted"
            compact
          >
            <Grid container spacing={2.5}>
              <Grid item xs={12} sm={4}>
                <LabeledField
                  label="Field of study"
                  error={Boolean(errors.field_of_study)}
                  helperText={errors.field_of_study?.message ?? ''}
                  htmlFor="ep-field_of_study"
                >
                  <TextField
                    id="ep-field_of_study"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="e.g. Computer Science"
                    error={Boolean(errors.field_of_study)}
                    {...register('field_of_study')}
                  />
                </LabeledField>
              </Grid>
              <Grid item xs={12} sm={4}>
                <LabeledField
                  label="ISCED-F code"
                  error={Boolean(errors.isced_code)}
                  helperText={errors.isced_code?.message ?? ''}
                  htmlFor="ep-isced_code"
                >
                  <TextField
                    id="ep-isced_code"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="0612"
                    error={Boolean(errors.isced_code)}
                    {...register('isced_code')}
                  />
                </LabeledField>
              </Grid>
              <Grid item xs={12} sm={4}>
                <LabeledField
                  label="Language"
                  required
                  error={Boolean(errors.language_of_instruction)}
                  helperText={errors.language_of_instruction?.message ?? 'ISO 639-1, e.g. en'}
                  htmlFor="ep-language"
                >
                  <TextField
                    id="ep-language"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="en"
                    error={Boolean(errors.language_of_instruction)}
                    {...register('language_of_instruction', { required: 'Required' })}
                  />
                </LabeledField>
              </Grid>
              <Grid item xs={12} sm={4}>
                <LabeledField
                  label="Duration (months)"
                  required
                  error={Boolean(errors.duration_months)}
                  helperText={errors.duration_months?.message ?? ''}
                  htmlFor="ep-duration_months"
                >
                  <TextField
                    id="ep-duration_months"
                    type="number"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="36"
                    error={Boolean(errors.duration_months)}
                    {...register('duration_months', { required: 'Required' })}
                  />
                </LabeledField>
              </Grid>
              <Grid item xs={12} sm={4}>
                <LabeledField
                  label="Credit hours"
                  error={Boolean(errors.credit_hours)}
                  helperText={errors.credit_hours?.message ?? ''}
                  htmlFor="ep-credit_hours"
                >
                  <TextField
                    id="ep-credit_hours"
                    type="number"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="360"
                    error={Boolean(errors.credit_hours)}
                    {...register('credit_hours')}
                  />
                </LabeledField>
              </Grid>
              <Grid item xs={12} sm={4}>
                <LabeledField
                  label="URL"
                  error={Boolean(errors.url)}
                  helperText={errors.url?.message ?? ''}
                  htmlFor="ep-url"
                >
                  <TextField
                    id="ep-url"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="https://www.manchester.ac.uk/study/undergraduate/courses/2026/00123/"
                    error={Boolean(errors.url)}
                    {...register('url')}
                  />
                </LabeledField>
              </Grid>
              <Grid item xs={12}>
                <LabeledField
                  label="Description"
                  error={Boolean(errors.description)}
                  helperText={errors.description?.message ?? ''}
                  htmlFor="ep-description"
                >
                  <TextField
                    id="ep-description"
                    fullWidth
                    hiddenLabel
                    multiline
                    minRows={2}
                    placeholder="Short summary shown on the program profile"
                    error={Boolean(errors.description)}
                    {...register('description')}
                  />
                </LabeledField>
              </Grid>
            </Grid>
          </FormSection>

          {/* --- Cadence -------------------------------------------- */}
          <FormSection
            title="Cadence"
            subtitle="How the academic year is structured"
            icon={<EventRepeatOutlinedIcon />}
            iconColor="muted"
            compact
          >
            <Grid container spacing={2.5}>
              <Grid item xs={12} sm={6}>
                <LabeledField
                  label="Duration pattern"
                  error={Boolean(errors.duration_pattern)}
                  helperText={
                    errors.duration_pattern?.message ??
                    'How is the year structured? Drives intake-label suggestions.'
                  }
                  htmlFor="ep-duration_pattern"
                >
                  <Controller
                    name="duration_pattern"
                    control={control}
                    render={({ field }) => (
                      <TextField
                        {...field}
                        id="ep-duration_pattern"
                        select
                        fullWidth
                        size="medium"
                        hiddenLabel
                        error={Boolean(errors.duration_pattern)}
                      >
                        <MenuItem value="">
                          <em>Unspecified</em>
                        </MenuItem>
                        {DURATION_PATTERNS.map((d) => (
                          <MenuItem key={d.value} value={d.value}>
                            {d.label}
                          </MenuItem>
                        ))}
                      </TextField>
                    )}
                  />
                </LabeledField>
              </Grid>
              <Grid item xs={12} sm={6}>
                <LabeledField
                  label="Terms per year"
                  error={Boolean(errors.terms_per_year)}
                  helperText={
                    errors.terms_per_year?.message ??
                    (watchedPattern
                      ? `Derived from "${DURATION_PATTERNS.find((p) => p.value === watchedPattern)?.label ?? watchedPattern}". Override if needed.`
                      : 'Pick a duration pattern to auto-fill, or set manually.')
                  }
                  htmlFor="ep-terms_per_year"
                >
                  <TextField
                    id="ep-terms_per_year"
                    type="number"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    inputProps={{ min: 1, max: 12 }}
                    placeholder="2"
                    error={Boolean(errors.terms_per_year)}
                    {...register('terms_per_year')}
                  />
                </LabeledField>
              </Grid>
            </Grid>
          </FormSection>

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
      ) : null}
    </AppDialog>
  );
}
