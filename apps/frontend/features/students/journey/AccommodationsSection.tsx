// Refactored to SVT form-pattern (LabeledField + FormSection compact) per design pass.
'use client';

import { useEffect } from 'react';
import { Box, Chip, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import Grid from '@mui/material/Grid';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import HomeOutlinedIcon from '@mui/icons-material/HomeOutlined';
import ContactMailOutlinedIcon from '@mui/icons-material/ContactMailOutlined';
import EventOutlinedIcon from '@mui/icons-material/EventOutlined';
import PaymentsOutlinedIcon from '@mui/icons-material/PaymentsOutlined';
import {
  AccommodationTypeEnum,
  CreateAccommodationRequest,
  RentPeriodEnum,
  type CreateAccommodationRequest as CreateAccommodationRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { useTenant } from '@/lib/queries';
import { formatDate, formatMoney, formatPhone } from '@/lib/format';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
import CurrencyAutocomplete from '@/components/CurrencyAutocomplete';
import PhoneField from '@/components/PhoneField';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';
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

const TYPE_LABELS: Record<string, string> = {
  UNIVERSITY_HALL: 'University hall',
  HOMESTAY: 'Homestay',
  PRIVATE_RENTAL: 'Private rental',
  OWNED: 'Owned',
  OTHER: 'Other',
};

type Accommodation = {
  id: string;
  type: string;
  provider_name?: string | null;
  contact_phone_e164?: string | null;
  contact_email?: string | null;
  address_id?: string | null;
  move_in_date?: string | null;
  move_out_date?: string | null;
  rent_minor?: number | string | null;
  rent_currency?: string | null;
  rent_period?: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY' | null;
  deposit_minor?: number | string | null;
  is_current: boolean;
};

export type AccommodationsSectionProps = { studentId: string };

export default function AccommodationsSection({ studentId }: AccommodationsSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Accommodation>();
  const deleteDlg = useDialogState<Accommodation>();

  const queryKey = ['students', studentId, 'accommodations'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/accommodations`);
      return unwrapList<Accommodation>(res.data);
    },
  });

  const columns: DataTableColumn<Accommodation>[] = [
    {
      key: 'type',
      label: 'Type',
      render: (r) => (
        <Stack direction="row" spacing={0.75} alignItems="center">
          <span>{TYPE_LABELS[r.type] ?? r.type}</span>
          {r.is_current ? <Chip size="small" label="Current" color="success" /> : null}
        </Stack>
      ),
    },
    { key: 'provider', label: 'Provider', render: (r) => r.provider_name ?? '—' },
    { key: 'phone', label: 'Phone', render: (r) => formatPhone(r.contact_phone_e164) || '—' },
    {
      key: 'rent',
      label: 'Rent',
      render: (r) =>
        r.rent_minor != null && r.rent_currency
          ? `${formatMoney(r.rent_minor, r.rent_currency)}${r.rent_period ? ` / ${r.rent_period.toLowerCase()}` : ''}`
          : '—',
    },
    { key: 'in', label: 'Move-in', render: (r) => formatDate(r.move_in_date ?? '') },
    { key: 'out', label: 'Move-out', render: (r) => formatDate(r.move_out_date ?? '') },
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

  const removeMutation = useMutation<void, ApiError, Accommodation>({
    mutationFn: async (row) => {
      await api.delete(`/accommodations/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Accommodation deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Accommodations"
        description="Current and past lodging arrangements with provider contact details."
        onAdd={dlg.openCreate}
        addLabel="Add accommodation"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="accommodation"
        onAdd={dlg.openCreate}
        addLabel="Add accommodation"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <AccommodationFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey })}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete accommodation?"
        description="This permanently removes the accommodation record."
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

type FormValues = CreateAccommodationRequestType;

function AccommodationFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Accommodation | null;
  studentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(CreateAccommodationRequest),
    defaultValues: {
      type: 'UNIVERSITY_HALL',
      provider_name: '',
      contact_phone_e164: '',
      contact_email: '',
      move_in_date: undefined,
      move_out_date: undefined,
      rent_currency: '',
      rent_period: undefined,
      is_current: true,
    },
  });

  // SVT-WAVE28-DEFAULTS-2026-05 — seed rent_currency from tenant default on create.
  const tenantQ = useTenant(open && !editing);

  useEffect(() => {
    if (!open) return;
    reset({
      type: (editing?.type as FormValues['type']) ?? 'UNIVERSITY_HALL',
      provider_name: editing?.provider_name ?? '',
      contact_phone_e164: editing?.contact_phone_e164 ?? '',
      contact_email: editing?.contact_email ?? '',
      move_in_date: editing?.move_in_date?.slice(0, 10),
      move_out_date: editing?.move_out_date?.slice(0, 10),
      rent_minor: editing?.rent_minor != null ? String(editing.rent_minor) : undefined,
      rent_currency: editing?.rent_currency ?? (tenantQ.data?.default_currency ?? ''),
      rent_period: (editing?.rent_period ?? undefined) as FormValues['rent_period'],
      deposit_minor: editing?.deposit_minor != null ? String(editing.deposit_minor) : undefined,
      is_current: editing?.is_current ?? true,
    });
  }, [open, editing, reset, tenantQ.data?.default_currency]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      const body = compactPayload(values);
      if (editing) return api.patch(`/accommodations/${editing.id}`, body);
      return api.post(`/students/${studentId}/accommodations`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Accommodation updated' : 'Accommodation added', {
        variant: 'success',
      });
      onSaved();
      onClose();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));
  const saveDisabled = (!editing && !isDirty) || isSubmitting || mutation.isPending;

  return (
    <FormDialog
      open={open}
      title={editing ? 'Edit accommodation' : 'Add accommodation'}
      formId="accommodation-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="accommodation-form"
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
        {saveDisabled && !isSubmitting && !mutation.isPending ? (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Make a change to enable saving
          </Typography>
        ) : null}

        <FormSection
          title="Property"
          subtitle="Type and provider"
          icon={<HomeOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Type"
                required
                error={Boolean(errors.type)}
                helperText={errors.type?.message ?? ''}
                htmlFor="ac-type"
              >
                <Controller
                  name="type"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="ac-type"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.type)}
                      {...field}
                    >
                      {AccommodationTypeEnum.options.map((o) => (
                        <MenuItem key={o} value={o}>
                          {TYPE_LABELS[o] ?? o}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Provider name"
                error={Boolean(errors.provider_name)}
                helperText={errors.provider_name?.message ?? ''}
                htmlFor="ac-prov"
              >
                <TextField
                  id="ac-prov"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. UCL Halls"
                  error={Boolean(errors.provider_name)}
                  {...register('provider_name')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Controller
                  name="is_current"
                  control={control}
                  render={({ field }) => (
                    <Switch
                      checked={Boolean(field.value)}
                      onChange={(e) => field.onChange(e.target.checked)}
                    />
                  )}
                />
                <Typography variant="body2">Currently living here</Typography>
              </Stack>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Provider contact"
          subtitle="How to reach the landlord or warden"
          icon={<ContactMailOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Contact phone"
                error={Boolean(errors.contact_phone_e164)}
                helperText={errors.contact_phone_e164?.message ?? 'E.164 with country code.'}
              >
                <Controller
                  name="contact_phone_e164"
                  control={control}
                  render={({ field }) => (
                    <PhoneField
                      label=""
                      fullWidth
                      defaultCountry="gb"
                      value={field.value ?? ''}
                      onChange={field.onChange}
                      error={Boolean(errors.contact_phone_e164)}
                    />
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Contact email"
                error={Boolean(errors.contact_email)}
                helperText={errors.contact_email?.message ?? ''}
                htmlFor="ac-email"
              >
                <TextField
                  id="ac-email"
                  type="email"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="warden@example.com"
                  error={Boolean(errors.contact_email)}
                  {...register('contact_email')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Tenancy dates"
          subtitle="Move-in and move-out"
          icon={<EventOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Move-in date"
                error={Boolean(errors.move_in_date)}
                helperText={errors.move_in_date?.message ?? ''}
                htmlFor="ac-in"
              >
                <TextField
                  id="ac-in"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.move_in_date)}
                  {...register('move_in_date')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Move-out date"
                error={Boolean(errors.move_out_date)}
                helperText={errors.move_out_date?.message ?? ''}
                htmlFor="ac-out"
              >
                <TextField
                  id="ac-out"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.move_out_date)}
                  {...register('move_out_date')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Rent & deposit"
          subtitle="Cost and billing period"
          icon={<PaymentsOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Rent (minor units)"
                error={Boolean(errors.rent_minor)}
                helperText={errors.rent_minor?.message ?? 'Smallest currency unit.'}
                htmlFor="ac-rent"
              >
                <TextField
                  id="ac-rent"
                  type="number"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  inputProps={{ min: 0, step: 1 }}
                  placeholder="e.g. 90000"
                  error={Boolean(errors.rent_minor)}
                  {...register('rent_minor')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <Controller
                name="rent_currency"
                control={control}
                render={({ field }) => (
                  <CurrencyAutocomplete
                    name="rent_currency"
                    label="Rent currency"
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    error={Boolean(errors.rent_currency)}
                    helperText={errors.rent_currency?.message ?? ''}
                  />
                )}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Rent period"
                error={Boolean(errors.rent_period)}
                helperText={errors.rent_period?.message ?? ''}
                htmlFor="ac-period"
              >
                <Controller
                  name="rent_period"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="ac-period"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.rent_period)}
                      value={field.value ?? ''}
                      onChange={(e) => field.onChange(e.target.value || undefined)}
                    >
                      <MenuItem value="">—</MenuItem>
                      {RentPeriodEnum.options.map((o) => (
                        <MenuItem key={o} value={o}>
                          {o}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Deposit (minor units)"
                error={Boolean(errors.deposit_minor)}
                helperText={errors.deposit_minor?.message ?? ''}
                htmlFor="ac-dep"
              >
                <TextField
                  id="ac-dep"
                  type="number"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  inputProps={{ min: 0, step: 1 }}
                  placeholder="e.g. 90000"
                  error={Boolean(errors.deposit_minor)}
                  {...register('deposit_minor')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>
      </Box>
    </FormDialog>
  );
}
