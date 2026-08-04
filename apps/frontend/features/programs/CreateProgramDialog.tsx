// Refactored to SVT form-pattern per design pass.
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, Controller } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Autocomplete,
  Box,
  MenuItem,
  TextField,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import SchoolOutlinedIcon from '@mui/icons-material/SchoolOutlined';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import EventRepeatOutlinedIcon from '@mui/icons-material/EventRepeatOutlined';
import { CreateProgramRequest } from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';
import { useSaveBlockedReason } from '@/components/useSaveBlockedReason';
import {
  ACADEMIC_LEVELS,
  DELIVERY_MODES,
  DURATION_PATTERNS,
  DURATION_PATTERN_TERMS_PER_YEAR,
  type AcademicLevel,
  type DeliveryMode,
  type DurationPattern,
} from './types';

const FORM_BOX_SX = {
  '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
  '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
  '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
  '& .MuiAutocomplete-root .MuiOutlinedInput-root': { paddingTop: '0 !important', paddingBottom: '0 !important' },
  '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': { padding: '0 6px !important' },
} as const;

type InstitutionOption = {
  id: string;
  display_name: string;
  country_code: string;
};

type FormValues = {
  institution_id: string;
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
  duration_pattern: DurationPattern | '';
  terms_per_year: string;
};

const empty = (): FormValues => ({
  institution_id: '',
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
  duration_pattern: '',
  terms_per_year: '',
});

function buildPayload(v: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    institution_id: v.institution_id,
    name: v.name.trim(),
    level: v.level,
    delivery_mode: v.delivery_mode,
    language_of_instruction: v.language_of_instruction.trim() || 'en',
    duration_months: Number(v.duration_months),
  };
  if (v.code.trim()) out['code'] = v.code.trim();
  if (v.short_name.trim()) out['short_name'] = v.short_name.trim();
  if (v.field_of_study.trim()) out['field_of_study'] = v.field_of_study.trim();
  if (v.isced_code.trim()) out['isced_code'] = v.isced_code.trim();
  if (v.credit_hours.trim()) out['credit_hours'] = Number(v.credit_hours);
  if (v.description.trim()) out['description'] = v.description.trim();
  if (v.url.trim()) out['url'] = v.url.trim();
  if (v.duration_pattern) out['duration_pattern'] = v.duration_pattern;
  if (v.terms_per_year.trim()) out['terms_per_year'] = Number(v.terms_per_year);
  return out;
}

export type CreateProgramDialogProps = {
  open: boolean;
  defaultInstitutionId?: string | undefined;
  onClose: () => void;
};

export default function CreateProgramDialog({
  open,
  defaultInstitutionId,
  onClose,
}: CreateProgramDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const institutionsQ = useQuery({
    queryKey: ['institutions', 'list', { limit: '100' }],
    queryFn: async () => {
      const res = await api.get<{ data: InstitutionOption[] }>('/institutions', {
        params: { limit: 100 },
      });
      return res.data.data;
    },
    staleTime: 60_000,
  });

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

  // Auto-fill terms_per_year from the cadence lookup, but only if the user
  // hasn't already typed something in. Never overwrite an existing value.
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

  useEffect(() => {
    if (open) {
      reset({ ...empty(), institution_id: defaultInstitutionId ?? '' });
    }
  }, [open, defaultInstitutionId, reset]);

  const mut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await api.post('/programs', payload);
      return res.data as { id: string };
    },
    onSuccess: (created) => {
      enqueueSnackbar('Program created.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['programs'] });
      onClose();
      router.push(`/programs/${created.id}`);
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
      const parsed = CreateProgramRequest.safeParse(payload);
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
      title="New course"
      subtitle="Add a course offered by an institution. You can add intakes, fees and modules from the detail page."
      maxWidth="md"
      primaryAction={{
        label: 'Create course',
        loadingLabel: 'Creating…',
        loading: submitting,
        formId: 'create-program-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="create-program-form"
        onSubmit={onSubmit}
        noValidate
        sx={FORM_BOX_SX}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>

        {/* --- Identity ---------------------------------------------- */}
        <FormSection
          title="Course identity"
          subtitle="Institution, names and academic level"
          icon={<SchoolOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12}>
              <LabeledField
                label="Institution"
                required
                error={Boolean(errors.institution_id)}
                helperText={errors.institution_id?.message ?? ''}
                htmlFor="cp-institution"
              >
                <Controller
                  name="institution_id"
                  control={control}
                  rules={{ required: 'Required' }}
                  render={({ field }) => {
                    const selected =
                      (institutionsQ.data ?? []).find((i) => i.id === field.value) ?? null;
                    return (
                      <Autocomplete<InstitutionOption>
                        options={institutionsQ.data ?? []}
                        loading={institutionsQ.isLoading}
                        value={selected}
                        onChange={(_, v) => field.onChange(v?.id ?? '')}
                        getOptionLabel={(o) => `${o.display_name} (${o.country_code})`}
                        isOptionEqualToValue={(a, b) => a.id === b.id}
                        fullWidth
                        size="medium"
                        renderInput={(p) => (
                          <TextField
                            {...p}
                            id="cp-institution"
                            hiddenLabel
                            placeholder="Search by display name"
                            error={Boolean(errors.institution_id)}
                          />
                        )}
                      />
                    );
                  }}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Name"
                required
                error={Boolean(errors.name)}
                helperText={errors.name?.message ?? ''}
                htmlFor="cp-name"
              >
                <TextField
                  id="cp-name"
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
                htmlFor="cp-short_name"
              >
                <TextField
                  id="cp-short_name"
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
                htmlFor="cp-code"
              >
                <TextField
                  id="cp-code"
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
                htmlFor="cp-level"
              >
                <Controller
                  name="level"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      id="cp-level"
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
                htmlFor="cp-delivery"
              >
                <Controller
                  name="delivery_mode"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      id="cp-delivery"
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
          </Grid>
        </FormSection>

        {/* --- Curriculum -------------------------------------------- */}
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
                htmlFor="cp-field_of_study"
              >
                <TextField
                  id="cp-field_of_study"
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
                htmlFor="cp-isced_code"
              >
                <TextField
                  id="cp-isced_code"
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
                error={Boolean(errors.language_of_instruction)}
                helperText={errors.language_of_instruction?.message ?? 'ISO 639-1, e.g. en'}
                htmlFor="cp-language"
              >
                <TextField
                  id="cp-language"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="en"
                  error={Boolean(errors.language_of_instruction)}
                  {...register('language_of_instruction')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <LabeledField
                label="Duration (months)"
                required
                error={Boolean(errors.duration_months)}
                helperText={errors.duration_months?.message ?? ''}
                htmlFor="cp-duration_months"
              >
                <TextField
                  id="cp-duration_months"
                  type="number"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. 36"
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
                htmlFor="cp-credit_hours"
              >
                <TextField
                  id="cp-credit_hours"
                  type="number"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. 360"
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
                htmlFor="cp-url"
              >
                <TextField
                  id="cp-url"
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
                htmlFor="cp-description"
              >
                <TextField
                  id="cp-description"
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

        {/* --- Cadence ----------------------------------------------- */}
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
                htmlFor="cp-duration_pattern"
              >
                <Controller
                  name="duration_pattern"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      id="cp-duration_pattern"
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
                htmlFor="cp-terms_per_year"
              >
                <TextField
                  id="cp-terms_per_year"
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
    </AppDialog>
  );
}
