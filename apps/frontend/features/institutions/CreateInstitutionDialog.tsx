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
  FormControlLabel,
  MenuItem,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import BusinessOutlinedIcon from '@mui/icons-material/BusinessOutlined';
import PublicOutlinedIcon from '@mui/icons-material/PublicOutlined';
import HandshakeOutlinedIcon from '@mui/icons-material/HandshakeOutlined';
import { CreateInstitutionRequest } from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import PhoneField from '@/components/PhoneField';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';
import { useSaveBlockedReason } from '@/components/useSaveBlockedReason';
import { INSTITUTION_TYPES, type CountryRow, type InstitutionType } from './types';

// Standardise input heights to 44px so date / text / select / autocomplete /
// phone all line up vertically. Multiline (description) is excluded so it can grow.
const FORM_BOX_SX = {
  '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
  '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
  '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
  '& .react-international-phone-input-container .react-international-phone-input': { height: 44 },
  '& .react-international-phone-input-container .react-international-phone-country-selector-button': { height: 44 },
  '& .MuiAutocomplete-root .MuiOutlinedInput-root': { paddingTop: '0 !important', paddingBottom: '0 !important' },
  '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': { padding: '0 6px !important' },
} as const;

type FormValues = {
  display_name: string;
  legal_name: string;
  short_name: string;
  type: InstitutionType;
  country_code: string;
  website: string;
  email: string;
  phone_e164: string;
  established_year: string;
  ranking_global: string;
  ranking_national: string;
  is_partner: boolean;
  partner_since: string;
  commission_pct: string;
  description: string;
};

function emptyValues(): FormValues {
  return {
    display_name: '',
    legal_name: '',
    short_name: '',
    type: 'UNIVERSITY',
    country_code: '',
    website: '',
    email: '',
    phone_e164: '',
    established_year: '',
    ranking_global: '',
    ranking_national: '',
    is_partner: false,
    partner_since: '',
    commission_pct: '',
    description: '',
  };
}

// Strip empty optional fields and coerce numerics so the strict zod schema sees
// only the fields it accepts.
function buildPayload(v: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    display_name: v.display_name.trim(),
    legal_name: v.legal_name.trim(),
    type: v.type,
    country_code: v.country_code.trim().toUpperCase(),
    is_partner: v.is_partner,
  };
  if (v.short_name.trim()) out['short_name'] = v.short_name.trim();
  if (v.website.trim()) out['website'] = v.website.trim();
  if (v.email.trim()) out['email'] = v.email.trim();
  if (v.phone_e164.trim()) out['phone_e164'] = v.phone_e164.trim();
  if (v.established_year.trim()) out['established_year'] = Number(v.established_year);
  if (v.ranking_global.trim()) out['ranking_global'] = Number(v.ranking_global);
  if (v.ranking_national.trim()) out['ranking_national'] = Number(v.ranking_national);
  if (v.partner_since.trim()) out['partner_since'] = v.partner_since;
  if (v.commission_pct.trim()) out['commission_pct'] = v.commission_pct.trim();
  if (v.description.trim()) out['description'] = v.description.trim();
  return out;
}

export type CreateInstitutionDialogProps = {
  open: boolean;
  onClose: () => void;
};

