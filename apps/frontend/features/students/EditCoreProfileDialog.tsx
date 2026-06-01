'use client';

import { useEffect, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Divider,
  InputAdornment,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import PersonOutlineOutlinedIcon from '@mui/icons-material/PersonOutlineOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import ContactMailOutlinedIcon from '@mui/icons-material/ContactMailOutlined';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import { z } from 'zod';
import { UpdateStudentRequest } from '@spv/zod-schemas';

import { api, ApiError } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import PhoneField from '@/components/PhoneField';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';
import { useCountries } from '@/lib/queries';

// ---------------------------------------------------------------------------
// Empty-string handling.
// We coerce empty / whitespace-only strings on optional fields to `undefined`
// BEFORE zod validates. This is the same pattern that fixed the LoginRequest
// `mfa_code` regression — a blank optional input must not be treated as
// "the user typed an empty string" because zod's email/regex validators will
// reject the empty value and surface noise like "invalid email" on a field
// the user never touched.
// ---------------------------------------------------------------------------
const FormSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null) return value;
  const obj = { ...(value as Record<string, unknown>) };
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'string' && (obj[k] as string).trim() === '') {
      delete obj[k];
    }
  }
  return obj;
}, UpdateStudentRequest);

// The wire schema covers operational fields (status / assigned_to_id) that
// this dialog deliberately does not edit — those have dedicated controls
// (Advance stage modal, assignment picker, etc.). The form only carries
// the core PII fields.
type FormValues = {
  given_name: string;
  middle_name: string;
  family_name: string;
  preferred_name: string;
  name_in_passport: string;
  date_of_birth: string;
  gender: 'NOT_KNOWN' | 'MALE' | 'FEMALE' | 'NOT_APPLICABLE';
  gender_self_described: string;
  nationality_code: string;
  marital_status: '' | 'SINGLE' | 'MARRIED' | 'CIVIL_PARTNERSHIP' | 'SEPARATED' | 'DIVORCED' | 'WIDOWED' | 'OTHER';
  primary_language: string;
  religion: string;
  ethnicity: string;
  email_primary: string;
  email_secondary: string;
  phone_primary_e164: string;
  phone_secondary_e164: string;
  notes: string;
};

type StudentLike = {
  id: string;
  version: number;
  given_name: string;
  middle_name?: string | null;
  family_name: string;
  preferred_name?: string | null;
  name_in_passport?: string | null;
  date_of_birth: string;
  gender: string;
  gender_self_described?: string | null;
  nationality_code: string;
  marital_status?: string | null;
  primary_language: string;
  religion?: string | null;
  ethnicity?: string | null;
  email_primary?: string | null;
  email_secondary?: string | null;
  phone_primary_e164?: string | null;
  phone_secondary_e164?: string | null;
  notes?: string | null;
};

const GENDER_OPTIONS: { value: FormValues['gender']; label: string }[] = [
  { value: 'NOT_KNOWN', label: 'Prefer not to say' },
  { value: 'MALE', label: 'Male' },
  { value: 'FEMALE', label: 'Female' },
  { value: 'NOT_APPLICABLE', label: 'Not applicable' },
];

const MARITAL_OPTIONS: { value: FormValues['marital_status']; label: string }[] = [
  { value: '', label: '— Not specified —' },
  { value: 'SINGLE', label: 'Single' },
  { value: 'MARRIED', label: 'Married' },
  { value: 'CIVIL_PARTNERSHIP', label: 'Civil partnership' },
  { value: 'SEPARATED', label: 'Separated' },
  { value: 'DIVORCED', label: 'Divorced' },
  { value: 'WIDOWED', label: 'Widowed' },
  { value: 'OTHER', label: 'Other' },
];

// Whitelist of writable PII paths used to map server-side `errors[].path`
// back to RHF setError(). Anything off-list (e.g. status, assigned_to_id) is
// not surfaced inline because the dialog doesn't render those controls.
const WRITABLE_PATHS: Set<keyof FormValues> = new Set([
  'given_name',
  'middle_name',
  'family_name',
  'preferred_name',
  'name_in_passport',
  'date_of_birth',
  'gender',
  'gender_self_described',
  'nationality_code',
  'marital_status',
  'primary_language',
  'religion',
  'ethnicity',
  'email_primary',
  'email_secondary',
  'phone_primary_e164',
  'phone_secondary_e164',
  'notes',
]);

