// Refactored to SVT form-pattern (LabeledField + FormSection compact) per design pass.
'use client';

import { useEffect } from 'react';
import { Box, Chip, Stack, Switch, TextField, Typography } from '@mui/material';
import Grid from '@mui/material/Grid';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import EventAvailableOutlinedIcon from '@mui/icons-material/EventAvailableOutlined';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import {
  CreateEngagementRequest,
  type CreateEngagementRequest as CreateEngagementRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
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

type Engagement = {
  id: string;
  check_date: string;
  method: string;
  present: boolean;
  notes?: string | null;
  recorded_by_id: string;
};

export type EngagementsSectionProps = { studentId: string };

export default function EngagementsSection({ studentId }: EngagementsSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Engagement>();
  const deleteDlg = useDialogState<Engagement>();

  const queryKey = ['students', studentId, 'engagements'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/engagements`);
      return unwrapList<Engagement>(res.data);
    },
  });

  const columns: DataTableColumn<Engagement>[] = [
    { key: 'date', label: 'Date', render: (r) => formatDate(r.check_date) },
    { key: 'method', label: 'Method', render: (r) => r.method },
    {
      key: 'present',
      label: 'Present',
      render: (r) =>
        r.present ? (
          <Chip size="small" color="success" label="Present" />
        ) : (
          <Chip size="small" color="warning" label="Missed" />
        ),
    },
    { key: 'notes', label: 'Notes', render: (r) => r.notes ?? '—' },
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

  const removeMutation = useMutation<void, ApiError, Engagement>({
    mutationFn: async (row) => {
      await api.delete(`/engagements/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Engagement deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Engagement check-ins"
        description="UKVI / sponsor engagement records confirming the student is present and active."
        onAdd={dlg.openCreate}
        addLabel="Add check-in"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="engagement check-ins"
        onAdd={dlg.openCreate}
        addLabel="Add check-in"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <EngagementFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey })}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete engagement?"
        description="This permanently removes the check-in record."
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

type FormValues = CreateEngagementRequestType;

function EngagementFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Engagement | null;
  studentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const { user } = useAuth();

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(CreateEngagementRequest),
    defaultValues: {
      check_date: '',
      method: '',
      present: true,
      notes: '',
      recorded_by_id: '',
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      check_date: editing?.check_date?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
      method: editing?.method ?? '',
      present: editing?.present ?? true,
      notes: editing?.notes ?? '',
      recorded_by_id: editing?.recorded_by_id ?? user?.id ?? '',
    });
  }, [open, editing, reset, user?.id]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      const body = compactPayload(values);
      if (editing) return api.patch(`/engagements/${editing.id}`, body);
      return api.post(`/students/${studentId}/engagements`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Engagement updated' : 'Engagement added', { variant: 'success' });
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
      title={editing ? 'Edit engagement' : 'Add engagement'}
      formId="engagement-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="engagement-form"
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
          title="Check-in"
          subtitle="When and how the student was contacted"
          icon={<EventAvailableOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Check date"
                required
                error={Boolean(errors.check_date)}
                helperText={errors.check_date?.message ?? ''}
                htmlFor="en-date"
              >
                <TextField
                  id="en-date"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.check_date)}
                  {...register('check_date')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Method"
                required
                error={Boolean(errors.method)}
                helperText={errors.method?.message ?? ''}
                htmlFor="en-method"
              >
                <TextField
                  id="en-method"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="In-person / Phone / Email"
                  error={Boolean(errors.method)}
                  {...register('method')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Controller
                  name="present"
                  control={control}
                  render={({ field }) => (
                    <Switch
                      checked={Boolean(field.value)}
                      onChange={(e) => field.onChange(e.target.checked)}
                    />
                  )}
                />
                <Typography variant="body2">Student present</Typography>
              </Stack>
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
            htmlFor="en-notes"
          >
            <TextField
              id="en-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={2}
              placeholder="e.g. Student attending all classes; no concerns."
              error={Boolean(errors.notes)}
              {...register('notes')}
            />
          </LabeledField>
        </FormSection>
      </Box>
    </FormDialog>
  );
}
