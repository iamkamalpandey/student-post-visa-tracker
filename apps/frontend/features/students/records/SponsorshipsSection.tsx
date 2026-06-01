'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect, useMemo, useState } from 'react';
import {
  Autocomplete,
  Box,
  Button,
  Divider,
  MenuItem,
  Stack,
  TextField,
  Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  CreateSponsorRequest,
  CreateSponsorshipRequest,
  SponsorTypeEnum,
  type CreateSponsorRequest as CreateSponsorRequestType,
  type CreateSponsorshipRequest as CreateSponsorshipRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { useTenant } from '@/lib/queries';
import { useCountries } from '@/lib/queries';
import { formatDate, formatMoney } from '@/lib/format';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
import CurrencyAutocomplete from '@/components/CurrencyAutocomplete';
import PhoneField from '@/components/PhoneField';
import {
  FormDialog,
  RowActions,
  SectionHeader,
  SectionStates,
  compactPayload,
  unwrapList,
  useCanWrite,
  useDialogState,
} from '../sectionShared';
import LabeledField from '@/components/LabeledField';

type Sponsor = {
  id: string;
  type: string;
  legal_name: string;
  registration_no?: string | null;
  country_code?: string | null;
  email?: string | null;
  phone_e164?: string | null;
  is_active: boolean;
};

type Sponsorship = {
  id: string;
  sponsor_id: string;
  coverage_pct: number;
  amount_minor?: number | string | null;
  currency?: string | null;
  starts_on?: string | null;
  ends_on?: string | null;
  letter_doc_id?: string | null;
  notes?: string | null;
};

type SponsorOption = { id: string; label: string; sponsor: Sponsor };

const CREATE_SENTINEL: SponsorOption = {
  id: '__create__',
  label: '+ Create new sponsor…',
  sponsor: {
    id: '__create__',
    type: 'INDIVIDUAL',
    legal_name: '',
    is_active: true,
  },
};

export type SponsorshipsSectionProps = { studentId: string };

export default function SponsorshipsSection({ studentId }: SponsorshipsSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Sponsorship>();
  const deleteDlg = useDialogState<Sponsorship>();

  const queryKey = ['students', studentId, 'sponsorships'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/sponsorships`);
      return unwrapList<Sponsorship>(res.data);
    },
  });

  const sponsorsQuery = useQuery({
    queryKey: ['sponsors', 'all'],
    queryFn: async () => {
      const res = await api.get('/sponsors', { params: { limit: 200 } });
      return unwrapList<Sponsor>(res.data);
    },
  });

  const sponsorLabel = (id: string) =>
    sponsorsQuery.data?.find((s) => s.id === id)?.legal_name ?? id;

  const columns: DataTableColumn<Sponsorship>[] = [
    { key: 'sponsor', label: 'Sponsor', render: (r) => sponsorLabel(r.sponsor_id) },
    {
      key: 'coverage',
      label: 'Coverage',
      align: 'right',
      render: (r) => `${r.coverage_pct}%`,
    },
    {
      key: 'amount',
      label: 'Amount',
      align: 'right',
      render: (r) =>
        r.amount_minor != null && r.currency ? formatMoney(r.amount_minor, r.currency) : '—',
    },
    { key: 'start', label: 'Starts', render: (r) => formatDate(r.starts_on ?? '') },
    { key: 'end', label: 'Ends', render: (r) => formatDate(r.ends_on ?? '') },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (r) => (
        <RowActions
          canWrite={canWrite}
          onEdit={() => dlg.openEdit(r)}
          onDelete={() => deleteDlg.openEdit(r)}
        />
      ),
    },
  ];

  const removeMutation = useMutation<void, ApiError, Sponsorship>({
    mutationFn: async (row) => {
      await api.delete(`/sponsorships/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Sponsorship deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Sponsorships"
        description="Funding arrangements covering tuition, accommodation or living costs."
        onAdd={dlg.openCreate}
        addLabel="Add sponsorship"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="sponsorships"
        onAdd={dlg.openCreate}
        addLabel="Add sponsorship"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <SponsorshipFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        sponsors={sponsorsQuery.data ?? []}
        onSponsorsChanged={() => qc.invalidateQueries({ queryKey: ['sponsors', 'all'] })}
        onClose={dlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey })}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete sponsorship?"
        description="This permanently removes the sponsorship link. The sponsor record itself is unaffected."
        confirmText="Delete"
        loading={removeMutation.isPending}
        errorText={removeMutation.error?.detail ?? null}
        onClose={() => deleteDlg.close()}
        onConfirm={() => {
          if (deleteDlg.editing) removeMutation.mutate(deleteDlg.editing);
        }}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------

type FormValues = CreateSponsorshipRequestType;

function SponsorshipFormDialog({
  open,
  editing,
  studentId,
  sponsors,
  onSponsorsChanged,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Sponsorship | null;
  studentId: string;
  sponsors: Sponsor[];
  onSponsorsChanged: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const [createOpen, setCreateOpen] = useState(false);

  const sponsorOptions: SponsorOption[] = useMemo(
    () => [
      ...sponsors.map((s) => ({ id: s.id, label: s.legal_name, sponsor: s })),
      CREATE_SENTINEL,
    ],
    [sponsors],
  );

  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(CreateSponsorshipRequest),
    defaultValues: {
      sponsor_id: '',
      coverage_pct: 100,
      amount_minor: undefined,
      currency: '',
      starts_on: undefined,
      ends_on: undefined,
      notes: '',
    },
  });

  // SVT-WAVE28-DEFAULTS-2026-05 — seed currency from tenant default on create.
  const tenantQ = useTenant(open && !editing);

  useEffect(() => {
    if (!open) return;
    reset({
      sponsor_id: editing?.sponsor_id ?? '',
      coverage_pct: editing?.coverage_pct ?? 100,
      amount_minor: editing?.amount_minor != null ? String(editing.amount_minor) : undefined,
      currency: editing?.currency ?? (tenantQ.data?.default_currency ?? ''),
      starts_on: editing?.starts_on?.slice(0, 10),
      ends_on: editing?.ends_on?.slice(0, 10),
      notes: editing?.notes ?? '',
    });
  }, [open, editing, reset, tenantQ.data?.default_currency]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (raw) => {
      const values: Record<string, unknown> = { ...raw };
      const cov = values['coverage_pct'];
      if (typeof cov === 'string') values['coverage_pct'] = Number(cov);
      const body = compactPayload(values);
      if (editing) return api.patch(`/sponsorships/${editing.id}`, body);
      return api.post(`/students/${studentId}/sponsorships`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Sponsorship updated' : 'Sponsorship added', {
        variant: 'success',
      });
      onSaved();
      onClose();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));

  return (
    <>
      <FormDialog
        open={open}
        title={editing ? 'Edit sponsorship' : 'Add sponsorship'}
        formId="sponsorship-form"
        isSubmitting={isSubmitting || mutation.isPending}
        errorText={mutation.error?.detail ?? null}
        onClose={onClose}
      >
        <Box
          component="form"
          id="sponsorship-form"
          onSubmit={onSubmit}
          noValidate
          sx={{
            // Standardise input heights to 44px so date, text, select and
            // autocomplete all line up vertically. Multiline (notes) excluded
            // so it can grow.
            '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
            '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
            '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
            '& .MuiAutocomplete-root .MuiOutlinedInput-root': { paddingTop: '0 !important', paddingBottom: '0 !important' },
            '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': { padding: '0 6px !important' },
          }}
        >
          {/* Required-field legend — explicit so the convention is unambiguous. */}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
            <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
            Required
          </Typography>
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            <Box sx={{ gridColumn: { sm: '1 / -1' } }}>
              <LabeledField
                label="Sponsor"
                required
                error={Boolean(errors.sponsor_id)}
                helperText={errors.sponsor_id?.message ?? ''}
                htmlFor="spn-id"
              >
                <Controller
                  name="sponsor_id"
                  control={control}
                  render={({ field }) => (
                    <Autocomplete
                      options={sponsorOptions}
                      getOptionLabel={(o) => o.label}
                      isOptionEqualToValue={(o, v) => o.id === v.id}
                      value={sponsorOptions.find((o) => o.id === field.value) ?? null}
                      onChange={(_, v) => {
                        if (!v) {
                          field.onChange('');
                          return;
                        }
                        if (v.id === '__create__') {
                          setCreateOpen(true);
                          return;
                        }
                        field.onChange(v.id);
                      }}
                      fullWidth
                      size="medium"
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          id="spn-id"
                          hiddenLabel
                          placeholder="Search or create sponsor"
                          error={Boolean(errors.sponsor_id)}
                        />
                      )}
                    />
                  )}
                />
              </LabeledField>
            </Box>
            <LabeledField
              label="Coverage %"
              required
              error={Boolean(errors.coverage_pct)}
              helperText={errors.coverage_pct?.message ?? ''}
              htmlFor="spn-cov"
            >
              <TextField
                id="spn-cov"
                type="number"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="100"
                inputProps={{ min: 0, max: 100, step: '0.01' }}
                error={Boolean(errors.coverage_pct)}
                {...register('coverage_pct', { valueAsNumber: true })}
              />
            </LabeledField>
            <LabeledField
              label="Amount (minor units)"
              error={Boolean(errors.amount_minor)}
              helperText={errors.amount_minor?.message ?? 'Smallest currency unit.'}
              htmlFor="spn-amt"
            >
              <TextField
                id="spn-amt"
                type="number"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="0"
                inputProps={{ min: 0, step: 1 }}
                error={Boolean(errors.amount_minor)}
                {...register('amount_minor')}
              />
            </LabeledField>
            <LabeledField
              label="Currency"
              error={Boolean(errors.currency)}
              helperText={errors.currency?.message ?? ''}
            >
              <Controller
                name="currency"
                control={control}
                render={({ field }) => (
                  <CurrencyAutocomplete
                    name="currency"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    error={Boolean(errors.currency)}
                  />
                )}
              />
            </LabeledField>
            <LabeledField
              label="Starts on"
              error={Boolean(errors.starts_on)}
              helperText={errors.starts_on?.message ?? ''}
              htmlFor="spn-start"
            >
              <TextField
                id="spn-start"
                type="date"
                fullWidth
                size="medium"
                hiddenLabel
                error={Boolean(errors.starts_on)}
                {...register('starts_on')}
              />
            </LabeledField>
            <LabeledField
              label="Ends on"
              error={Boolean(errors.ends_on)}
              helperText={errors.ends_on?.message ?? ''}
              htmlFor="spn-end"
            >
              <TextField
                id="spn-end"
                type="date"
                fullWidth
                size="medium"
                hiddenLabel
                error={Boolean(errors.ends_on)}
                {...register('ends_on')}
              />
            </LabeledField>
            <Box sx={{ gridColumn: { sm: '1 / -1' } }}>
              <LabeledField
                label="Notes"
                error={Boolean(errors.notes)}
                helperText={errors.notes?.message ?? ''}
                htmlFor="spn-notes"
              >
                <TextField
                  id="spn-notes"
                  fullWidth
                  hiddenLabel
                  multiline
                  minRows={2}
                  error={Boolean(errors.notes)}
                  {...register('notes')}
                />
              </LabeledField>
            </Box>
          </Box>
        </Box>
      </FormDialog>

      <CreateSponsorDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(sponsor) => {
          onSponsorsChanged();
          setValue('sponsor_id', sponsor.id, { shouldValidate: true });
          setCreateOpen(false);
        }}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// Inline "create new sponsor" mini-dialog.
