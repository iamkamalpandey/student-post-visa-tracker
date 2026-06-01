'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect } from 'react';
import { Box, TextField, Typography } from '@mui/material';
import LabeledField from '@/components/LabeledField';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  CreateEmploymentRequest,
  type CreateEmploymentRequest as CreateEmploymentRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
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

type Employment = {
  id: string;
  employer_name: string;
  employer_address_id?: string | null;
  work_type: string;
  hours_per_week?: number | null;
  started_on: string;
  ended_on?: string | null;
  authorisation_doc_id?: string | null;
  notes?: string | null;
};

export type EmploymentSectionProps = { studentId: string };

export default function EmploymentSection({ studentId }: EmploymentSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Employment>();
  const deleteDlg = useDialogState<Employment>();

  const queryKey = ['students', studentId, 'employment'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/employment`);
      return unwrapList<Employment>(res.data);
    },
  });

  const columns: DataTableColumn<Employment>[] = [
    { key: 'employer', label: 'Employer', render: (r) => r.employer_name },
    { key: 'type', label: 'Type', render: (r) => r.work_type },
    {
      key: 'hours',
      label: 'Hours / wk',
      render: (r) => (r.hours_per_week != null ? String(r.hours_per_week) : '—'),
    },
    { key: 'started', label: 'Started', render: (r) => formatDate(r.started_on) },
    { key: 'ended', label: 'Ended', render: (r) => formatDate(r.ended_on ?? '') },
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

  const removeMutation = useMutation<void, ApiError, Employment>({
    mutationFn: async (row) => {
      await api.delete(`/employment/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Employment record deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Employment"
        description="Work-rights tracking — part-time and post-study employment."
        onAdd={dlg.openCreate}
        addLabel="Add employment"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="employment"
        onAdd={dlg.openCreate}
        addLabel="Add employment"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <EmploymentFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey })}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete employment record?"
        description="This permanently removes the employment record."
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

type FormValues = CreateEmploymentRequestType;

function EmploymentFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Employment | null;
  studentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(CreateEmploymentRequest),
    defaultValues: {
      employer_name: '',
      work_type: '',
      started_on: '',
      notes: '',
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      employer_name: editing?.employer_name ?? '',
      work_type: editing?.work_type ?? '',
      hours_per_week: editing?.hours_per_week ?? undefined,
      started_on: editing?.started_on?.slice(0, 10) ?? '',
      ended_on: editing?.ended_on?.slice(0, 10),
      notes: editing?.notes ?? '',
    });
  }, [open, editing, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (raw) => {
      const values: Record<string, unknown> = { ...raw };
      // The hours_per_week input arrives as a string; coerce to number.
      const hpw = values['hours_per_week'];
      if (typeof hpw === 'string' && hpw !== '') values['hours_per_week'] = Number(hpw);
      else if (hpw === '' || hpw == null) delete values['hours_per_week'];
      const body = compactPayload(values);
      if (editing) return api.patch(`/employment/${editing.id}`, body);
      return api.post(`/students/${studentId}/employment`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Employment updated' : 'Employment added', { variant: 'success' });
      onSaved();
      onClose();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));

  return (
    <FormDialog
      open={open}
      title={editing ? 'Edit employment' : 'Add employment'}
      formId="employment-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="employment-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          // Standardise input heights to 44px so date, text, number all line
          // up vertically. Multiline (notes) is excluded so it can grow.
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
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
              label="Employer"
              required
              error={Boolean(errors.employer_name)}
              helperText={errors.employer_name?.message ?? ''}
              htmlFor="emp-name"
            >
              <TextField
                id="emp-name"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. Acme Pty Ltd"
                error={Boolean(errors.employer_name)}
                {...register('employer_name')}
              />
            </LabeledField>
          </Box>
          <LabeledField
            label="Work type"
            required
            error={Boolean(errors.work_type)}
            helperText={errors.work_type?.message ?? ''}
            htmlFor="emp-type"
          >
            <TextField
              id="emp-type"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="Part-time / Internship / Graduate"
              error={Boolean(errors.work_type)}
              {...register('work_type')}
            />
          </LabeledField>
          <LabeledField
            label="Hours per week"
            error={Boolean(errors.hours_per_week)}
            helperText={errors.hours_per_week?.message ?? ''}
            htmlFor="emp-hours"
          >
            <TextField
              id="emp-hours"
              type="number"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="20"
              inputProps={{ min: 0, max: 168, step: 1 }}
              error={Boolean(errors.hours_per_week)}
              {...register('hours_per_week')}
            />
          </LabeledField>
          <LabeledField
            label="Started on"
            required
            error={Boolean(errors.started_on)}
            helperText={errors.started_on?.message ?? ''}
            htmlFor="emp-start"
          >
            <TextField
              id="emp-start"
              type="date"
              fullWidth
              size="medium"
              hiddenLabel
              error={Boolean(errors.started_on)}
              {...register('started_on')}
            />
          </LabeledField>
          <LabeledField
            label="Ended on"
            error={Boolean(errors.ended_on)}
            helperText={errors.ended_on?.message ?? ''}
            htmlFor="emp-end"
          >
            <TextField
              id="emp-end"
              type="date"
              fullWidth
              size="medium"
              hiddenLabel
              error={Boolean(errors.ended_on)}
              {...register('ended_on')}
            />
          </LabeledField>
          <Box sx={{ gridColumn: { sm: '1 / -1' } }}>
            <LabeledField
              label="Notes"
              error={Boolean(errors.notes)}
              helperText={errors.notes?.message ?? ''}
              htmlFor="emp-notes"
            >
              <TextField
                id="emp-notes"
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
  );
}
