// Refactored to SVT form-pattern per design pass.
'use client';

import { useEffect, useState } from 'react';
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
import { UpdateInstitutionRequest } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import PhoneField from '@/components/PhoneField';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';
import { useSaveBlockedReason } from '@/components/useSaveBlockedReason';
import { api, ApiError } from '@/lib/api';
import {
  INSTITUTION_TYPES,
  type CountryRow,
  type InstitutionRow,
  type InstitutionType,
} from './types';

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

function fromInstitution(i: InstitutionRow): FormValues {
  return {
    display_name: i.display_name,
    legal_name: i.legal_name,
    short_name: i.short_name ?? '',
    type: i.type,
    country_code: i.country_code,
    website: i.website ?? '',
    email: i.email ?? '',
    phone_e164: i.phone_e164 ?? '',
    established_year: i.established_year != null ? String(i.established_year) : '',
    ranking_global: i.ranking_global != null ? String(i.ranking_global) : '',
    ranking_national: i.ranking_national != null ? String(i.ranking_national) : '',
    is_partner: i.is_partner,
    partner_since: i.partner_since ? i.partner_since.slice(0, 10) : '',
    commission_pct: i.commission_pct ?? '',
    description: i.description ?? '',
  };
}

// Build a PATCH payload of *only* changed fields. Empty strings on optionals are
// translated to `undefined` (the backend accepts null/undefined for optional fields).
function buildDiff(
  initial: FormValues,
  current: FormValues,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const numericKeys: (keyof FormValues)[] = [
    'established_year',
    'ranking_global',
    'ranking_national',
  ];
  const stringKeys: (keyof FormValues)[] = [
    'display_name',
    'legal_name',
    'short_name',
    'website',
    'email',
    'phone_e164',
    'partner_since',
    'commission_pct',
    'description',
    'country_code',
  ];

  for (const k of stringKeys) {
    if (initial[k] !== current[k]) {
      const v = (current[k] as string).trim();
      out[k] = v === '' ? undefined : v;
    }
  }
  for (const k of numericKeys) {
    if (initial[k] !== current[k]) {
      const v = (current[k] as string).trim();
      out[k] = v === '' ? undefined : Number(v);
    }
  }
  if (initial.type !== current.type) out['type'] = current.type;
  if (initial.is_partner !== current.is_partner) out['is_partner'] = current.is_partner;
  return out;
}

export type EditInstitutionDialogProps = {
  open: boolean;
  institution: InstitutionRow | null;
  onClose: () => void;
};

export default function EditInstitutionDialog({
  open,
  institution,
  onClose,
}: EditInstitutionDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const queryClient = useQueryClient();
  const [submitting, setSubmitting] = useState(false);

  const countriesQ = useQuery({
    queryKey: ['lookups', 'countries'],
    queryFn: async () => {
      const res = await api.get<{ data: CountryRow[] }>('/lookups/countries');
      return res.data.data;
    },
    staleTime: 5 * 60_000,
  });

  const [initial, setInitial] = useState<FormValues | null>(null);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({ mode: 'onSubmit' });

  useEffect(() => {
    if (open && institution) {
      const v = fromInstitution(institution);
      reset(v);
      setInitial(v);
    }
  }, [open, institution, reset, setInitial]);

  const updateMut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (!institution) throw new Error('No institution');
      const res = await api.patch(`/institutions/${institution.id}`, payload, {
        headers: { 'If-Match': `"${institution.version}"` },
      });
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Institution updated.', { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['institutions'] });
      void queryClient.invalidateQueries({
        queryKey: ['institutions', 'detail', institution?.id],
      });
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          const path = fe.path;
          if (initial && path in (initial as object)) {
            setError(path as keyof FormValues, { type: 'server', message: fe.message });
          }
        }
        enqueueSnackbar(err.detail || err.title || 'Failed to update institution.', {
          variant: 'error',
        });
      } else {
        enqueueSnackbar('Network error. Please try again.', { variant: 'error' });
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
      const parsed = UpdateInstitutionRequest.safeParse(payload);
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
      await updateMut.mutateAsync(payload);
    } finally {
      setSubmitting(false);
    }
  });

  const handleClose = () => {
    if (submitting) return;
    onClose();
  };

  // Save gating: only block on submit-in-flight + not-dirty. Validation errors
  // surface inline on submit; pre-existing data should never lock the user out.
  const { disabled: saveBlockedFromForm, reason: saveBlockedReason } = useSaveBlockedReason({
    isDirty,
    isSubmitting,
    submitting: submitting || updateMut.isPending,
  });
  const saveDisabled = !institution || saveBlockedFromForm;

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title="Edit institution"
      maxWidth="md"
      primaryAction={{
        label: 'Save changes',
        loadingLabel: 'Saving…',
        loading: submitting,
        formId: 'edit-institution-form',
        disabled: saveDisabled,
      }}
    >
      {institution ? (
        <Box
          component="form"
          id="edit-institution-form"
          onSubmit={onSubmit}
          noValidate
          sx={FORM_BOX_SX}
        >
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
            <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
            Required
          </Typography>

          {/* --- Basic info ------------------------------------------ */}
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
                  htmlFor="ei-display_name"
                >
                  <TextField
                    id="ei-display_name"
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
                  htmlFor="ei-short_name"
                >
                  <TextField
                    id="ei-short_name"
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
                  htmlFor="ei-legal_name"
                >
                  <TextField
                    id="ei-legal_name"
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
                  htmlFor="ei-type"
                >
                  <Controller
                    name="type"
                    control={control}
                    render={({ field }) => (
                      <TextField
                        {...field}
                        id="ei-type"
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
                  htmlFor="ei-country"
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
                              id="ei-country"
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
                  htmlFor="ei-description"
                >
                  <TextField
                    id="ei-description"
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

          {/* --- Contact --------------------------------------------- */}
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
                  htmlFor="ei-website"
                >
                  <TextField
                    id="ei-website"
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
                  htmlFor="ei-email"
                >
                  <TextField
                    id="ei-email"
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
                        defaultCountry={(institution.country_code || 'np').toLowerCase()}
                        error={Boolean(errors.phone_e164)}
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
                  htmlFor="ei-established_year"
                >
                  <TextField
                    id="ei-established_year"
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
                  htmlFor="ei-ranking_global"
                >
                  <TextField
                    id="ei-ranking_global"
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
                  htmlFor="ei-ranking_national"
                >
                  <TextField
                    id="ei-ranking_national"
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

          {/* --- Partnership ----------------------------------------- */}
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
                            checked={Boolean(field.value)}
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
                  htmlFor="ei-partner_since"
                >
                  <TextField
                    id="ei-partner_since"
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
                  htmlFor="ei-commission_pct"
                >
                  <TextField
                    id="ei-commission_pct"
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
      ) : null}
    </AppDialog>
  );
}
