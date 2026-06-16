// Refactored to SVT form-pattern (LabeledField + FormSection compact) per design pass.
'use client';

import { useEffect } from 'react';
import { Box, Chip, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import Grid from '@mui/material/Grid';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import VerifiedOutlinedIcon from '@mui/icons-material/VerifiedOutlined';
import EventOutlinedIcon from '@mui/icons-material/EventOutlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import {
  CreateVisaRequest,
  VisaEntriesEnum,
  type CreateVisaRequest as CreateVisaRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { useCountries, useVisaCategories } from '@/lib/queries';
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
  maskDocNumber,
  unwrapList,
  useCanWrite,
  useDialogState,
} from '../sectionShared';

type Visa = {
  id: string;
  visa_category_id: string;
  visa_number_enc?: string | null;
  visa_number?: string | null;
  visa_number_masked?: string | null;
  destination_country: string;
  issuing_post?: string | null;
  issued_on: string;
  expires_on: string;
  entries: 'SINGLE' | 'DOUBLE' | 'MULTIPLE';
  conditions?: string | null;
  is_active: boolean;
};

export type VisasSectionProps = { studentId: string };

export default function VisasSection({ studentId }: VisasSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Visa>();
  const deleteDlg = useDialogState<Visa>();

  const queryKey = ['students', studentId, 'visas'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/visas`);
      return unwrapList<Visa>(res.data);
    },
  });

  const columns: DataTableColumn<Visa>[] = [
    {
      key: 'destination',
      label: 'Destination',
      render: (r) => (
        <Stack direction="row" spacing={0.75} alignItems="center">
          <span>{r.destination_country}</span>
          {r.is_active ? <Chip size="small" label="Active" color="success" /> : null}
        </Stack>
      ),
    },
    {
      key: 'visa_no',
      label: 'Visa number',
      render: (r) => r.visa_number_masked ?? maskDocNumber(r.visa_number ?? r.visa_number_enc),
    },
    { key: 'entries', label: 'Entries', render: (r) => r.entries },
    { key: 'issued', label: 'Issued', render: (r) => formatDate(r.issued_on) },
    { key: 'expires', label: 'Expires', render: (r) => formatDate(r.expires_on) },
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

  const removeMutation = useMutation<void, ApiError, Visa>({
    mutationFn: async (row) => {
      await api.delete(`/visas/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Visa deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      // SVT-SYNC-2026-06: visa is a completeness key — refresh parent student detail.
      qc.invalidateQueries({ queryKey: ['student', studentId] });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Visas"
        description="Issued entry visas with category, validity window and conditions."
        onAdd={dlg.openCreate}
        addLabel="Add visa"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="visas"
        onAdd={dlg.openCreate}
        addLabel="Add visa"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <VisaFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => {
          qc.invalidateQueries({ queryKey });
          // SVT-SYNC-2026-06: visa is a completeness key — refresh parent student detail.
          qc.invalidateQueries({ queryKey: ['student', studentId] });
        }}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete visa?"
        description="This permanently removes the visa record from this student's profile."
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

type FormValues = CreateVisaRequestType;

function VisaFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Visa | null;
  studentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const countries = useCountries();

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(CreateVisaRequest),
    defaultValues: {
      visa_category_id: '',
      visa_number: '',
      destination_country: '',
      issuing_post: '',
      issued_on: '',
      expires_on: '',
      entries: 'MULTIPLE',
      conditions: '',
      is_active: true,
    },
  });

  const destination = useWatch({ control, name: 'destination_country' });
  const visaCategories = useVisaCategories(destination || undefined);

  useEffect(() => {
    if (!open) return;
    reset({
      visa_category_id: editing?.visa_category_id ?? '',
      visa_number: editing?.visa_number ?? '',
      destination_country: editing?.destination_country ?? '',
      issuing_post: editing?.issuing_post ?? '',
      issued_on: editing?.issued_on?.slice(0, 10) ?? '',
      expires_on: editing?.expires_on?.slice(0, 10) ?? '',
      entries: editing?.entries ?? 'MULTIPLE',
      conditions: editing?.conditions ?? '',
      is_active: editing?.is_active ?? true,
    });
  }, [open, editing, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      const body = compactPayload(values);
      if (editing) return api.patch(`/visas/${editing.id}`, body);
      return api.post(`/students/${studentId}/visas`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Visa updated' : 'Visa added', { variant: 'success' });
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
      title={editing ? 'Edit visa' : 'Add visa'}
      formId="visa-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="visa-form"
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
          title="Visa"
          subtitle="Destination, category and document number"
          icon={<VerifiedOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Destination country"
                required
                error={Boolean(errors.destination_country)}
                helperText={errors.destination_country?.message ?? ''}
                htmlFor="vs-dest"
              >
                <Controller
                  name="destination_country"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="vs-dest"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.destination_country)}
                      value={field.value ?? ''}
                      onChange={field.onChange}
                    >
                      {(countries.data ?? []).map((c) => (
                        <MenuItem key={c.code_alpha2} value={c.code_alpha2}>
                          {c.name} ({c.code_alpha2})
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Visa category"
                required
                error={Boolean(errors.visa_category_id)}
                helperText={
                  errors.visa_category_id?.message ??
                  (destination ? '' : 'Select a destination country first.')
                }
                htmlFor="vs-cat"
              >
                <Controller
                  name="visa_category_id"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="vs-cat"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      disabled={!destination}
                      error={Boolean(errors.visa_category_id)}
                      value={field.value ?? ''}
                      onChange={field.onChange}
                    >
                      {(visaCategories.data ?? []).map((c) => (
                        <MenuItem key={c.code} value={c.code}>
                          {c.label} ({c.code})
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Visa number"
                required
                encrypted
                error={Boolean(errors.visa_number)}
                helperText={errors.visa_number?.message ?? ''}
                htmlFor="vs-num"
              >
                <TextField
                  id="vs-num"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. UKB1234567"
                  error={Boolean(errors.visa_number)}
                  {...register('visa_number')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Issuing post"
                error={Boolean(errors.issuing_post)}
                helperText={errors.issuing_post?.message ?? ''}
                htmlFor="vs-post"
              >
                <TextField
                  id="vs-post"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. London"
                  error={Boolean(errors.issuing_post)}
                  {...register('issuing_post')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Entries"
                error={Boolean(errors.entries)}
                helperText={errors.entries?.message ?? ''}
                htmlFor="vs-ent"
              >
                <Controller
                  name="entries"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="vs-ent"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.entries)}
                      {...field}
                    >
                      {VisaEntriesEnum.options.map((o) => (
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
              <Stack direction="row" alignItems="center" spacing={1} sx={{ height: '100%' }}>
                <Controller
                  name="is_active"
                  control={control}
                  render={({ field }) => (
                    <Switch
                      checked={Boolean(field.value)}
                      onChange={(e) => field.onChange(e.target.checked)}
                    />
                  )}
                />
                <Typography variant="body2">Active</Typography>
              </Stack>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Validity"
          subtitle="When the visa was issued and expires"
          icon={<EventOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Issued on"
                required
                error={Boolean(errors.issued_on)}
                helperText={errors.issued_on?.message ?? ''}
                htmlFor="vs-issued"
              >
                <TextField
                  id="vs-issued"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.issued_on)}
                  {...register('issued_on')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Expires on"
                required
                error={Boolean(errors.expires_on)}
                helperText={errors.expires_on?.message ?? ''}
                htmlFor="vs-expires"
              >
                <TextField
                  id="vs-expires"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.expires_on)}
                  {...register('expires_on')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Conditions"
          subtitle="Endorsements or restrictions printed on the visa"
          icon={<RuleOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <LabeledField
            label="Conditions"
            error={Boolean(errors.conditions)}
            helperText={errors.conditions?.message ?? ''}
            htmlFor="vs-cond"
          >
            <TextField
              id="vs-cond"
              fullWidth
              hiddenLabel
              multiline
              minRows={2}
              placeholder="e.g. No work; ATAS clearance required"
              error={Boolean(errors.conditions)}
              {...register('conditions')}
            />
          </LabeledField>
        </FormSection>
      </Box>
    </FormDialog>
  );
}
