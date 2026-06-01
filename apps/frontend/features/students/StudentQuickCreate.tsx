// Refactored to SVT form-pattern (LabeledField + FormSection compact) per design pass.
'use client';

import { useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
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
import PersonOutlineOutlinedIcon from '@mui/icons-material/PersonOutlineOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import ContactMailOutlinedIcon from '@mui/icons-material/ContactMailOutlined';
import TimelineOutlinedIcon from '@mui/icons-material/TimelineOutlined';
import { z } from 'zod';
import { CreateStudentRequest } from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import PhoneField from '@/components/PhoneField';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';

// Strip empty strings off optional fields BEFORE zod validates so users aren't
// shown spurious "invalid email" / "invalid phone" errors for blank optional inputs.
const FormPreprocess = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null) return value;
  const obj = { ...(value as Record<string, unknown>) };
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'string' && (obj[k] as string).trim() === '') {
      delete obj[k];
    }
  }
  return obj;
}, CreateStudentRequest);

type StageOption = {
  id: string;
  key: string;
  label: string;
  sequence: number;
  is_initial?: boolean;
};

type Country = {
  code_alpha2: string;
  name: string;
  dial_code?: string | null;
};

type FormValues = {
  given_name: string;
  family_name: string;
  name_in_passport: string;
  date_of_birth: string;
  gender: 'NOT_KNOWN' | 'MALE' | 'FEMALE' | 'NOT_APPLICABLE';
  nationality_code: string;
  primary_language: string;
  email_primary?: string;
  phone_primary_e164?: string;
  current_stage_id?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  stages: StageOption[];
};

const GENDER_OPTIONS = [
  { value: 'NOT_KNOWN', label: 'Prefer not to say' },
  { value: 'MALE', label: 'Male' },
  { value: 'FEMALE', label: 'Female' },
  { value: 'NOT_APPLICABLE', label: 'Not applicable' },
];

const FormSchema = FormPreprocess;