// ---------------------------------------------------------------------------

function CreateSponsorDialog({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (sponsor: Sponsor) => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const countries = useCountries();

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CreateSponsorRequestType>({
    resolver: zodResolver(CreateSponsorRequest),
    defaultValues: {
      type: 'INDIVIDUAL',
      legal_name: '',
      registration_no: '',
      country_code: undefined,
      email: '',
      phone_e164: '',
      is_active: true,
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      type: 'INDIVIDUAL',
      legal_name: '',
      registration_no: '',
      country_code: undefined,
      email: '',
      phone_e164: '',
      is_active: true,
    });
  }, [open, reset]);

  const mutation = useMutation<Sponsor, ApiError, CreateSponsorRequestType>({
    mutationFn: async (raw) => {
      const body = compactPayload(raw);
      const res = await api.post<Sponsor>('/sponsors', body);
      return res.data;
    },
    onSuccess: (sponsor) => {
      enqueueSnackbar('Sponsor created', { variant: 'success' });
      onCreated(sponsor);
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));

  return (
    <FormDialog
      open={open}
      title="Create sponsor"
      formId="create-sponsor-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
      submitLabel="Create sponsor"
    >
      <Box
        component="form"
        id="create-sponsor-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          // Standardise input heights to 44px so text, select, phone all line
          // up vertically — matches the SVT form pattern.
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& .react-international-phone-input-container .react-international-phone-input': { height: 44 },
          '& .react-international-phone-input-container .react-international-phone-country-selector-button': { height: 44 },
        }}
      >
        <Stack spacing={1.5}>
          <Typography variant="caption" color="text.secondary">
            <AddIcon fontSize="inherit" sx={{ mr: 0.5, verticalAlign: 'middle' }} />
            New sponsor records are reusable across students.
          </Typography>
          {/* Required-field legend — explicit so the convention is unambiguous. */}
          <Typography variant="caption" color="text.secondary">
            <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
            Required
          </Typography>
          <Divider />
          <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
            <LabeledField
              label="Type"
              required
              error={Boolean(errors.type)}
              helperText={errors.type?.message ?? ''}
              htmlFor="cs-type"
            >
              <Controller
                name="type"
                control={control}
                render={({ field }) => (
                  <TextField
                    id="cs-type"
                    select
                    fullWidth
                    size="medium"
                    hiddenLabel
                    error={Boolean(errors.type)}
                    {...field}
                  >
                    {SponsorTypeEnum.options.map((o) => (
                      <MenuItem key={o} value={o}>
                        {o}
                      </MenuItem>
                    ))}
                  </TextField>
                )}
              />
            </LabeledField>
            <LabeledField
              label="Legal name"
              required
              error={Boolean(errors.legal_name)}
              helperText={errors.legal_name?.message ?? ''}
              htmlFor="cs-name"
            >
              <TextField
                id="cs-name"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="As registered"
                error={Boolean(errors.legal_name)}
                {...register('legal_name')}
              />
            </LabeledField>
            <LabeledField
              label="Registration no"
              error={Boolean(errors.registration_no)}
              helperText={errors.registration_no?.message ?? ''}
              htmlFor="cs-reg"
            >
              <TextField
                id="cs-reg"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="Registry / company number"
                error={Boolean(errors.registration_no)}
                {...register('registration_no')}
              />
            </LabeledField>
            <LabeledField
              label="Country"
              error={Boolean(errors.country_code)}
              helperText={errors.country_code?.message ?? ''}
              htmlFor="cs-country"
            >
              <Controller
                name="country_code"
                control={control}
                render={({ field }) => (
                  <TextField
                    id="cs-country"
                    select
                    fullWidth
                    size="medium"
                    hiddenLabel
                    error={Boolean(errors.country_code)}
                    value={field.value ?? ''}
                    onChange={(e) => field.onChange(e.target.value || undefined)}
                  >
                    <MenuItem value="">—</MenuItem>
                    {(countries.data ?? []).map((c) => (
                      <MenuItem key={c.code_alpha2} value={c.code_alpha2}>
                        {c.name} ({c.code_alpha2})
                      </MenuItem>
                    ))}
                  </TextField>
                )}
              />
            </LabeledField>
            <LabeledField
              label="Email"
              error={Boolean(errors.email)}
              helperText={errors.email?.message ?? ''}
              htmlFor="cs-email"
            >
              <TextField
                id="cs-email"
                type="email"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="contact@example.com"
                error={Boolean(errors.email)}
                {...register('email')}
              />
            </LabeledField>
            <LabeledField
              label="Phone"
              error={Boolean(errors.phone_e164)}
              helperText={errors.phone_e164?.message ?? 'E.164 format.'}
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
                  />
                )}
              />
            </LabeledField>
          </Box>
          <Stack direction="row" spacing={1} justifyContent="flex-end">
            <Button onClick={onClose} color="inherit" disabled={mutation.isPending}>
              Cancel
            </Button>
          </Stack>
        </Stack>
      </Box>
    </FormDialog>
  );
}