function fromStudent(s: StudentLike): FormValues {
  return {
    given_name: s.given_name ?? '',
    middle_name: s.middle_name ?? '',
    family_name: s.family_name ?? '',
    preferred_name: s.preferred_name ?? '',
    name_in_passport: s.name_in_passport ?? '',
    date_of_birth: s.date_of_birth ? s.date_of_birth.slice(0, 10) : '',
    gender: (s.gender as FormValues['gender']) || 'NOT_KNOWN',
    gender_self_described: s.gender_self_described ?? '',
    nationality_code: s.nationality_code ?? '',
    marital_status: (s.marital_status as FormValues['marital_status']) || '',
    primary_language: s.primary_language || 'en',
    religion: s.religion ?? '',
    ethnicity: s.ethnicity ?? '',
    email_primary: s.email_primary ?? '',
    email_secondary: s.email_secondary ?? '',
    phone_primary_e164: s.phone_primary_e164 ?? '',
    phone_secondary_e164: s.phone_secondary_e164 ?? '',
    notes: s.notes ?? '',
  };
}

// Strip empty-string optionals to `undefined` before PATCH. The backend
// distinguishes "field omitted" from "field cleared" — we treat blanks as
// "leave alone" rather than "clear", which matches the form semantics
// (a blank optional input is the absence of input, not an explicit erasure).
function toPatchPayload(values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed === '') continue;
      out[k] = trimmed;
    } else if (v !== undefined && v !== null) {
      out[k] = v;
    }
  }
  return out;
}

export type EditCoreProfileDialogProps = {
  open: boolean;
  onClose: () => void;
  student: StudentLike;
  /** Render in fullscreen — used by the dedicated edit page route. */
  fullScreen?: boolean;
};

