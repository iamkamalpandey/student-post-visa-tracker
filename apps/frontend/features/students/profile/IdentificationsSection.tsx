// Refactored to SVT form-pattern (LabeledField + FormSection compact) per design pass.
'use client';

import { useEffect } from 'react';
import { Box, Chip, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import Grid from '@mui/material/Grid';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import BadgeOutlinedIcon from '@mui/icons-material/BadgeOutlined';
import EventOutlinedIcon from '@mui/icons-material/EventOutlined';
import {
  CreateIdentificationRequest,
  IdTypeEnum,
  type CreateIdentificationRequest as CreateIdentificationRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { useCountries } from '@/lib/queries';
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

const ID_TYPE_LABELS: Record<string, string> = {
  PASSPORT: 'Passport',
  NATIONAL_ID: 'National ID',
  BIRTH_CERTIFICATE: 'Birth certificate',
  DRIVING_LICENCE: 'Driving licence',
  OTHER: 'Other',
};

type Identification = {
  id: string;
  type: string;
  document_number_enc?: string | null;
  document_number?: string | null;
  document_number_masked?: string | null;
  issuing_country: string;
  issued_on: string;
  expires_on?: string | null;
  is_primary: boolean;
};

export type IdentificationsSectionProps = { studentId: string };

export default function IdentificationsSection({ studentId }: IdentificationsSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Identification>();
  const deleteDlg = useDialogState<Identification>();

  const queryKey = ['students', studentId, 'identifications'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/identifications`);
      return unwrapList<Identification>(res.data);
    },
  });

  const columns: DataTableColumn<Identification>[] = [
    {
      key: 'type',
      label: 'Type',
      render: (r) => (
        <Stack direction="row" spacing={0.75} alignItems="center">
          <span>{ID_TYPE_LABELS[r.type] ?? r.type}</span>
          {r.is_primary ? <Chip size="small" label="Primary" color="primary" /> : null}
        </Stack>
      ),
    },
    {
      key: 'doc',
      label: 'Document number',
      render: (r) =>
        r.document_number_masked ?? maskDocNumber(r.document_number ?? r.document_number_enc),
    },
    { key: 'country', label: 'Issuing country', render: (r) => r.issuing_country },
    { key: 'issued', label: 'Issued', render: (r) => formatDate(r.issued_on) },
    { key: 'expires', label: 'Expires', render: (r) => formatDate(r.expires_on ?? '') },
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

  const removeMutation = useMutation<void, ApiError, Identification>({
    mutationFn: async (row) => {
      await api.delete(`/identifications/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Identification deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      qc.invalidateQueries({ queryKey: ['student', studentId] });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Identifications"
        description="Passport scans, national IDs and other government-issued documents."
        onAdd={dlg.openCreate}
        addLabel="Add identification"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="identifications"
        onAdd={dlg.openCreate}
        addLabel="Add identification"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <IdentificationFormDialog
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
        title="Delete identification?"
        description={
          deleteDlg.editing
            ? `This will permanently remove the ${ID_TYPE_LABELS[deleteDlg.editing.type] ?? 'document'} record.`
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

type FormValues = CreateIdentificationRequestType;

function IdentificationFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Identification | null;
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
    resolver: zodResolver(CreateIdentificationRequest),
    defaultValues: {
      type: 'PASSPORT',
      document_number: '',
      issuing_country: '',
      issued_on: '',
      expires_on: undefined,
      is_primary: false,
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      type: (editing?.type as FormValues['type']) ?? 'PASSPORT',
      document_number: editing?.document_number ?? '',
      issuing_country: editing?.issuing_country ?? '',
      issued_on: editing?.issued_on?.slice(0, 10) ?? '',
      expires_on: editing?.expires_on?.slice(0, 10),
      is_primary: editing?.is_primary ?? false,
    });
  }, [open, editing, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      const body = compactPayload(values);
      if (editing) return api.patch(`/identifications/${editing.id}`, body);
      return api.post(`/students/${studentId}/identifications`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Identification updated' : 'Identification added', {
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
      title={editing ? 'Edit identification' : 'Add identification'}
      formId="identification-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="identification-form"
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
          title="Document"
          subtitle="Type, number and issuing authority"
          icon={<BadgeOutlinedIcon />}
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
                htmlFor="id-type"
              >
                <Controller
                  name="type"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="id-type"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.type)}
                      {...field}
                    >
                      {IdTypeEnum.options.map((o) => (
                        <MenuItem key={o} value={o}>
                          {ID_TYPE_LABELS[o] ?? o}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Document number"
                required
                encrypted
                error={Boolean(errors.document_number)}
                helperText={errors.document_number?.message ?? ''}
                htmlFor="id-doc"
              >
                <TextField
                  id="id-doc"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. P1234567"
                  error={Boolean(errors.document_number)}
                  {...register('document_number')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Issuing country"
                required
                error={Boolean(errors.issuing_country)}
                helperText={errors.issuing_country?.message ?? ''}
                htmlFor="id-country"
              >
                <Controller
                  name="issuing_country"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="id-country"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.issuing_country)}
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
              <Stack direction="row" alignItems="center" spacing={1} sx={{ height: '100%' }}>
                <Controller
                  name="is_primary"
                  control={control}
                  render={({ field }) => (
                    <Switch
                      checked={Boolean(field.value)}
                      onChange={(e) => field.onChange(e.target.checked)}
                    />
                  )}
                />
                <Typography variant="body2">Primary identity document</Typography>
              </Stack>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Validity"
          subtitle="When the document was issued and expires"
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
                htmlFor="id-issued"
              >
                <TextField
                  id="id-issued"
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
                error={Boolean(errors.expires_on)}
                helperText={errors.expires_on?.message ?? ''}
                htmlFor="id-expires"
              >
                <TextField
                  id="id-expires"
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
      </Box>
    </FormDialog>
  );
}