export default function StudentQuickCreate({ open, onClose, stages }: Props) {
  const router = useRouter();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const initialStage = useMemo(
    () => stages.find((s) => s.is_initial) ?? stages[0],
    [stages],
  );

  const countriesQuery = useQuery({
    queryKey: ['lookups', 'countries'],
    queryFn: async (): Promise<Country[]> => {
      const res = await api.get<{ data: Country[] }>('/lookups/countries');
      return res.data.data;
    },
    staleTime: 60 * 60_000,
    enabled: open,
  });

  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    mode: 'onBlur',
    defaultValues: {
      given_name: '',
      family_name: '',
      name_in_passport: '',
      date_of_birth: '',
      gender: 'NOT_KNOWN',
      nationality_code: '',
      primary_language: 'en',
      email_primary: '',
      phone_primary_e164: '',
      current_stage_id: undefined,
    },
  });

  // When the modal opens, reset to a clean form. We only run this on the open
  // transition (NOT when initialStage resolves later) so we don't clobber the
  // user's typing if stages load mid-session.
  useEffect(() => {
    if (open) {
      reset({
        given_name: '',
        family_name: '',
        name_in_passport: '',
        date_of_birth: '',
        gender: 'NOT_KNOWN',
        nationality_code: '',
        primary_language: 'en',
        email_primary: '',
        phone_primary_e164: '',
        current_stage_id: initialStage?.id,
      });
    }
    // Run only on the open transition; including `initialStage`/`reset` would
    // clobber the user's in-progress typing if stages resolve mid-session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const nationalityCode = watch('nationality_code');
  const phoneCountry = (nationalityCode || 'np').toLowerCase();

  const createMutation = useMutation<{ id: string }, ApiError, FormValues>({
    mutationFn: async (values) => {
      // Strip empty optional strings so zod-server doesn't reject them.
      const payload: Record<string, unknown> = { ...values };
      for (const k of Object.keys(payload)) {
        if (payload[k] === '' || payload[k] === undefined) delete payload[k];
      }
      const res = await api.post<{ id: string }>('/students', payload);
      return res.data;
    },
    onSuccess: (created) => {
      enqueueSnackbar('Student created', { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['students'] });
      onClose();
      router.push(`/students/${created.id}`);
    },
    onError: (err) => {
      // Map field errors back to the form
      for (const fe of err.errors ?? []) {
        const path = fe.path.split('.').pop() as keyof FormValues;
        if (
          path === 'given_name' ||
          path === 'family_name' ||
          path === 'name_in_passport' ||
          path === 'date_of_birth' ||
          path === 'gender' ||
          path === 'nationality_code' ||
          path === 'email_primary' ||
          path === 'phone_primary_e164' ||
          path === 'primary_language' ||
          path === 'current_stage_id'
        ) {
          setError(path, { type: 'server', message: fe.message });
        }
      }
      enqueueSnackbar(err.detail || err.title || 'Could not create student', {
        variant: 'error',
      });
    },
  });

  const onSubmit = handleSubmit((values) => {
    createMutation.mutate(values);
  });

  const topLevelError =
    createMutation.isError && createMutation.error && !createMutation.error.errors?.length
      ? createMutation.error.detail || createMutation.error.title || null
      : null;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Add a student"
      subtitle="Capture the minimum-viable record. You can enrich the rest from the detail page."
      maxWidth="md"
      errorText={topLevelError}
      primaryAction={{
        label: 'Create student',
        loadingLabel: 'Creating…',
        loading: isSubmitting || createMutation.isPending,
        disabled: !isDirty || isSubmitting || createMutation.isPending,
        formId: 'student-quick-create-form',
      }}
    >
      <Box
        component="form"
        id="student-quick-create-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& .react-international-phone-input-container .react-international-phone-input': { height: 44 },
          '& .react-international-phone-input-container .react-international-phone-country-selector-button': { height: 44 },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root': { paddingTop: '0 !important', paddingBottom: '0 !important' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': { padding: '0 6px !important' },
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>

        <FormSection
          title="Identity"
          subtitle="Legal name and passport details"
          icon={<PersonOutlineOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Given name"
                required
                error={Boolean(errors.given_name)}
                helperText={errors.given_name?.message ?? ''}
                htmlFor="qc-given_name"
              >
                <TextField
                  id="qc-given_name"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Maya"
                  error={Boolean(errors.given_name)}
                  {...register('given_name')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Family name"
                required
                error={Boolean(errors.family_name)}
                helperText={errors.family_name?.message ?? ''}
                htmlFor="qc-family_name"
              >
                <TextField
                  id="qc-family_name"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Sharma"
                  error={Boolean(errors.family_name)}
                  {...register('family_name')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12}>
              <LabeledField
                label="Name in passport"
                required
                encrypted
                error={Boolean(errors.name_in_passport)}
                helperText={
                  errors.name_in_passport?.message ?? 'Enter exactly as printed in the passport.'
                }
                htmlFor="qc-name_in_passport"
              >
                <TextField
                  id="qc-name_in_passport"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="MAYA SHARMA"
                  error={Boolean(errors.name_in_passport)}
                  {...register('name_in_passport')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Demographics"
          subtitle="Date of birth, nationality and language"
          icon={<PublicOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Date of birth"
                required
                error={Boolean(errors.date_of_birth)}
                helperText={errors.date_of_birth?.message ?? ''}
                htmlFor="qc-dob"
              >
                <TextField
                  id="qc-dob"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.date_of_birth)}
                  {...register('date_of_birth')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Gender"
                required
                error={Boolean(errors.gender)}
                helperText={errors.gender?.message ?? ''}
                htmlFor="qc-gender"
              >
                <Controller
                  name="gender"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="qc-gender"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.gender)}
                      {...field}
                    >
                      {GENDER_OPTIONS.map((g) => (
                        <MenuItem key={g.value} value={g.value}>
                          {g.label}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Nationality"
                required
                error={Boolean(errors.nationality_code)}
                helperText={errors.nationality_code?.message ?? ''}
                htmlFor="qc-nat"
              >
                <Controller
                  name="nationality_code"
                  control={control}
                  render={({ field }) => {
                    const options = countriesQuery.data ?? [];
                    const selected = options.find((c) => c.code_alpha2 === field.value) ?? null;
                    return (
                      <Autocomplete
                        options={options}
                        loading={countriesQuery.isLoading}
                        value={selected}
                        onChange={(_, v) => field.onChange(v?.code_alpha2 ?? '')}
                        getOptionLabel={(o) => `${o.name} (${o.code_alpha2})`}
                        isOptionEqualToValue={(a, b) => a.code_alpha2 === b.code_alpha2}
                        fullWidth
                        size="medium"
                        renderInput={(params) => (
                          <TextField
                            {...params}
                            id="qc-nat"
                            hiddenLabel
                            placeholder="Select country"
                            error={Boolean(errors.nationality_code)}
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
                label="Primary language"
                required
                error={Boolean(errors.primary_language)}
                helperText={errors.primary_language?.message ?? 'ISO 639-1 (e.g. en, ne, hi)'}
                htmlFor="qc-lang"
              >
                <TextField
                  id="qc-lang"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="en"
                  inputProps={{ maxLength: 2 }}
                  error={Boolean(errors.primary_language)}
                  {...register('primary_language')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Contact"
          subtitle="Email and phone (optional at create time)"
          icon={<ContactMailOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Primary email"
                error={Boolean(errors.email_primary)}
                helperText={errors.email_primary?.message ?? ''}
                htmlFor="qc-email"
              >
                <TextField
                  id="qc-email"
                  type="email"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="name@example.com"
                  error={Boolean(errors.email_primary)}
                  {...register('email_primary')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Primary phone"
                error={Boolean(errors.phone_primary_e164)}
                helperText={errors.phone_primary_e164?.message ?? 'E.164 format with country code.'}
              >
                <Controller
                  name="phone_primary_e164"
                  control={control}
                  render={({ field }) => (
                    <PhoneField
                      label=""
                      fullWidth
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      defaultCountry={phoneCountry}
                      error={Boolean(errors.phone_primary_e164)}
                    />
                  )}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Workflow"
          subtitle="Initial pipeline stage"
          icon={<TimelineOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <LabeledField
            label="Initial stage"
            error={Boolean(errors.current_stage_id)}
            helperText={
              errors.current_stage_id?.message ?? 'Defaults to the seeded initial stage.'
            }
            htmlFor="qc-stage"
          >
            <Controller
              name="current_stage_id"
              control={control}
              render={({ field }) => (
                <TextField
                  id="qc-stage"
                  select
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.current_stage_id)}
                  value={field.value ?? ''}
                  onChange={field.onChange}
                >
                  {stages.map((s) => (
                    <MenuItem key={s.id} value={s.id}>
                      {s.label}
                      {s.is_initial ? ' (initial)' : ''}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
        </FormSection>
      </Box>
    </AppDialog>
  );
}
