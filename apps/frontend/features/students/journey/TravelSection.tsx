// Refactored to SVT form-pattern (LabeledField + FormSection compact) per design pass.
'use client';

import { useEffect } from 'react';
import { Box, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import Grid from '@mui/material/Grid';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import FlightTakeoffOutlinedIcon from '@mui/icons-material/FlightTakeoffOutlined';
import EventOutlinedIcon from '@mui/icons-material/EventOutlined';
import LocalTaxiOutlinedIcon from '@mui/icons-material/LocalTaxiOutlined';
import {
  CreateTravelRequest,
  TravelStatusEnum,
  type CreateTravelRequest as CreateTravelRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
import StatusChip from '@/components/StatusChip';
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

type Travel = {
  id: string;
  pnr?: string | null;
  airline_iata?: string | null;
  flight_number?: string | null;
  departure_iata?: string | null;
  arrival_iata?: string | null;
  departure_at?: string | null;
  arrival_at?: string | null;
  pickup_arranged: boolean;
  pickup_notes?: string | null;
  fare_minor?: number | string | null;
  fare_currency?: string | null;
  status: 'PLANNED' | 'BOOKED' | 'CANCELLED' | 'COMPLETED';
};

export type TravelSectionProps = { studentId: string };

export default function TravelSection({ studentId }: TravelSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Travel>();
  const deleteDlg = useDialogState<Travel>();

  const queryKey = ['students', studentId, 'travel'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/travel`);
      return unwrapList<Travel>(res.data);
    },
  });

  const columns: DataTableColumn<Travel>[] = [
    {
      key: 'flight',
      label: 'Flight',
      render: (r) =>
        r.airline_iata || r.flight_number
          ? `${r.airline_iata ?? ''}${r.flight_number ?? ''}`
          : '—',
    },
    { key: 'pnr', label: 'PNR', render: (r) => r.pnr ?? '—' },
    {
      key: 'route',
      label: 'Route',
      render: (r) =>
        r.departure_iata || r.arrival_iata
          ? `${r.departure_iata ?? '???'} → ${r.arrival_iata ?? '???'}`
          : '—',
    },
    { key: 'depart', label: 'Departure', render: (r) => formatDateTime(r.departure_at ?? '') },
    { key: 'arrive', label: 'Arrival', render: (r) => formatDateTime(r.arrival_at ?? '') },
    { key: 'status', label: 'Status', render: (r) => <StatusChip status={r.status} /> },
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

  const removeMutation = useMutation<void, ApiError, Travel>({
    mutationFn: async (row) => {
      await api.delete(`/travel/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Flight deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ['student', studentId] });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Travel"
        description="Booked and completed flights with PNR and pickup arrangements."
        onAdd={dlg.openCreate}
        addLabel="Add flight"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="flights"
        onAdd={dlg.openCreate}
        addLabel="Add flight"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <TravelFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => {
          qc.invalidateQueries({ queryKey });
          qc.invalidateQueries({ queryKey: ['student', studentId] });
        }}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete flight?"
        description="This permanently removes the travel record."
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

type FormValues = CreateTravelRequestType;

function toLocalDateTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function TravelFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Travel | null;
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
    resolver: zodResolver(CreateTravelRequest),
    defaultValues: {
      pnr: '',
      airline_iata: '',
      flight_number: '',
      departure_iata: '',
      arrival_iata: '',
      departure_at: undefined,
      arrival_at: undefined,
      pickup_arranged: false,
      pickup_notes: '',
      status: 'BOOKED',
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      pnr: editing?.pnr ?? '',
      airline_iata: editing?.airline_iata ?? '',
      flight_number: editing?.flight_number ?? '',
      departure_iata: editing?.departure_iata ?? '',
      arrival_iata: editing?.arrival_iata ?? '',
      departure_at: toLocalDateTime(editing?.departure_at) || undefined,
      arrival_at: toLocalDateTime(editing?.arrival_at) || undefined,
      pickup_arranged: editing?.pickup_arranged ?? false,
      pickup_notes: editing?.pickup_notes ?? '',
      status: editing?.status ?? 'BOOKED',
    });
  }, [open, editing, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (raw) => {
      const values: Record<string, unknown> = { ...raw };
      // Uppercase the IATA codes; server schema requires upper-case.
      for (const k of ['airline_iata', 'departure_iata', 'arrival_iata']) {
        const v = values[k] as string | undefined;
        if (v) values[k] = v.toUpperCase();
      }
      for (const k of ['departure_at', 'arrival_at']) {
        const v = values[k] as string | undefined;
        if (v) values[k] = new Date(v).toISOString();
      }
      const body = compactPayload(values);
      if (editing) return api.patch(`/travel/${editing.id}`, body);
      return api.post(`/students/${studentId}/travel`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Flight updated' : 'Flight added', { variant: 'success' });
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
      title={editing ? 'Edit flight' : 'Add flight'}
      formId="travel-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="travel-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="datetime-local"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
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
          title="Flight"
          subtitle="Carrier, route and reservation reference"
          icon={<FlightTakeoffOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="PNR"
                error={Boolean(errors.pnr)}
                helperText={errors.pnr?.message ?? ''}
                htmlFor="tv-pnr"
              >
                <TextField
                  id="tv-pnr"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. ABC123"
                  error={Boolean(errors.pnr)}
                  {...register('pnr')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Status"
                error={Boolean(errors.status)}
                helperText={errors.status?.message ?? ''}
                htmlFor="tv-status"
              >
                <Controller
                  name="status"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="tv-status"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.status)}
                      {...field}
                    >
                      {TravelStatusEnum.options.map((o) => (
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
                label="Airline (IATA)"
                error={Boolean(errors.airline_iata)}
                helperText={errors.airline_iata?.message ?? '2-letter code (e.g. BA, EK)'}
                htmlFor="tv-air"
              >
                <TextField
                  id="tv-air"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="BA"
                  inputProps={{ maxLength: 2, style: { textTransform: 'uppercase' } }}
                  error={Boolean(errors.airline_iata)}
                  {...register('airline_iata')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Flight number"
                error={Boolean(errors.flight_number)}
                helperText={errors.flight_number?.message ?? ''}
                htmlFor="tv-num"
              >
                <TextField
                  id="tv-num"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. 142"
                  error={Boolean(errors.flight_number)}
                  {...register('flight_number')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Departure (IATA)"
                error={Boolean(errors.departure_iata)}
                helperText={errors.departure_iata?.message ?? '3-letter airport code'}
                htmlFor="tv-dep"
              >
                <TextField
                  id="tv-dep"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="KTM"
                  inputProps={{ maxLength: 3, style: { textTransform: 'uppercase' } }}
                  error={Boolean(errors.departure_iata)}
                  {...register('departure_iata')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Arrival (IATA)"
                error={Boolean(errors.arrival_iata)}
                helperText={errors.arrival_iata?.message ?? '3-letter airport code'}
                htmlFor="tv-arr"
              >
                <TextField
                  id="tv-arr"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="LHR"
                  inputProps={{ maxLength: 3, style: { textTransform: 'uppercase' } }}
                  error={Boolean(errors.arrival_iata)}
                  {...register('arrival_iata')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Schedule"
          subtitle="When the flight departs and arrives"
          icon={<EventOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Departure at"
                error={Boolean(errors.departure_at)}
                helperText={errors.departure_at?.message ?? ''}
                htmlFor="tv-depat"
              >
                <TextField
                  id="tv-depat"
                  type="datetime-local"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.departure_at)}
                  {...register('departure_at')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Arrival at"
                error={Boolean(errors.arrival_at)}
                helperText={errors.arrival_at?.message ?? ''}
                htmlFor="tv-arrat"
              >
                <TextField
                  id="tv-arrat"
                  type="datetime-local"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.arrival_at)}
                  {...register('arrival_at')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Pickup"
          subtitle="Airport reception arrangements"
          icon={<LocalTaxiOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Controller
                  name="pickup_arranged"
                  control={control}
                  render={({ field }) => (
                    <Switch
                      checked={Boolean(field.value)}
                      onChange={(e) => field.onChange(e.target.checked)}
                    />
                  )}
                />
                <Typography variant="body2">Airport pickup arranged</Typography>
              </Stack>
            </Grid>
            <Grid item xs={12}>
              <LabeledField
                label="Pickup notes"
                error={Boolean(errors.pickup_notes)}
                helperText={errors.pickup_notes?.message ?? ''}
                htmlFor="tv-pn"
              >
                <TextField
                  id="tv-pn"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Driver name, plate, terminal"
                  error={Boolean(errors.pickup_notes)}
                  {...register('pickup_notes')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>
      </Box>
    </FormDialog>
  );
}
