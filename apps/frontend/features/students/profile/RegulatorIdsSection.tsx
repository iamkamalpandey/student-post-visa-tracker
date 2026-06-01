// Refactored to SVT form-pattern (LabeledField + FormSection compact) per design pass.
'use client';

import { useEffect } from 'react';
import { Box, MenuItem, TextField, Typography } from '@mui/material';
import Grid from '@mui/material/Grid';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import FingerprintOutlinedIcon from '@mui/icons-material/FingerprintOutlined';
import EventOutlinedIcon from '@mui/icons-material/EventOutlined';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import {
  CreateRegulatorIdRequest,
  type CreateRegulatorIdRequest as CreateRegulatorIdRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
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

const SCHEME_OPTIONS = ['SEVIS', 'CAS', 'COE', 'IRCC_UCI', 'GTE', 'OTHER'] as const;
const STATUS_OPTIONS = ['ACTIVE', 'PENDING', 'EXPIRED', 'CANCELLED'] as const;

type RegulatorId = {
  id: string;
  scheme: string;
  value: string;
  issued_on?: string | null;
  expires_on?: string | null;
  status?: string | null;
  notes?: string | null;
};

export type RegulatorIdsSectionProps = { studentId: string };

export default function RegulatorIdsSection({ studentId }: RegulatorIdsSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<RegulatorId>();
  const deleteDlg = useDialogState<RegulatorId>();

  const queryKey = ['students', studentId, 'regulator-ids'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/regulator-ids`);
      return unwrapList<RegulatorId>(res.data);
    },
  });

  const columns: DataTableColumn<RegulatorId>[] = [
    { key: 'scheme', label: 'Scheme', render: (r) => r.scheme },
    { key: 'value', label: 'Identifier', render: (r) => r.value },
    { key: 'status', label: 'Status', render: (r) => <StatusChip status={r.status} /> },
    { key: 'issued', label: 'Issued', render: (r) => formatDate(r.issued_on ?? '') },
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

  const removeMutation = useMutation<void, ApiError, RegulatorId>({
    mutationFn: async (row) => {
      await api.delete(`/regulator-ids/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Regulator ID deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Regulator IDs"
        description="External tracking numbers issued by destination-country regulators."
        onAdd={dlg.openCreate}
        addLabel="Add regulator ID"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="regulator IDs"
        onAdd={dlg.openCreate}
        addLabel="Add regulator ID"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <RegulatorIdFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey })}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete regulator ID?"
        description="This permanently removes the regulator identifier."
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

type FormValues = CreateRegulatorIdRequestType;

function RegulatorIdFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: RegulatorId | null;
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
    resolver: zodResolver(CreateRegulatorIdRequest),
    defaultValues: {
      scheme: 'SEVIS',
      value: '',
      issued_on: undefined,
      expires_on: undefined,
      status: 'ACTIVE',
      notes: '',
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      scheme: editing?.scheme ?? 'SEVIS',
      value: editing?.value ?? '',
      issued_on: editing?.issued_on?.slice(0, 10),
      expires_on: editing?.expires_on?.slice(0, 10),
      status: editing?.status ?? 'ACTIVE',
      notes: editing?.notes ?? '',
    });
  }, [open, editing, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      const body = compactPayload(values);
      if (editing) return api.patch(`/regulator-ids/${editing.id}`, body);
      return api.post(`/students/${studentId}/regulator-ids`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Regulator ID updated' : 'Regulator ID added', {
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
      title={editing ? 'Edit regulator ID' : 'Add regulator ID'}
      formId="regulator-id-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="regulator-id-form"
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
          title="Identifier"
          subtitle="Scheme and value"
          icon={<FingerprintOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Scheme"
                required
                error={Boolean(errors.scheme)}
                helperText={errors.scheme?.message ?? ''}
                htmlFor="ri-scheme"
              >
                <Controller
                  name="scheme"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="ri-scheme"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.scheme)}
                      {...field}
                    >
                      {SCHEME_OPTIONS.map((o) => (
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
                label="Identifier value"
                required
                encrypted
                error={Boolean(errors.value)}
                helperText={errors.value?.message ?? ''}
                htmlFor="ri-value"
              >
                <TextField
                  id="ri-value"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. N0012345678"
                  error={Boolean(errors.value)}
                  {...register('value')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Status"
                error={Boolean(errors.status)}
                helperText={errors.status?.message ?? ''}
                htmlFor="ri-status"
              >
                <Controller
                  name="status"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="ri-status"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.status)}
                      value={field.value ?? ''}
                      onChange={field.onChange}
                    >
                      {STATUS_OPTIONS.map((o) => (
                        <MenuItem key={o} value={o}>
                          {o}
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
          title="Validity"
          subtitle="When the identifier was issued and expires"
          icon={<EventOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Issued on"
                error={Boolean(errors.issued_on)}
                helperText={errors.issued_on?.message ?? ''}
                htmlFor="ri-issued"
              >
                <TextField
                  id="ri-issued"
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
                htmlFor="ri-expires"
              >
                <TextField
                  id="ri-expires"
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
          title="Notes"
          subtitle="Internal commentary"
          icon={<StickyNote2OutlinedIcon />}
          iconColor="muted"
          compact
        >
          <LabeledField
            label="Notes"
            error={Boolean(errors.notes)}
            helperText={errors.notes?.message ?? ''}
            htmlFor="ri-notes"
          >
            <TextField
              id="ri-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={2}
              placeholder="e.g. Confirmation email saved in Drive."
              error={Boolean(errors.notes)}
              {...register('notes')}
            />
          </LabeledField>
        </FormSection>
      </Box>
    </FormDialog>
  );
}