export default function CreateInstitutionDialog({
  open,
  onClose,
}: CreateInstitutionDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);

  const countriesQ = useQuery({
    queryKey: ['lookups', 'countries'],
    queryFn: async () => {
      const res = await api.get<{ data: CountryRow[] }>('/lookups/countries');
      return res.data.data;
    },
    staleTime: 5 * 60_000,
  });

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({
    mode: 'onSubmit',
    defaultValues: emptyValues(),
  });

  useEffect(() => {
    if (open) reset(emptyValues());
  }, [open, reset]);

  const createMut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await api.post('/institutions', payload);
      return res.data as { id: string };
    },
    onSuccess: (created) => {
      enqueueSnackbar('Institution created.', { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['institutions'] });
      onClose();
      router.push(`/institutions/${created.id}`);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (fe.path in (emptyValues() as object)) {
            setError(fe.path as keyof FormValues, { type: 'server', message: fe.message });
          }
        }
        enqueueSnackbar(err.detail || err.title || 'Failed to create institution.', {
          variant: 'error',
        });
      } else {
        enqueueSnackbar('Network error. Please try again.', { variant: 'error' });
      }
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      const payload = buildPayload(values);
      const parsed = CreateInstitutionRequest.safeParse(payload);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const path = issue.path[0]?.toString();
          if (path && path in (emptyValues() as object)) {
            setError(path as keyof FormValues, {
              type: 'validate',
              message: issue.message,
            });
          }
        }
        return;
      }
      await createMut.mutateAsync(payload);
    } finally {
      setSubmitting(false);
    }
  });

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  // Save gating: block on submit-in-flight + not-dirty. A pristine form has
  // nothing to send; "Make a change to enable saving" surfaces below.
  const { disabled: saveDisabled, reason: saveBlockedReason } = useSaveBlockedReason({
    isDirty,
    isSubmitting,
    submitting: submitting || createMut.isPending,
  });

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title="New institution"
      subtitle="Add an institution to the catalog. You can wire up campuses, schools and programs from the detail page."
      maxWidth="md"
      primaryAction={{
        label: 'Create institution',
        loadingLabel: 'Creating…',
        loading: submitting,
        formId: 'create-institution-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="create-institution-form"
        onSubmit={onSubmit}
        noValidate
        sx={FORM_BOX_SX}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>

        {/* --- Basic info -------------------------------------------- */}
        <FormSection
          title="Basic information"
          subtitle="Names, type and country of the institution"
          icon={<BusinessOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Display name"
                required
                error={Boolean(errors.display_name)}
                helperText={errors.display_name?.message ?? ''}
                htmlFor="ci-display_name"
              >
                <TextField
                  id="ci-display_name"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. University of Manchester"
                  error={Boolean(errors.display_name)}
                  {...register('display_name', { required: 'Required' })}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Short name"
                error={Boolean(errors.short_name)}
                helperText={errors.short_name?.message ?? ''}
                htmlFor="ci-short_name"
              >
                <TextField
                  id="ci-short_name"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. UoM"
                  error={Boolean(errors.short_name)}
                  {...register('short_name')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12}>
              <LabeledField
                label="Legal name"
                required
                error={Boolean(errors.legal_name)}
                helperText={errors.legal_name?.message ?? ''}
                htmlFor="ci-legal_name"
              >
                <TextField
                  id="ci-legal_name"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. The University of Manchester"
                  error={Boolean(errors.legal_name)}
                  {...register('legal_name', { required: 'Required' })}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Type"
                required
                error={Boolean(errors.type)}
                helperText={errors.type?.message ?? ''}
                htmlFor="ci-type"
              >
                <Controller
                  name="type"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      id="ci-type"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.type)}
                    >
                      {INSTITUTION_TYPES.map((t) => (
                        <MenuItem key={t.value} value={t.value}>
                          {t.label}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Country"
                required
                error={Boolean(errors.country_code)}
                helperText={errors.country_code?.message ?? ''}
                htmlFor="ci-country"
              >
                <Controller
                  name="country_code"
                  control={control}
                  rules={{ required: 'Required' }}
                  render={({ field }) => {
                    const selected =
                      (countriesQ.data ?? []).find((c) => c.code_alpha2 === field.value) ?? null;
                    return (
                      <Autocomplete<CountryRow>
                        options={countriesQ.data ?? []}
                        loading={countriesQ.isLoading}
                        value={selected}
                        onChange={(_, v) => field.onChange(v?.code_alpha2 ?? '')}
                        getOptionLabel={(o) => `${o.name} (${o.code_alpha2})`}
                        isOptionEqualToValue={(a, b) => a.code_alpha2 === b.code_alpha2}
                        fullWidth
                        size="medium"
                        renderInput={(p) => (
                          <TextField
                            {...p}
                            id="ci-country"
                            hiddenLabel
                            placeholder="Select country"
                            error={Boolean(errors.country_code)}
                          />
                        )}
                      />
                    );
                  }}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12}>
              <LabeledField
                label="Description"
                error={Boolean(errors.description)}
                helperText={errors.description?.message ?? ''}
                htmlFor="ci-description"
              >
                <TextField
                  id="ci-description"
                  fullWidth
                  hiddenLabel
                  multiline
                  minRows={2}
                  placeholder="Short summary shown on the institution profile"
                  error={Boolean(errors.description)}
                  {...register('description')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        {/* --- Contact ----------------------------------------------- */}
        <FormSection
          title="Contact"
          subtitle="Public website, admissions email and phone"
          icon={<PublicOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Website"
                error={Boolean(errors.website)}
                helperText={errors.website?.message ?? ''}
                htmlFor="ci-website"
              >
                <TextField
                  id="ci-website"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="https://www.manchester.ac.uk"
                  error={Boolean(errors.website)}
                  {...register('website')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Email"
                error={Boolean(errors.email)}
                helperText={errors.email?.message ?? ''}
                htmlFor="ci-email"
              >
                <TextField
                  id="ci-email"
                  type="email"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="admissions@manchester.ac.uk"
                  error={Boolean(errors.email)}
                  {...register('email')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Phone"
                error={Boolean(errors.phone_e164)}
                helperText={errors.phone_e164?.message ?? 'E.164 format with country code.'}
              >
                <Controller
                  name="phone_e164"
                  control={control}
                  render={({ field }) => (
                    <PhoneField
                      label=""
                      fullWidth
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      error={Boolean(errors.phone_e164)}
                      placeholder="+441612750000"
                    />
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Established year"
                error={Boolean(errors.established_year)}
                helperText={errors.established_year?.message ?? ''}
                htmlFor="ci-established_year"
              >
                <TextField
                  id="ci-established_year"
                  type="number"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="1824"
                  error={Boolean(errors.established_year)}
                  {...register('established_year')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Global ranking"
                error={Boolean(errors.ranking_global)}
                helperText={errors.ranking_global?.message ?? ''}
                htmlFor="ci-ranking_global"
              >
                <TextField
                  id="ci-ranking_global"
                  type="number"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="34"
                  error={Boolean(errors.ranking_global)}
                  {...register('ranking_global')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="National ranking"
                error={Boolean(errors.ranking_national)}
                helperText={errors.ranking_national?.message ?? ''}
                htmlFor="ci-ranking_national"
              >
                <TextField
                  id="ci-ranking_national"
                  type="number"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="6"
                  error={Boolean(errors.ranking_national)}
                  {...register('ranking_national')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        {/* --- Partnership ------------------------------------------- */}
        <FormSection
          title="Partnership"
          subtitle="Partner status and commission terms"
          icon={<HandshakeOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5} alignItems="flex-start">
            <Grid item xs={12} sm={4}>
              <LabeledField label="Partner status">
                <Controller
                  name="is_partner"
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
                      label={field.value ? 'Partner institution' : 'Non-partner'}
                    />
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <LabeledField
                label="Partner since"
                error={Boolean(errors.partner_since)}
                helperText={errors.partner_since?.message ?? ''}
                htmlFor="ci-partner_since"
              >
                <TextField
                  id="ci-partner_since"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.partner_since)}
                  {...register('partner_since')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <LabeledField
                label="Commission %"
                error={Boolean(errors.commission_pct)}
                helperText={errors.commission_pct?.message ?? 'Decimal percentage, e.g. 12.50.'}
                htmlFor="ci-commission_pct"
              >
                <TextField
                  id="ci-commission_pct"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="12.50"
                  error={Boolean(errors.commission_pct)}
                  {...register('commission_pct')}
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
