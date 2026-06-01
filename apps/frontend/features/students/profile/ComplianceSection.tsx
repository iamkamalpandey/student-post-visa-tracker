// Refactored to SVT form-pattern (LabeledField + FormSection compact) per design pass.
'use client';

import { useEffect } from 'react';
import { Box, MenuItem, TextField, Typography } from '@mui/material';
import Grid from '@mui/material/Grid';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import EventNoteOutlinedIcon from '@mui/icons-material/EventNoteOutlined';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import {
  ComplianceTypeEnum,
  CreateComplianceRequest,
  type CreateComplianceRequest as CreateComplianceRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { formatDate, formatDateTime } from '@/lib/format';
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

const TYPE_LABELS: Record<string, string> = {
  MEDICAL_EXAM: 'Medical exam',
  BIOMETRICS: 'Biometrics',
  POLICE_CLEARANCE: 'Police clearance',
  TB_TEST: 'TB test',
  IHS_PAID: 'IHS paid',
  GTE_INTERVIEW: 'GTE interview',
  OTHER: 'Other',
};

type Compliance = {
  id: string;
  check_type: string;
  scheduled_at?: string | null;
  completed_at?: string | null;
  result?: string | null;
  expires_on?: string | null;
  document_id?: string | null;
  notes?: string | null;
};

export type ComplianceSectionProps = { studentId: string };

export default function ComplianceSection({ studentId }: ComplianceSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Compliance>();
  const deleteDlg = useDialogState<Compliance>();

  const queryKey = ['students', studentId, 'compliance'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/compliance`);
      return unwrapList<Compliance>(res.data);
    },
  });

  const columns: DataTableColumn<Compliance>[] = [
    {
      key: 'type',
      label: 'Check',
      render: (r) => TYPE_LABELS[r.check_type] ?? r.check_type,
    },
    { key: 'scheduled', label: 'Scheduled', render: (r) => formatDateTime(r.scheduled_at ?? '') },
    { key: 'completed', label: 'Completed', render: (r) => formatDateTime(r.completed_at ?? '') },
    { key: 'result', label: 'Result', render: (r) => r.result ?? '—' },
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

  const removeMutation = useMutation<void, ApiError, Compliance>({
    mutationFn: async (row) => {
      await api.delete(`/compliance/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Compliance check deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Compliance"
        description="Medical, biometric and police-clearance checks required for the visa."
        onAdd={dlg.openCreate}
        addLabel="Add check"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="compliance checks"
        onAdd={dlg.openCreate}
        addLabel="Add check"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <ComplianceFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey })}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete compliance record?"
        description="This permanently removes the check from the student's compliance log."
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

type FormValues = CreateComplianceRequestType;

function toLocalDateTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  // datetime-local needs YYYY-MM-DDTHH:mm with no timezone suffix.
  const pad = (n: number) => `${n}`.padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ComplianceFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Compliance | null;
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
    resolver: zodResolver(CreateComplianceRequest),
    defaultValues: {
      check_type: 'MEDICAL_EXAM',
      scheduled_at: undefined,
      completed_at: undefined,
      result: '',
      expires_on: undefined,
      notes: '',
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      check_type: (editing?.check_type as FormValues['check_type']) ?? 'MEDICAL_EXAM',
      scheduled_at: toLocalDateTime(editing?.scheduled_at) || undefined,
      completed_at: toLocalDateTime(editing?.completed_at) || undefined,
      result: editing?.result ?? '',
      expires_on: editing?.expires_on?.slice(0, 10),
      notes: editing?.notes ?? '',
    });
  }, [open, editing, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (raw) => {
      const values: Record<string, unknown> = { ...raw };
      // datetime-local strings are local; convert to ISO with offset.
      for (const k of ['scheduled_at', 'completed_at']) {
        const v = values[k] as string | undefined;
        if (v) values[k] = new Date(v).toISOString();
      }
      const body = compactPayload(values);
      if (editing) return api.patch(`/compliance/${editing.id}`, body);
      return api.post(`/students/${studentId}/compliance`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Compliance updated' : 'Compliance added', { variant: 'success' });
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
      title={editing ? 'Edit compliance check' : 'Add compliance check'}
      formId="compliance-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="compliance-form"
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
          title="Check"
          subtitle="What was checked and the outcome"
          icon={<RuleOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12}>
              <LabeledField
                label="Check type"
                required
                error={Boolean(errors.check_type)}
                helperText={errors.check_type?.message ?? ''}
                htmlFor="cp-type"
              >
                <Controller
                  name="check_type"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      id="cp-type"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.check_type)}
                      {...field}
                    >
                      {ComplianceTypeEnum.options.map((o) => (
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
                label="Result"
                error={Boolean(errors.result)}
                helperText={errors.result?.message ?? ''}
                htmlFor="cp-result"
              >
                <TextField
                  id="cp-result"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="e.g. Pass"
                  error={Boolean(errors.result)}
                  {...register('result')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Timing"
          subtitle="Scheduled, completed and expiry"
          icon={<EventNoteOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Scheduled at"
                error={Boolean(errors.scheduled_at)}
                helperText={errors.scheduled_at?.message ?? ''}
                htmlFor="cp-sched"
              >
                <TextField
                  id="cp-sched"
                  type="datetime-local"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.scheduled_at)}
                  {...register('scheduled_at')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Completed at"
                error={Boolean(errors.completed_at)}
                helperText={errors.completed_at?.message ?? ''}
                htmlFor="cp-done"
              >
                <TextField
                  id="cp-done"
                  type="datetime-local"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.completed_at)}
                  {...register('completed_at')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Expires on"
                error={Boolean(errors.expires_on)}
                helperText={errors.expires_on?.message ?? ''}
                htmlFor="cp-exp"
              >
                <TextField
                  id="cp-exp"
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
            htmlFor="cp-notes"
          >
            <TextField
              id="cp-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={2}
              placeholder="e.g. Receipt scan in Drive folder."
              error={Boolean(errors.notes)}
              {...register('notes')}
            />
          </LabeledField>
        </FormSection>
      </Box>
    </FormDialog>
  );
}
