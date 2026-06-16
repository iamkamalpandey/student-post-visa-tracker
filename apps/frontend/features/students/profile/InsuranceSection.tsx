'use client';

// SVT-INSURANCE-UI-2026-06 — manage a student's insurance policies. The
// InsuranceRecord was scanned, dashboarded and reminded on, but had no
// create/edit UI; this fills that gap, mirroring the IdentificationsSection
// form-pattern. The policy number is encrypted at rest (excluded from the list
// projection); editing re-enters it only when changing it.

import { useEffect } from 'react';
import { Box, Stack, TextField, Typography } from '@mui/material';
import Grid from '@mui/material/Grid';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import HealthAndSafetyOutlinedIcon from '@mui/icons-material/HealthAndSafetyOutlined';
import EventOutlinedIcon from '@mui/icons-material/EventOutlined';
import {
  CreateInsuranceRequest,
  UpdateInsuranceRequest,
  type CreateInsuranceRequest as CreateInsuranceRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
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

type Insurance = {
  id: string;
  provider: string;
  coverage_type: string;
  starts_on: string;
  ends_on: string;
  premium_minor?: number | string | null;
  premium_currency?: string | null;
};

function formatPremium(r: Insurance): string {
  if (r.premium_minor == null || r.premium_minor === '') return '—';
  const minor = typeof r.premium_minor === 'string' ? Number(r.premium_minor) : r.premium_minor;
  if (!Number.isFinite(minor)) return '—';
  const major = (minor / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${major}${r.premium_currency ? ` ${r.premium_currency}` : ''}`;
}

export type InsuranceSectionProps = { studentId: string };

export default function InsuranceSection({ studentId }: InsuranceSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Insurance>();
  const deleteDlg = useDialogState<Insurance>();

  const queryKey = ['students', studentId, 'insurance'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/insurance`);
      return unwrapList<Insurance>(res.data);
    },
  });

  const columns: DataTableColumn<Insurance>[] = [
    { key: 'provider', label: 'Provider', render: (r) => r.provider },
    { key: 'coverage', label: 'Coverage', render: (r) => r.coverage_type },
    { key: 'starts', label: 'Starts', render: (r) => formatDate(r.starts_on) },
    { key: 'ends', label: 'Ends', render: (r) => formatDate(r.ends_on) },
    { key: 'premium', label: 'Premium', align: 'right', render: (r) => formatPremium(r) },
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

  const removeMutation = useMutation<void, ApiError, Insurance>({
    mutationFn: async (row) => {
      await api.delete(`/insurance/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Insurance policy deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ['student', studentId] });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Insurance"
        description="Health / travel insurance policies — provider, coverage and validity."
        onAdd={dlg.openCreate}
        addLabel="Add policy"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="insurance"
        onAdd={dlg.openCreate}
        addLabel="Add policy"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <InsuranceFormDialog
        key={dlg.editing?.id ?? 'new'}
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
        title="Delete insurance policy?"
        description={
          deleteDlg.editing
            ? `This will permanently remove the ${deleteDlg.editing.provider} policy.`
            : ''
        }
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

type FormValues = CreateInsuranceRequestType;

function InsuranceFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Insurance | null;
  studentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    // On edit the (encrypted) policy_number isn't returned, so it starts blank;
    // validate against the partial Update schema so a blank keeps the stored
    // number. Create still requires all fields. The keyed remount in the parent
    // re-inits this resolver when switching between add/edit.
    resolver: zodResolver(editing ? UpdateInsuranceRequest : CreateInsuranceRequest) as Resolver<FormValues>,
    defaultValues: {
      provider: '',
      policy_number: '',
      coverage_type: '',
      starts_on: '',
      ends_on: '',
      premium_currency: undefined,
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      provider: editing?.provider ?? '',
      // Encrypted at rest + excluded from the list — leave blank on edit; a
      // blank value is stripped by compactPayload so the stored number is kept.
      policy_number: '',
      coverage_type: editing?.coverage_type ?? '',
      starts_on: editing?.starts_on?.slice(0, 10) ?? '',
      ends_on: editing?.ends_on?.slice(0, 10) ?? '',
      premium_currency: (editing?.premium_currency as FormValues['premium_currency']) ?? undefined,
    });
  }, [open, editing, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      const body = compactPayload(values);
      if (editing) return api.patch(`/insurance/${editing.id}`, body);
      return api.post(`/students/${studentId}/insurance`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Insurance updated' : 'Insurance added', { variant: 'success' });
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
      title={editing ? 'Edit insurance policy' : 'Add insurance policy'}
      formId="insurance-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="insurance-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
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
          title="Policy"
          subtitle="Provider, number and coverage"
          icon={<HealthAndSafetyOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Provider"
                required
                error={Boolean(errors.provider)}
                helperText={errors.provider?.message ?? ''}
                htmlFor="ins-provider"
              >
                <TextField
                  id="ins-provider"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Bupa, Allianz Care"
                  error={Boolean(errors.provider)}
                  {...register('provider')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Policy number"
                required={!editing}
                encrypted
                error={Boolean(errors.policy_number)}
                helperText={
                  errors.policy_number?.message ??
                  (editing ? 'Leave blank to keep the stored number.' : '')
                }
                htmlFor="ins-policy"
              >
                <TextField
                  id="ins-policy"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="Policy / member number"
                  error={Boolean(errors.policy_number)}
                  {...register('policy_number')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Coverage type"
                required
                error={Boolean(errors.coverage_type)}
                helperText={errors.coverage_type?.message ?? ''}
                htmlFor="ins-coverage"
              >
                <TextField
                  id="ins-coverage"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. OSHC, IHS, private health"
                  error={Boolean(errors.coverage_type)}
                  {...register('coverage_type')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Validity & premium"
          subtitle="Coverage window and (optional) premium"
          icon={<EventOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Starts on"
                required
                error={Boolean(errors.starts_on)}
                helperText={errors.starts_on?.message ?? ''}
                htmlFor="ins-starts"
              >
                <TextField
                  id="ins-starts"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.starts_on)}
                  {...register('starts_on')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Ends on"
                required
                error={Boolean(errors.ends_on)}
                helperText={errors.ends_on?.message ?? ''}
                htmlFor="ins-ends"
              >
                <TextField
                  id="ins-ends"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.ends_on)}
                  {...register('ends_on')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Premium (minor units)"
                error={Boolean(errors.premium_minor)}
                helperText={errors.premium_minor?.message ?? 'e.g. 50000 = 500.00'}
                htmlFor="ins-premium"
              >
                <TextField
                  id="ins-premium"
                  type="number"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  inputProps={{ min: 0 }}
                  error={Boolean(errors.premium_minor)}
                  {...register('premium_minor', {
                    setValueAs: (v) => (v === '' || v == null ? undefined : v),
                  })}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Premium currency"
                error={Boolean(errors.premium_currency)}
                helperText={errors.premium_currency?.message ?? 'ISO 4217, e.g. AUD'}
                htmlFor="ins-currency"
              >
                <TextField
                  id="ins-currency"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="AUD"
                  inputProps={{ maxLength: 3, style: { textTransform: 'uppercase' } }}
                  error={Boolean(errors.premium_currency)}
                  {...register('premium_currency', {
                    setValueAs: (v) => (v === '' || v == null ? undefined : String(v).toUpperCase()),
                  })}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>
      </Box>
    </FormDialog>
  );
}
