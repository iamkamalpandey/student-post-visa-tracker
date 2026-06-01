'use client';

// Refactored to SVT form-pattern per design pass.
// Create / edit dialog for /visa-types. Backed by AppDialog + react-hook-form
// with the same Zod schema the API enforces.

import { useEffect, useMemo } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import { CreateVisaTypeRequest, UpdateVisaTypeRequest } from '@spv/zod-schemas';
import { ApiError, api } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import type { CountryLite, VisaTypeRow } from './types';

type Props = {
  open: boolean;
  row: VisaTypeRow | null;
  countries: CountryLite[];
  onClose: () => void;
};

type FormValues = {
  country_code: string;
  name: string;
  short_name: string;
  description: string;
  is_active: boolean;
  is_generic: boolean;
};

function emptyDefaults(): FormValues {
  return {
    country_code: '',
    name: '',
    short_name: '',
    description: '',
    is_active: true,
    is_generic: false,
  };
}

function fromRow(r: VisaTypeRow): FormValues {
  return {
    country_code: r.country_code,
    name: r.name,
    short_name: r.short_name ?? '',
    description: r.description ?? '',
    is_active: r.is_active,
    is_generic: r.is_generic,
  };
}

export default function VisaTypeEditDialog({ open, row, countries, onClose }: Props) {
  const isEdit = row !== null;
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const defaults = useMemo<FormValues>(() => (row ? fromRow(row) : emptyDefaults()), [row]);
  // We resolve against the same Zod schema the API will enforce. Update
  // accepts a partial — Create requires the full base shape.
  const resolverSchema = isEdit ? UpdateVisaTypeRequest : CreateVisaTypeRequest;

  const {
    control,
    handleSubmit,
    register,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    defaultValues: defaults,
    resolver: (async (values: FormValues) => {
      const payload = toPayload(values);
      const parsed = resolverSchema.safeParse(payload);
      if (parsed.success) return { values, errors: {} };
      const fieldErrors: Record<string, { type: string; message: string }> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path[0];
        if (typeof path === 'string') {
          fieldErrors[path] = { type: 'validation', message: issue.message };
        }
      }
      return { values: {}, errors: fieldErrors };
    }) as Resolver<FormValues>,
  });

  useEffect(() => {
    if (open) reset(defaults);
  }, [open, defaults, reset]);

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const payload = toPayload(values);
      if (isEdit && row) {
        const res = await api.patch(`/visa-types/${row.id}`, payload);
        return res.data as VisaTypeRow;
      }
      const res = await api.post('/visa-types', payload);
      return res.data as VisaTypeRow;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'Visa type updated' : 'Visa type created', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['visa-types'] });
      onClose();
    },
    onError: (err: unknown) => {
      const message = err instanceof ApiError ? err.detail || err.title : 'Save failed';
      enqueueSnackbar(message, { variant: 'error' });
    },
  });

  const saveDisabled = !isDirty || isSubmitting || mutation.isPending;
  const saveBlockedReason = !isDirty ? 'Make a change to enable saving' : null;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit visa type: ${row?.name}` : 'New visa type'}
      subtitle={
        isEdit
          ? 'Update the catalogue entry. Generic rows have rename / delete protection.'
          : 'Create a new visa workflow entry. Mark as "generic" to make it the tenant default for the country.'
      }
      maxWidth="sm"
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Create visa type',
        loadingLabel: isEdit ? 'Saving…' : 'Creating…',
        loading: isSubmitting || mutation.isPending,
        onClick: handleSubmit((v) => mutation.mutate(v)),
        disabled: saveDisabled,
      }}
    >
      <Box
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        {/* Required-field legend. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Stack spacing={2.5}>
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={5}>
              <LabeledField
                label="Country"
                required
                error={Boolean(errors.country_code)}
                helperText={errors.country_code?.message ?? 'ISO 3166-1 alpha-2 country.'}
                htmlFor="visa-type-country"
              >
                <Controller
                  name="country_code"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      id="visa-type-country"
                      select
                      fullWidth
                      hiddenLabel
                      size="medium"
                      error={Boolean(errors.country_code)}
                    >
                      {countries.map((c) => (
                        <MenuItem key={c.code_alpha2} value={c.code_alpha2}>
                          {c.name} ({c.code_alpha2})
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={7}>
              <LabeledField
                label="Name"
                required
                error={Boolean(errors.name)}
                helperText={errors.name?.message ?? 'Human-readable visa workflow name.'}
                htmlFor="visa-type-name"
              >
                <TextField
                  id="visa-type-name"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  placeholder="Subclass 500 Student Visa"
                  error={Boolean(errors.name)}
                  {...register('name')}
                />
              </LabeledField>
            </Grid>
          </Grid>

          <LabeledField
            label="Short name"
            error={Boolean(errors.short_name)}
            helperText={errors.short_name?.message ?? 'Optional code or alias.'}
            htmlFor="visa-type-short"
          >
            <TextField
              id="visa-type-short"
              fullWidth
              hiddenLabel
              size="medium"
              placeholder="sub-500"
              error={Boolean(errors.short_name)}
              {...register('short_name')}
            />
          </LabeledField>

          <LabeledField
            label="Description"
            error={Boolean(errors.description)}
            helperText={errors.description?.message ?? 'Optional. Up to 2000 characters.'}
            htmlFor="visa-type-description"
          >
            <TextField
              id="visa-type-description"
              fullWidth
              hiddenLabel
              multiline
              minRows={2}
              placeholder="Long-stay student visa for Australian tertiary providers."
              error={Boolean(errors.description)}
              {...register('description')}
            />
          </LabeledField>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <Controller
              name="is_active"
              control={control}
              render={({ field }) => (
                <Box sx={{ flex: 1 }}>
                  <FormControlLabel
                    control={<Switch checked={field.value} onChange={(_, v) => field.onChange(v)} />}
                    label="Active"
                  />
                  <Typography variant="caption" color="text.secondary" display="block">
                    Inactive rows are hidden from filters and stage assignment.
                  </Typography>
                </Box>
              )}
            />
            <Controller
              name="is_generic"
              control={control}
              render={({ field }) => (
                <Box sx={{ flex: 1 }}>
                  <FormControlLabel
                    control={<Switch checked={field.value} onChange={(_, v) => field.onChange(v)} />}
                    label="Generic (tenant default)"
                  />
                  <Typography variant="caption" color="text.secondary" display="block">
                    Generic rows can&apos;t be renamed or deleted. Clear this flag first to retire one.
                  </Typography>
                </Box>
              )}
            />
          </Stack>
          {saveBlockedReason && (
            <Tooltip title="">
              <Typography variant="caption" color="text.secondary">
                {saveBlockedReason}
              </Typography>
            </Tooltip>
          )}
        </Stack>
      </Box>
    </AppDialog>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toPayload(values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    country_code: values.country_code.trim().toUpperCase(),
    name: values.name.trim(),
    is_active: values.is_active,
    is_generic: values.is_generic,
  };
  const sn = values.short_name.trim();
  if (sn) out.short_name = sn;
  const desc = values.description.trim();
  if (desc) out.description = desc;
  return out;
}
