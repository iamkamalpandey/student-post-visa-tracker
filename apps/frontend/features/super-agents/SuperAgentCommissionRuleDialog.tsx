'use client';

// CRUD dialog for SuperAgentCommissionRule rows. Effective-dated rates with
// optional scope by Institution + program_level. Follows SVT-FORMPATTERN-2026-05.

import { useEffect, useMemo } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Autocomplete,
  Box,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import {
  CreateSuperAgentCommissionRuleRequest,
  UpdateSuperAgentCommissionRuleRequest,
} from '@spv/zod-schemas';
import { ApiError, api } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';
import { useCurrencies, useTenant } from '@/lib/queries';

// Wire row.
export type SuperAgentCommissionRuleRow = {
  id: string;
  super_agent_id: string;
  institution_id: string | null;
  institution?: { id: string; display_name: string } | null;
  program_level: string | null;
  commission_pct: string | number;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  notes: string | null;
};

type InstitutionLite = {
  id: string;
  display_name?: string | null;
  legal_name?: string | null;
  short_name?: string | null;
};

type ApiList<T> = { data: T[] };

// Program level keys mirror the values the resolver compares against. Free-form
// text is supported (admins can add custom levels) but the dropdown surfaces
// the common ones.
const PROGRAM_LEVEL_OPTIONS = [
  'CERTIFICATE',
  'DIPLOMA',
  'FOUNDATION',
  'UNDERGRADUATE',
  'POSTGRADUATE',
  'DOCTORATE',
  'LANGUAGE',
] as const;

type Props = {
  open: boolean;
  superAgentId: string;
  /** Existing rules — fed into the overlap detector. */
  existing: SuperAgentCommissionRuleRow[];
  row: SuperAgentCommissionRuleRow | null;
  onClose: () => void;
};

type FormValues = {
  institution_id: string; // '' = default (no institution scope)
  program_level: string; // '' = any
  commission_pct: string;
  currency: string;
  effective_from: string;
  effective_to: string; // '' = open-ended
  notes: string;
};

function emptyDefaults(): FormValues {
  return {
    institution_id: '',
    program_level: '',
    commission_pct: '',
    currency: '',
    effective_from: '',
    effective_to: '',
    notes: '',
  };
}

function fromRow(r: SuperAgentCommissionRuleRow): FormValues {
  return {
    institution_id: r.institution_id ?? '',
    program_level: r.program_level ?? '',
    commission_pct: String(r.commission_pct),
    currency: r.currency,
    effective_from: r.effective_from.slice(0, 10),
    effective_to: r.effective_to ? r.effective_to.slice(0, 10) : '',
    notes: r.notes ?? '',
  };
}

function toPayload(values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    commission_pct: Number(values.commission_pct),
    currency: values.currency,
    effective_from: values.effective_from,
  };
  if (values.institution_id) out['institution_id'] = values.institution_id;
  if (values.program_level) out['program_level'] = values.program_level;
  if (values.effective_to) out['effective_to'] = values.effective_to;
  const nt = values.notes.trim();
  if (nt) out['notes'] = nt;
  return out;
}

// Detect overlapping effective windows on the SAME (institution, program_level)
// scope. Two ranges overlap iff start1 <= end2 AND start2 <= end1 (treating
// open-ended ranges as +infinity).
function findOverlaps(
  values: FormValues,
  existing: SuperAgentCommissionRuleRow[],
  editingId: string | null,
): SuperAgentCommissionRuleRow[] {
  if (!values.effective_from) return [];
  const targetStart = new Date(values.effective_from).getTime();
  const targetEnd = values.effective_to
    ? new Date(values.effective_to).getTime()
    : Number.POSITIVE_INFINITY;
  if (Number.isNaN(targetStart) || (values.effective_to && Number.isNaN(targetEnd))) {
    return [];
  }
  const scopeInst = values.institution_id || null;
  const scopeLevel = values.program_level || null;

  return existing.filter((r) => {
    if (editingId && r.id === editingId) return false;
    if ((r.institution_id ?? null) !== scopeInst) return false;
    if ((r.program_level ?? null) !== scopeLevel) return false;
    const otherStart = new Date(r.effective_from).getTime();
    const otherEnd = r.effective_to
      ? new Date(r.effective_to).getTime()
      : Number.POSITIVE_INFINITY;
    if (Number.isNaN(otherStart)) return false;
    return targetStart <= otherEnd && otherStart <= targetEnd;
  });
}

