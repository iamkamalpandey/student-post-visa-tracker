'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect } from 'react';
import { Box, Chip, MenuItem, Stack, Switch, TextField, Typography } from '@mui/material';
import LabeledField from '@/components/LabeledField';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  AcademicLevelEnum,
  CreateQualificationRequest,
  type CreateQualificationRequest as CreateQualificationRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { useCountries, useIscedFields } from '@/lib/queries';
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

const LEVEL_LABELS: Record<string, string> = {
  PRIMARY: 'Primary',
  LOWER_SECONDARY: 'Lower secondary',
  UPPER_SECONDARY: 'Upper secondary',
  POST_SECONDARY_NON_TERTIARY: 'Post-secondary',
  FOUNDATION: 'Foundation',
  ASSOCIATE: 'Associate',
  DIPLOMA: 'Diploma',
  ADVANCED_DIPLOMA: 'Advanced diploma',
  BACHELORS: "Bachelor's",
  GRADUATE_CERTIFICATE: 'Graduate certificate',
  GRADUATE_DIPLOMA: 'Graduate diploma',
  POSTGRADUATE_CERTIFICATE: 'Postgraduate certificate',
  POSTGRADUATE_DIPLOMA: 'Postgraduate diploma',
  MASTERS: "Master's",
  MPHIL: 'MPhil',
  DOCTORATE: 'Doctorate (PhD)',
  PROFESSIONAL: 'Professional',
  CERTIFICATE: 'Certificate',
  OTHER: 'Other',
};

type Qualification = {
  id: string;
  level: string;
  institution: string;
  board_or_university?: string | null;
  country_code?: string | null;
  field_of_study?: string | null;
  isced_code?: string | null;
  started_on?: string | null;
  completed_on?: string | null;
  grade_value?: string | null;
  grade_scale?: string | null;
  is_highest: boolean;
};

export type QualificationsSectionProps = { studentId: string };

export default function QualificationsSection({ studentId }: QualificationsSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Qualification>();
  const deleteDlg = useDialogState<Qualification>();

  const queryKey = ['students', studentId, 'qualifications'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/qualifications`);
      return unwrapList<Qualification>(res.data);
    },
  });

  const columns: DataTableColumn<Qualification>[] = [
    {
      key: 'level',
      label: 'Level',
      render: (r) => (
        <Stack direction="row" spacing={0.75} alignItems="center">
          <span>{LEVEL_LABELS[r.level] ?? r.level}</span>
          {r.is_highest ? <Chip size="small" label="Highest" color="primary" /> : null}
        </Stack>
      ),
    },
    { key: 'institution', label: 'Institution', render: (r) => r.institution },
    { key: 'field', label: 'Field', render: (r) => r.field_of_study ?? '—' },
    {
      key: 'grade',
      label: 'Grade',
      render: (r) =>
        r.grade_value ? `${r.grade_value}${r.grade_scale ? ` / ${r.grade_scale}` : ''}` : '—',
    },
    { key: 'completed', label: 'Completed', render: (r) => formatDate(r.completed_on ?? '') },
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

  const removeMutation = useMutation<void, ApiError, Qualification>({
    mutationFn: async (row) => {
      await api.delete(`/qualifications/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Qualification deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Qualifications"
        description="Academic history from secondary school through to current degree."
        onAdd={dlg.openCreate}
        addLabel="Add qualification"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="qualifications"
        onAdd={dlg.openCreate}
        addLabel="Add qualification"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <QualificationFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey })}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete qualification?"
        description="This permanently removes the qualification record."
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

type FormValues = CreateQualificationRequestType;

function QualificationFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Qualification | null;
  studentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const countries = useCountries();
  const iscedFields = useIscedFields();

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(CreateQualificationRequest),
    defaultValues: {
      level: 'BACHELORS',
      institution: '',
      board_or_university: '',
      country_code: undefined,
      field_of_study: '',
      isced_code: undefined,
      started_on: undefined,
      completed_on: undefined,
      grade_value: '',
      grade_scale: '',
      is_highest: false,
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      level: (editing?.level as FormValues['level']) ?? 'BACHELORS',
      institution: editing?.institution ?? '',
      board_or_university: editing?.board_or_university ?? '',
      country_code: editing?.country_code ?? undefined,
      field_of_study: editing?.field_of_study ?? '',
      isced_code: editing?.isced_code ?? undefined,
      started_on: editing?.started_on?.slice(0, 10),
      completed_on: editing?.completed_on?.slice(0, 10),
      grade_value: editing?.grade_value ?? '',
      grade_scale: editing?.grade_scale ?? '',
      is_highest: editing?.is_highest ?? false,
    });
  }, [open, editing, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      const body = compactPayload(values);
      if (editing) return api.patch(`/qualifications/${editing.id}`, body);
      return api.post(`/students/${studentId}/qualifications`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Qualification updated' : 'Qualification added', {
        variant: 'success',
      });
      onSaved();
      onClose();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));

  return (
    <FormDialog
      open={open}
      title={editing ? 'Edit qualification' : 'Add qualification'}
      formId="qualification-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="qualification-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          // Standardise input heights to 44px so date, text, select all line
          // up vertically — matches the SVT form pattern.
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
          <LabeledField
            label="Level"
            required
            error={Boolean(errors.level)}
            helperText={errors.level?.message ?? ''}
            htmlFor="ql-level"
          >
            <Controller
              name="level"
              control={control}
              render={({ field }) => (
                <TextField
                  id="ql-level"
                  select
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.level)}
                  {...field}
                >
                  {AcademicLevelEnum.options.map((o) => (
                    <MenuItem key={o} value={o}>
                      {LEVEL_LABELS[o] ?? o}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
          <LabeledField
            label="Institution"
            required
            error={Boolean(errors.institution)}
            helperText={errors.institution?.message ?? ''}
            htmlFor="ql-institution"
          >
            <TextField
              id="ql-institution"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="e.g. Tribhuvan University"
              error={Boolean(errors.institution)}
              {...register('institution')}
            />
          </LabeledField>
          <LabeledField
            label="Board / university"
            error={Boolean(errors.board_or_university)}
            helperText={errors.board_or_university?.message ?? ''}
            htmlFor="ql-board"
          >
            <TextField
              id="ql-board"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="Awarding body"
              error={Boolean(errors.board_or_university)}
              {...register('board_or_university')}
            />
          </LabeledField>
          <LabeledField
            label="Country"
            error={Boolean(errors.country_code)}
            helperText={errors.country_code?.message ?? ''}
            htmlFor="ql-country"
          >
            <Controller
              name="country_code"
              control={control}
              render={({ field }) => (
                <TextField
                  id="ql-country"
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
            label="Field of study"
            error={Boolean(errors.field_of_study)}
            helperText={errors.field_of_study?.message ?? ''}
            htmlFor="ql-field"
          >
            <TextField
              id="ql-field"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="e.g. Computer Science"
              error={Boolean(errors.field_of_study)}
              {...register('field_of_study')}
            />
          </LabeledField>
          <LabeledField
            label="ISCED code"
            error={Boolean(errors.isced_code)}
            helperText={errors.isced_code?.message ?? '4-digit ISCED-F code'}
            htmlFor="ql-isced"
          >
            <Controller
              name="isced_code"
              control={control}
              render={({ field }) => (
                <TextField
                  id="ql-isced"
                  select
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.isced_code)}
                  value={field.value ?? ''}
                  onChange={(e) => field.onChange(e.target.value || undefined)}
                >
                  <MenuItem value="">—</MenuItem>
                  {(iscedFields.data ?? []).map((f) => (
                    <MenuItem key={f.code} value={f.code}>
                      {f.code} — {f.label}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
          <LabeledField
            label="Started on"
            error={Boolean(errors.started_on)}
            helperText={errors.started_on?.message ?? ''}
            htmlFor="ql-start"
          >
            <TextField
              id="ql-start"
              type="date"
              fullWidth
              size="medium"
              hiddenLabel
              error={Boolean(errors.started_on)}
              {...register('started_on')}
            />
          </LabeledField>
          <LabeledField
            label="Completed on"
            error={Boolean(errors.completed_on)}
            helperText={errors.completed_on?.message ?? ''}
            htmlFor="ql-end"
          >
            <TextField
              id="ql-end"
              type="date"
              fullWidth
              size="medium"
              hiddenLabel
              error={Boolean(errors.completed_on)}
              {...register('completed_on')}
            />
          </LabeledField>
          <LabeledField
            label="Grade value"
            error={Boolean(errors.grade_value)}
            helperText={errors.grade_value?.message ?? ''}
            htmlFor="ql-grade"
          >
            <TextField
              id="ql-grade"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="3.85"
              error={Boolean(errors.grade_value)}
              {...register('grade_value')}
            />
          </LabeledField>
          <LabeledField
            label="Grade scale"
            error={Boolean(errors.grade_scale)}
            helperText={errors.grade_scale?.message ?? ''}
            htmlFor="ql-scale"
          >
            <TextField
              id="ql-scale"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="4.0 / Percentage / Distinction"
              error={Boolean(errors.grade_scale)}
              {...register('grade_scale')}
            />
          </LabeledField>
          <Controller
            name="is_highest"
            control={control}
            render={({ field }) => (
              <Stack direction="row" alignItems="center" spacing={1}>
                <Switch
                  checked={Boolean(field.value)}
                  onChange={(e) => field.onChange(e.target.checked)}
                />
                <span>Highest qualification to date</span>
              </Stack>
            )}
          />
        </Box>
      </Box>
    </FormDialog>
  );
}