export default function EditCoreProfileDialog({
  open,
  onClose,
  student,
  fullScreen = false,
}: EditCoreProfileDialogProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const countriesQuery = useCountries();

  const defaults = useMemo(() => fromStudent(student), [student]);

  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    setError,
    formState: { errors, isSubmitting, isValid, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    mode: 'onBlur',
    defaultValues: defaults,
  });

  // Re-seed the form whenever the dialog opens or the source record's
  // version changes (e.g. a sibling tab refetched the student).
  useEffect(() => {
    if (open) reset(fromStudent(student));
    // Re-seed only when the dialog opens or the underlying record version
    // bumps; tracking the whole `student` object would reset on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, student.id, student.version]);

  const gender = watch('gender');
  const nationalityCode = watch('nationality_code');
  const phoneCountry = (nationalityCode || 'np').toLowerCase();
  // Self-description text is only meaningful when the closed enum doesn't
  // capture the user's identity. We surface the field for NOT_APPLICABLE
  // (the "describe in your own words" case) and NOT_KNOWN (so a counsellor
  // taking dictation can record the answer if the student volunteers it).
  const showSelfDescribed = gender === 'NOT_APPLICABLE' || gender === 'NOT_KNOWN';

  const updateMutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      const payload = toPatchPayload(values);
      const res = await api.patch(`/students/${student.id}`, payload, {
        headers: { 'If-Match': `"${student.version}"` },
      });
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Profile updated', { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['student', student.id] });
      qc.invalidateQueries({ queryKey: ['students'] });
      onClose();
    },
    onError: (err) => {
      // 412: someone else saved between our load and submit. Refetch and
      // ask the user to try again — clobbering blindly would lose their
      // collaborator's edits.
      if (err.status === 412) {
        enqueueSnackbar('Someone else updated this record; please reload', {
          variant: 'warning',
        });
        qc.invalidateQueries({ queryKey: ['student', student.id] });
        return;
      }
      // 422 with field-level errors → wire them into RHF inline.
      for (const fe of err.errors ?? []) {
        const leaf = fe.path.split('.').pop() as keyof FormValues | undefined;
        if (leaf && WRITABLE_PATHS.has(leaf)) {
          setError(leaf, { type: 'server', message: fe.message });
        }
      }
      enqueueSnackbar(err.detail || err.title || 'Could not update profile', {
        variant: 'error',
      });
    },
  });

  const onSubmit = handleSubmit((values) => updateMutation.mutate(values));

  const topLevelError =
    updateMutation.isError &&
    updateMutation.error &&
    updateMutation.error.status !== 412 &&
    !updateMutation.error.errors?.length
      ? updateMutation.error.detail || updateMutation.error.title || null
      : null;

  const formBody = (
      <Box
        component="form"
        id="edit-core-profile-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          // Standardize all input heights to 44px so date, text, select,
          // autocomplete, phone all line up vertically. Multiline (notes)
          // is excluded so it can grow.
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& .react-international-phone-input-container .react-international-phone-input': { height: 44 },
          '& .react-international-phone-input-container .react-international-phone-country-selector-button': { height: 44 },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root': { paddingTop: '0 !important', paddingBottom: '0 !important' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': { padding: '0 6px !important' },
        }}
      >
        {/* Required-field legend — explicit so the convention is unambiguous. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>

        {/* --- Identity --------------------------------------------- */}
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
              htmlFor="ec-given_name"
            >
              <TextField
                id="ec-given_name"
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
              label="Middle name"
              error={Boolean(errors.middle_name)}
              helperText={errors.middle_name?.message ?? ''}
              htmlFor="ec-middle_name"
            >
              <TextField
                id="ec-middle_name"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. Kumar"
                error={Boolean(errors.middle_name)}
                {...register('middle_name')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Family name"
              required
              error={Boolean(errors.family_name)}
              helperText={errors.family_name?.message ?? ''}
              htmlFor="ec-family_name"
            >
              <TextField
                id="ec-family_name"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. Sharma"
                error={Boolean(errors.family_name)}
                {...register('family_name')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Preferred name"
              error={Boolean(errors.preferred_name)}
              helperText={errors.preferred_name?.message ?? ''}
              htmlFor="ec-preferred_name"
            >
              <TextField
                id="ec-preferred_name"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="What they want to be called"
                error={Boolean(errors.preferred_name)}
                {...register('preferred_name')}
              />
            </LabeledField>
          </Grid>

          {/* Name in passport spans both columns — it's legally significant
              and we want it to read as a single, prominent line.
              Encrypted badge sits next to the label (LabeledField encrypted prop)
              so the affordance reads with the label, not floating in the input. */}
          <Grid item xs={12}>
            <LabeledField
              label="Name in passport"
              required
              encrypted
              error={Boolean(errors.name_in_passport)}
              helperText={
                errors.name_in_passport?.message ?? 'Enter exactly as printed in the passport.'
              }
              htmlFor="ec-name_in_passport"
            >
              <TextField
                id="ec-name_in_passport"
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

        {/* --- Demographics ----------------------------------------- */}
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
              htmlFor="ec-dob"
            >
              <TextField
                id="ec-dob"
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
              htmlFor="ec-gender"
            >
              <Controller
                name="gender"
                control={control}
                render={({ field }) => (
                  <TextField
                    id="ec-gender"
                    select
                    fullWidth
                    size="medium"
                    hiddenLabel
                    error={Boolean(errors.gender)}
                    {...field}
                  >
                    {GENDER_OPTIONS.map((g) => (
                      <MenuItem key={g.value} value={g.value}>{g.label}</MenuItem>
                    ))}
                  </TextField>
                )}
              />
            </LabeledField>
          </Grid>

          {showSelfDescribed && (
            <Grid item xs={12}>
              <LabeledField
                label="Self-described gender"
                error={Boolean(errors.gender_self_described)}
                helperText={
                  errors.gender_self_described?.message ?? "Only used when the options above don't fit."
                }
                htmlFor="ec-gsd"
              >
                <TextField
                  id="ec-gsd"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="Describe in your own words"
                  error={Boolean(errors.gender_self_described)}
                  {...register('gender_self_described')}
                />
              </LabeledField>
            </Grid>
          )}

          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Nationality"
              required
              error={Boolean(errors.nationality_code)}
              helperText={errors.nationality_code?.message ?? ''}
              htmlFor="ec-nat"
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
                      getOptionLabel={(o) => `${o.code_alpha2} — ${o.name}`}
                      isOptionEqualToValue={(a, b) => a.code_alpha2 === b.code_alpha2}
                      fullWidth
                      size="medium"
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          id="ec-nat"
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
              label="Marital status"
              error={Boolean(errors.marital_status)}
              helperText={errors.marital_status?.message ?? ''}
              htmlFor="ec-mar"
            >
              <Controller
                name="marital_status"
                control={control}
                render={({ field }) => (
                  <TextField
                    id="ec-mar"
                    select
                    fullWidth
                    size="medium"
                    hiddenLabel
                    error={Boolean(errors.marital_status)}
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    onBlur={field.onBlur}
                    inputRef={field.ref}
                    name={field.name}
                  >
                    {MARITAL_OPTIONS.map((m) => (
                      <MenuItem key={m.value || 'unset'} value={m.value}>{m.label}</MenuItem>
                    ))}
                  </TextField>
                )}
              />
            </LabeledField>
          </Grid>

          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Primary language"
              required
              error={Boolean(errors.primary_language)}
              helperText={errors.primary_language?.message ?? 'ISO 639-1 (e.g. en, ne, hi)'}
              htmlFor="ec-lang"
            >
              <TextField
                id="ec-lang"
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

          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Religion"
              error={Boolean(errors.religion)}
              helperText={errors.religion?.message ?? 'Self-declared. Optional.'}
              htmlFor="ec-rel"
            >
              <TextField
                id="ec-rel"
                fullWidth
                size="medium"
                hiddenLabel
                inputProps={{ maxLength: 80 }}
                error={Boolean(errors.religion)}
                {...register('religion')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Ethnicity"
              error={Boolean(errors.ethnicity)}
              helperText={errors.ethnicity?.message ?? 'Self-declared. Optional.'}
              htmlFor="ec-eth"
            >
              <TextField
                id="ec-eth"
                fullWidth
                size="medium"
                hiddenLabel
                inputProps={{ maxLength: 80 }}
                error={Boolean(errors.ethnicity)}
                {...register('ethnicity')}
              />
            </LabeledField>
          </Grid>
        </Grid>
        </FormSection>

        {/* --- Contact ---------------------------------------------- */}
        <FormSection
          title="Contact"
          subtitle="Email and phone numbers"
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
              htmlFor="ec-email1"
            >
              <TextField
                id="ec-email1"
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
              label="Secondary email"
              error={Boolean(errors.email_secondary)}
              helperText={errors.email_secondary?.message ?? ''}
              htmlFor="ec-email2"
            >
              <TextField
                id="ec-email2"
                type="email"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="alt@example.com"
                error={Boolean(errors.email_secondary)}
                {...register('email_secondary')}
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
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Secondary phone"
              error={Boolean(errors.phone_secondary_e164)}
              helperText={errors.phone_secondary_e164?.message ?? ''}
              htmlFor="ec-phone2"
            >
              <TextField
                id="ec-phone2"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="+9779812345678"
                error={Boolean(errors.phone_secondary_e164)}
                {...register('phone_secondary_e164')}
              />
            </LabeledField>
          </Grid>
        </Grid>
        </FormSection>

        {/* --- Notes ------------------------------------------------ */}
        <FormSection
          title="Notes"
          subtitle="Internal commentary, not shown to the student"
          icon={<StickyNote2OutlinedIcon />}
          iconColor="muted"
          compact
        >
          <LabeledField
            label="Notes"
            error={Boolean(errors.notes)}
            helperText={errors.notes?.message ?? 'Internal notes. Not shown to the student.'}
            htmlFor="ec-notes"
          >
            <TextField
              id="ec-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={3}
              inputProps={{ maxLength: 4000 }}
              error={Boolean(errors.notes)}
              {...register('notes')}
            />
          </LabeledField>
        </FormSection>
      </Box>
  );

  // Save gating: only block on submit-in-flight + not-dirty. Zod errors surface
  // inline on submit; pre-existing data that fails new validators shouldn't
  // permanently lock the user out — they can edit any field, hit Save, and the
  // 422 / inline error will guide the fix.
  const saveBlockedReason = !isDirty
    ? 'Make a change to enable saving'
    : Object.keys(errors).length > 0
      ? 'Fix errors above'
      : null;

  // Status banner shown ABOVE the dialog action bar. Visible regardless of
  // modal/page render mode so user always knows why Save is disabled.
  const statusBanner = (saveBlockedReason || updateMutation.isError) ? (
    <Box sx={{ px: 0, mt: 2, display: 'flex', justifyContent: 'flex-end' }}>
      {updateMutation.isError && updateMutation.error.errors?.length ? (
        <Alert severity="error" variant="outlined" sx={{ width: '100%' }}>
          Fix the {updateMutation.error.errors.length} highlighted error{updateMutation.error.errors.length === 1 ? '' : 's'} above and try again.
        </Alert>
      ) : saveBlockedReason ? (
        <Typography variant="caption" color="text.secondary">
          {saveBlockedReason}
        </Typography>
      ) : null}
    </Box>
  ) : null;

  // Page mode: render form in a centered Card with sticky footer instead of modal.
  if (fullScreen) {
    const saveDisabled = !isDirty || isSubmitting || updateMutation.isPending;
    return (
      <Box sx={{ maxWidth: 920, mx: 'auto', px: { xs: 2, md: 3 }, pb: 10 }}>
        <Stack spacing={0.5} sx={{ mb: 2 }}>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>
            Edit core profile
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Workflow stage and counsellor are edited elsewhere.
          </Typography>
        </Stack>
        {topLevelError && (
          <Alert severity="error" variant="outlined" sx={{ mb: 2 }}>
            {topLevelError}
          </Alert>
        )}
        <Paper variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
          {formBody}
        </Paper>
        {/* Sticky footer pinned to viewport bottom so save / cancel are always reachable. */}
        <Box
          sx={{
            position: 'fixed',
            bottom: 0,
            insetInlineStart: 0,
            insetInlineEnd: 0,
            bgcolor: 'background.paper',
            borderTop: (t) => `1px solid ${t.palette.divider}`,
            zIndex: 1100,
          }}
        >
          <Box sx={{ maxWidth: 920, mx: 'auto', px: { xs: 2, md: 3 }, py: 1.5, display: 'flex', gap: 1.5, justifyContent: 'flex-end', alignItems: 'center' }}>
            {saveBlockedReason && (
              <Typography variant="caption" color="text.secondary">
                {saveBlockedReason}
              </Typography>
            )}
            <Button onClick={onClose} variant="outlined" color="inherit" disabled={isSubmitting || updateMutation.isPending}>
              Cancel
            </Button>
            <Tooltip title={saveBlockedReason ?? ''}>
              <span>
                <Button
                  type="submit"
                  form="edit-core-profile-form"
                  variant="contained"
                  disabled={saveDisabled}
                >
                  {isSubmitting || updateMutation.isPending ? 'Saving…' : 'Save changes'}
                </Button>
              </span>
            </Tooltip>
          </Box>
        </Box>
      </Box>
    );
  }

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Edit core profile"
      subtitle="Workflow stage and counsellor are edited elsewhere."
      maxWidth="md"
      errorText={topLevelError}
      primaryAction={{
        label: 'Save changes',
        loadingLabel: 'Saving…',
        loading: isSubmitting || updateMutation.isPending,
        disabled: !isDirty || isSubmitting || updateMutation.isPending,
        formId: 'edit-core-profile-form',
      }}
    >
      {formBody}
      {statusBanner}
    </AppDialog>
  );
}