export default function SuperAgentCommissionRuleDialog({
  open,
  superAgentId,
  existing,
  row,
  onClose,
}: Props) {
  const isEdit = row !== null;
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const currenciesQ = useCurrencies();

  const defaults = useMemo<FormValues>(
    () => (row ? fromRow(row) : emptyDefaults()),
    [row],
  );
  const resolverSchema = isEdit
    ? UpdateSuperAgentCommissionRuleRequest
    : CreateSuperAgentCommissionRuleRequest;

  // Institutions catalogue for the optional scope picker.
  const institutionsQ = useQuery({
    queryKey: ['institutions', 'all-for-rule-picker'],
    queryFn: async () => {
      const res = await api.get<ApiList<InstitutionLite>>('/institutions', {
        params: { limit: 200 },
      });
      return res.data.data;
    },
    enabled: open,
  });

  // SVT-WAVE28-DEFAULTS-2026-05 — seed currency from tenant.default_currency
  // on create. Admin-only dialog, so /tenants/me always permitted.
  const tenantQ = useTenant(open && !isEdit);

  const {
    control,
    handleSubmit,
    register,
    reset,
    watch,
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

  // SVT-WAVE26-DEFAULTS-2026-05 — once tenant default lands and we're in
  // create mode + currency still empty, set it. Doesn't overwrite user typing.
  useEffect(() => {
    if (!isEdit && open && tenantQ.data?.default_currency) {
      const cur = (control._getWatch?.('currency') as string | undefined) ?? '';
      if (!cur) reset({ ...defaults, currency: tenantQ.data.default_currency });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, open, tenantQ.data?.default_currency]);

  // Live overlap detection — pure warning, doesn't block save (admins might
  // legitimately need temporary overlaps while sunsetting a rule).
  const liveValues = watch();
  const overlaps = useMemo(
    () => findOverlaps(liveValues, existing, row?.id ?? null),
    [liveValues, existing, row?.id],
  );

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const payload = toPayload(values);
      if (isEdit && row) {
        const res = await api.patch(
          `/super-agents/${superAgentId}/commission-rules/${row.id}`,
          payload,
        );
        return res.data as SuperAgentCommissionRuleRow;
      }
      const res = await api.post(
        `/super-agents/${superAgentId}/commission-rules`,
        payload,
      );
      return res.data as SuperAgentCommissionRuleRow;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'Rule updated' : 'Rule added', { variant: 'success' });
      void qc.invalidateQueries({
        queryKey: ['super-agent', superAgentId, 'commission-rules'],
      });
      onClose();
    },
    onError: (err: unknown) => {
      const message = err instanceof ApiError ? err.detail || err.title : 'Save failed';
      enqueueSnackbar(message, { variant: 'error' });
    },
  });

  const onSubmit = handleSubmit((v) => mutation.mutate(v));

  const saveBlockedReason = !isDirty
    ? 'Make a change to enable saving'
    : Object.keys(errors).length > 0
      ? 'Fix errors above'
      : null;

  const topLevelError =
    mutation.isError && mutation.error instanceof ApiError
      ? mutation.error.detail || mutation.error.title
      : null;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit commission rule' : 'Add commission rule'}
      subtitle="Effective-dated rate. Most-specific rule wins (institution + program-level)."
      maxWidth="md"
      errorText={topLevelError ?? null}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Add rule',
        loadingLabel: isEdit ? 'Saving…' : 'Adding…',
        loading: isSubmitting || mutation.isPending,
        disabled: !isDirty || isSubmitting || mutation.isPending,
        formId: 'sa-rule-form',
      }}
    >
      <Box
        component="form"
        id="sa-rule-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': {
            paddingTop: 0,
            paddingBottom: 0,
            height: '100%',
          },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root': {
            paddingTop: '0 !important',
            paddingBottom: '0 !important',
          },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': {
            padding: '0 6px !important',
          },
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>
            *
          </Box>
          Required
        </Typography>

        <FormSection
          title="Scope"
          subtitle="Leave blank for the super-agent default; narrower scopes override broader ones."
          icon={<RuleOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Institution"
                error={Boolean(errors.institution_id)}
                helperText={errors.institution_id?.message ?? 'Optional — leave blank to apply to all institutions.'}
                htmlFor="sar-inst"
              >
                <Controller
                  name="institution_id"
                  control={control}
                  render={({ field }) => {
                    const opts = institutionsQ.data ?? [];
                    const selected = opts.find((o) => o.id === field.value) ?? null;
                    return (
                      <Autocomplete<InstitutionLite>
                        options={opts}
                        loading={institutionsQ.isLoading}
                        value={selected}
                        onChange={(_, v) => field.onChange(v?.id ?? '')}
                        getOptionLabel={(o) =>
                          o.display_name ?? o.legal_name ?? o.short_name ?? o.id
                        }
                        isOptionEqualToValue={(a, b) => a.id === b.id}
                        fullWidth
                        size="medium"
                        renderInput={(p) => (
                          <TextField
                            {...p}
                            id="sar-inst"
                            hiddenLabel
                            placeholder="All institutions (default)"
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
                label="Program level"
                error={Boolean(errors.program_level)}
                helperText={errors.program_level?.message ?? 'Optional — applies to all levels when empty.'}
                htmlFor="sar-level"
              >
                <Controller
                  name="program_level"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="sar-level"
                      select
                      fullWidth
                      hiddenLabel
                      size="medium"
                      error={Boolean(errors.program_level)}
                      value={field.value}
                      onChange={field.onChange}
                    >
                      <MenuItem value="">— Any —</MenuItem>
                      {PROGRAM_LEVEL_OPTIONS.map((lvl) => (
                        <MenuItem key={lvl} value={lvl}>
                          {lvl}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Rate"
          subtitle="Percentage of tuition. Currency must match the enrolment tuition currency."
          icon={<RuleOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Commission %"
                required
                error={Boolean(errors.commission_pct)}
                helperText={errors.commission_pct?.message ?? '0.00–100.00, two decimals.'}
                htmlFor="sar-pct"
              >
                <TextField
                  id="sar-pct"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  type="number"
                  inputProps={{ min: 0, max: 100, step: 0.01 }}
                  placeholder="12.50"
                  error={Boolean(errors.commission_pct)}
                  {...register('commission_pct')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Currency"
                required
                error={Boolean(errors.currency)}
                helperText={errors.currency?.message ?? 'ISO 4217.'}
                htmlFor="sar-ccy"
              >
                <Controller
                  name="currency"
                  control={control}
                  render={({ field }) => {
                    const opts = currenciesQ.data ?? [];
                    const selected = opts.find((c) => c.code === field.value) ?? null;
                    return (
                      <Autocomplete
                        options={opts}
                        loading={currenciesQ.isLoading}
                        value={selected}
                        onChange={(_, v) => field.onChange(v?.code ?? '')}
                        getOptionLabel={(o) => `${o.code} — ${o.name}`}
                        isOptionEqualToValue={(a, b) => a.code === b.code}
                        fullWidth
                        size="medium"
                        renderInput={(p) => (
                          <TextField
                            {...p}
                            id="sar-ccy"
                            hiddenLabel
                            placeholder="Pick a currency"
                            error={Boolean(errors.currency)}
                          />
                        )}
                      />
                    );
                  }}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Effective window"
          subtitle="Leave end-date blank to keep the rule open indefinitely."
          icon={<RuleOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Effective from"
                required
                error={Boolean(errors.effective_from)}
                helperText={errors.effective_from?.message ?? ''}
                htmlFor="sar-from"
              >
                <TextField
                  id="sar-from"
                  type="date"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  error={Boolean(errors.effective_from)}
                  {...register('effective_from')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Effective to"
                error={Boolean(errors.effective_to)}
                helperText={errors.effective_to?.message ?? 'Optional — empty = open.'}
                htmlFor="sar-to"
              >
                <TextField
                  id="sar-to"
                  type="date"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  error={Boolean(errors.effective_to)}
                  {...register('effective_to')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12}>
              <LabeledField
                label="Notes"
                error={Boolean(errors.notes)}
                helperText={errors.notes?.message ?? 'Optional. Audit context for the rate change.'}
                htmlFor="sar-notes"
              >
                <TextField
                  id="sar-notes"
                  fullWidth
                  hiddenLabel
                  multiline
                  minRows={2}
                  error={Boolean(errors.notes)}
                  {...register('notes')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        {overlaps.length > 0 ? (
          <Alert severity="warning" variant="outlined" sx={{ mt: 1.5 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              Overlapping rule{overlaps.length === 1 ? '' : 's'} on the same scope
            </Typography>
            <Stack component="ul" spacing={0.25} sx={{ pl: 2.5, m: 0, mt: 0.5 }}>
              {overlaps.map((o) => (
                <Box component="li" key={o.id}>
                  <Typography variant="caption">
                    {o.effective_from.slice(0, 10)} →{' '}
                    {o.effective_to ? o.effective_to.slice(0, 10) : 'Open'} @{' '}
                    {String(o.commission_pct)}% {o.currency}
                  </Typography>
                </Box>
              ))}
            </Stack>
            <Typography variant="caption" color="text.secondary">
              Resolver picks the most-specific match; overlapping windows make the
              effective rate ambiguous when scope ties.
            </Typography>
          </Alert>
        ) : null}

        {saveBlockedReason ? (
          <Box sx={{ mt: 2, display: 'flex', justifyContent: 'flex-end' }}>
            <Typography variant="caption" color="text.secondary">
              {saveBlockedReason}
            </Typography>
          </Box>
        ) : null}
        {mutation.isError && mutation.error instanceof ApiError && mutation.error.errors?.length ? (
          <Alert severity="error" variant="outlined" sx={{ mt: 2 }}>
            Fix the {mutation.error.errors.length} highlighted error
            {mutation.error.errors.length === 1 ? '' : 's'} above and try again.
          </Alert>
        ) : null}
      </Box>
    </AppDialog>
  );
}
