'use client';

// SVT-FORMPATTERN-2026-05: 44px input height + LabeledField wrapper, identical
// to /visa-types EditDialog.
//
// Create / edit dialog for /super-agents. Backed by AppDialog + react-hook-form.
// Validation runs the same Zod schemas the API enforces (CreateSuperAgentRequest
// for create, UpdateSuperAgentRequest for edit) so the UI surfaces server-side
// rules without round-tripping.

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
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import { CreateSuperAgentRequest, UpdateSuperAgentRequest } from '@spv/zod-schemas';
import { ApiError, api } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import type { SuperAgentRow } from './types';

type Props = {
  open: boolean;
  row: SuperAgentRow | null;
  onClose: () => void;
};

type FormValues = {
  name: string;
  short_name: string;
  legal_name: string;
  country_code: string;
  website: string;
  contact_email: string;
  contact_phone_e164: string;
  default_commission_pct: string;
  status: 'ACTIVE' | 'PAUSED' | 'TERMINATED';
  is_active: boolean;
  notes: string;
};

function emptyDefaults(): FormValues {
  return {
    name: '',
    short_name: '',
    legal_name: '',
    country_code: '',
    website: '',
    contact_email: '',
    contact_phone_e164: '',
    default_commission_pct: '',
    status: 'ACTIVE',
    is_active: true,
    notes: '',
  };
}

function fromRow(r: SuperAgentRow): FormValues {
  return {
    name: r.name,
    short_name: r.short_name ?? '',
    legal_name: r.legal_name ?? '',
    country_code: r.country_code ?? '',
    website: r.website ?? '',
    contact_email: r.contact_email ?? '',
    contact_phone_e164: r.contact_phone_e164 ?? '',
    default_commission_pct:
      r.default_commission_pct == null ? '' : String(r.default_commission_pct),
    status: r.status,
    is_active: r.is_active,
    notes: r.notes ?? '',
  };
}

export default function SuperAgentEditDialog({ open, row, onClose }: Props) {
  const isEdit = row !== null;
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const defaults = useMemo<FormValues>(() => (row ? fromRow(row) : emptyDefaults()), [row]);
  const resolverSchema = isEdit ? UpdateSuperAgentRequest : CreateSuperAgentRequest;

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
        const res = await api.patch(`/super-agents/${row.id}`, payload);
        return res.data as SuperAgentRow;
      }
      const res = await api.post('/super-agents', payload);
      return res.data as SuperAgentRow;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'Super-agent updated' : 'Super-agent created', {
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['super-agents'] });
      onClose();
    },
    onError: (err: unknown) => {
      const message = err instanceof ApiError ? err.detail || err.title : 'Save failed';
      enqueueSnackbar(message, { variant: 'error' });
    },
  });

  const saveDisabled = !isDirty || isSubmitting || mutation.isPending;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit super-agent: ${row?.name}` : 'New super-agent'}
      subtitle={
        isEdit
          ? 'Update the catalogue entry. Status changes follow the FSM (ACTIVE ↔ PAUSED, * → TERMINATED).'
          : 'Aggregator/intermediary platform you use to access institutions (e.g. Adventus, Edvoy, IDP, Apply Board, BUSY).'
      }
      maxWidth="sm"
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Create super-agent',
        loadingLabel: isEdit ? 'Saving…' : 'Creating…',
        loading: isSubmitting || mutation.isPending,
        onClick: handleSubmit((v) => mutation.mutate(v)),
        disabled: saveDisabled,
      }}
    >
      <Box
        sx={{
          // SVT-FORMPATTERN-2026-05: standardise input heights to 44px (notes
          // textarea excluded so it can grow).
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': {
            paddingTop: 0,
            paddingBottom: 0,
            height: '100%',
          },
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>
            *
          </Box>
          Required
        </Typography>
        <Stack spacing={2.5}>
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={7}>
              <LabeledField
                label="Name"
                required
                error={Boolean(errors.name)}
                helperText={errors.name?.message ?? 'Aggregator name (e.g. Adventus).'}
                htmlFor="sa-name"
              >
                <TextField
                  id="sa-name"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  placeholder="Adventus"
                  error={Boolean(errors.name)}
                  {...register('name')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={5}>
              <LabeledField
                label="Short name"
                error={Boolean(errors.short_name)}
                helperText={errors.short_name?.message ?? 'Optional alias.'}
                htmlFor="sa-short"
              >
                <TextField
                  id="sa-short"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  placeholder="ADV"
                  error={Boolean(errors.short_name)}
                  {...register('short_name')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Country (HQ)"
                error={Boolean(errors.country_code)}
                helperText={errors.country_code?.message ?? 'ISO alpha-2 code.'}
                htmlFor="sa-country"
              >
                <TextField
                  id="sa-country"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  placeholder="GB"
                  inputProps={{ maxLength: 2, style: { textTransform: 'uppercase' } }}
                  error={Boolean(errors.country_code)}
                  {...register('country_code')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Default commission %"
                error={Boolean(errors.default_commission_pct)}
                helperText={
                  errors.default_commission_pct?.message ?? '0.00–100.00, two decimals.'
                }
                htmlFor="sa-comm"
              >
                <TextField
                  id="sa-comm"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  type="number"
                  inputProps={{ min: 0, max: 100, step: 0.01 }}
                  placeholder="15.00"
                  error={Boolean(errors.default_commission_pct)}
                  {...register('default_commission_pct')}
                />
              </LabeledField>
            </Grid>
          </Grid>

          <LabeledField
            label="Website"
            error={Boolean(errors.website)}
            helperText={errors.website?.message ?? 'Public marketing site (https://…).'}
            htmlFor="sa-website"
          >
            <TextField
              id="sa-website"
              fullWidth
              hiddenLabel
              size="medium"
              placeholder="https://www.adventus.io"
              error={Boolean(errors.website)}
              {...register('website')}
            />
          </LabeledField>

          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Contact email"
                error={Boolean(errors.contact_email)}
                helperText={errors.contact_email?.message ?? 'Operations / partnerships contact.'}
                htmlFor="sa-email"
              >
                <TextField
                  id="sa-email"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  placeholder="partners@adventus.io"
                  error={Boolean(errors.contact_email)}
                  {...register('contact_email')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Contact phone (E.164)"
                error={Boolean(errors.contact_phone_e164)}
                helperText={errors.contact_phone_e164?.message ?? 'e.g. +442071234567'}
                htmlFor="sa-phone"
              >
                <TextField
                  id="sa-phone"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  placeholder="+442071234567"
                  error={Boolean(errors.contact_phone_e164)}
                  {...register('contact_phone_e164')}
                />
              </LabeledField>
            </Grid>
          </Grid>

          <LabeledField
            label="Notes"
            error={Boolean(errors.notes)}
            helperText={errors.notes?.message ?? 'Optional. Up to 4000 characters.'}
            htmlFor="sa-notes"
          >
            <TextField
              id="sa-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={2}
              error={Boolean(errors.notes)}
              {...register('notes')}
            />
          </LabeledField>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <LabeledField
              label="Status"
              error={Boolean(errors.status)}
              helperText={
                errors.status?.message ??
                'ACTIVE = enrollments allowed; PAUSED hides from new picks; TERMINATED is final.'
              }
              htmlFor="sa-status"
            >
              <Controller
                name="status"
                control={control}
                render={({ field }) => (
                  <TextField
                    {...field}
                    id="sa-status"
                    select
                    fullWidth
                    hiddenLabel
                    size="medium"
                    error={Boolean(errors.status)}
                  >
                    <MenuItem value="ACTIVE">ACTIVE</MenuItem>
                    <MenuItem value="PAUSED">PAUSED</MenuItem>
                    <MenuItem value="TERMINATED">TERMINATED</MenuItem>
                  </TextField>
                )}
              />
            </LabeledField>
            <Controller
              name="is_active"
              control={control}
              render={({ field }) => (
                <Box sx={{ flex: 1 }}>
                  <FormControlLabel
                    control={<Switch checked={field.value} onChange={(_, v) => field.onChange(v)} />}
                    label="Active (legacy flag)"
                  />
                  <Typography variant="caption" color="text.secondary" display="block">
                    Auto-derived from status; flip manually only if you need legacy filters to disagree.
                  </Typography>
                </Box>
              )}
            />
          </Stack>
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
    name: values.name.trim(),
    status: values.status,
    is_active: values.is_active,
  };
  const sn = values.short_name.trim();
  if (sn) out.short_name = sn;
  const ln = values.legal_name.trim();
  if (ln) out.legal_name = ln;
  const cc = values.country_code.trim().toUpperCase();
  if (cc) out.country_code = cc;
  const ws = values.website.trim();
  if (ws) out.website = ws;
  const em = values.contact_email.trim();
  if (em) out.contact_email = em;
  const ph = values.contact_phone_e164.trim();
  if (ph) out.contact_phone_e164 = ph;
  const dc = values.default_commission_pct.trim();
  if (dc) out.default_commission_pct = Number(dc);
  const nt = values.notes.trim();
  if (nt) out.notes = nt;
  return out;
}
