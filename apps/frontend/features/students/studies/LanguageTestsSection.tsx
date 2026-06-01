'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect } from 'react';
import { Box, MenuItem, TextField, Typography } from '@mui/material';
import LabeledField from '@/components/LabeledField';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  CreateLanguageTestRequest,
  LanguageTestEnum,
  type CreateLanguageTestRequest as CreateLanguageTestRequestType,
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

type LangTest = {
  id: string;
  test_type: string;
  overall_score: number | string;
  listening?: number | string | null;
  reading?: number | string | null;
  writing?: number | string | null;
  speaking?: number | string | null;
  test_date: string;
  expires_on?: string | null;
  certificate_no?: string | null;
};

export type LanguageTestsSectionProps = { studentId: string };

export default function LanguageTestsSection({ studentId }: LanguageTestsSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<LangTest>();
  const deleteDlg = useDialogState<LangTest>();

  const queryKey = ['students', studentId, 'language-tests'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/language-tests`);
      return unwrapList<LangTest>(res.data);
    },
  });

  const columns: DataTableColumn<LangTest>[] = [
    { key: 'type', label: 'Test', render: (r) => r.test_type },
    { key: 'overall', label: 'Overall', render: (r) => String(r.overall_score) },
    {
      key: 'sub',
      label: 'L / R / W / S',
      render: (r) =>
        [r.listening, r.reading, r.writing, r.speaking].some((s) => s != null && s !== '')
          ? `${r.listening ?? '—'} / ${r.reading ?? '—'} / ${r.writing ?? '—'} / ${r.speaking ?? '—'}`
          : '—',
    },
    { key: 'date', label: 'Test date', render: (r) => formatDate(r.test_date) },
    { key: 'expires', label: 'Expires', render: (r) => formatDate(r.expires_on ?? '') },
    { key: 'cert', label: 'Certificate', render: (r) => r.certificate_no ?? '—' },
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

  const removeMutation = useMutation<void, ApiError, LangTest>({
    mutationFn: async (row) => {
      await api.delete(`/language-tests/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Language test deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Language tests"
        description="English-proficiency and standardised test scores accepted by the destination."
        onAdd={dlg.openCreate}
        addLabel="Add test"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="language tests"
        onAdd={dlg.openCreate}
        addLabel="Add test"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <LanguageTestFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey })}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete language test?"
        description="This permanently removes the test record."
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

type FormValues = CreateLanguageTestRequestType;

function LanguageTestFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: LangTest | null;
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
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(CreateLanguageTestRequest),
    defaultValues: {
      test_type: 'IELTS',
      overall_score: '',
      listening: '',
      reading: '',
      writing: '',
      speaking: '',
      test_date: '',
      expires_on: undefined,
      certificate_no: '',
    },
  });

  useEffect(() => {
    if (!open) return;
    reset({
      test_type: (editing?.test_type as FormValues['test_type']) ?? 'IELTS',
      overall_score: editing?.overall_score != null ? String(editing.overall_score) : '',
      listening: editing?.listening != null ? String(editing.listening) : '',
      reading: editing?.reading != null ? String(editing.reading) : '',
      writing: editing?.writing != null ? String(editing.writing) : '',
      speaking: editing?.speaking != null ? String(editing.speaking) : '',
      test_date: editing?.test_date?.slice(0, 10) ?? '',
      expires_on: editing?.expires_on?.slice(0, 10),
      certificate_no: editing?.certificate_no ?? '',
    });
  }, [open, editing, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (raw) => {
      const values: Record<string, unknown> = { ...raw };
      // Coerce numeric string scores to numbers when they parse cleanly.
      for (const k of ['overall_score', 'listening', 'reading', 'writing', 'speaking']) {
        const v = values[k];
        if (typeof v === 'string' && v !== '' && !Number.isNaN(Number(v))) values[k] = Number(v);
      }
      const body = compactPayload(values);
      if (editing) return api.patch(`/language-tests/${editing.id}`, body);
      return api.post(`/students/${studentId}/language-tests`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Language test updated' : 'Language test added', {
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
      title={editing ? 'Edit language test' : 'Add language test'}
      formId="language-test-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="language-test-form"
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
            label="Test type"
            required
            error={Boolean(errors.test_type)}
            helperText={errors.test_type?.message ?? ''}
            htmlFor="lt-type"
          >
            <Controller
              name="test_type"
              control={control}
              render={({ field }) => (
                <TextField
                  id="lt-type"
                  select
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.test_type)}
                  {...field}
                >
                  {LanguageTestEnum.options.map((o) => (
                    <MenuItem key={o} value={o}>
                      {o}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
          <LabeledField
            label="Overall score"
            required
            error={Boolean(errors.overall_score)}
            helperText={errors.overall_score?.message ?? ''}
            htmlFor="lt-overall"
          >
            <TextField
              id="lt-overall"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="e.g. 7.5"
              error={Boolean(errors.overall_score)}
              {...register('overall_score')}
            />
          </LabeledField>
          <LabeledField
            label="Listening"
            error={Boolean(errors.listening)}
            helperText={errors.listening?.message ?? ''}
            htmlFor="lt-listen"
          >
            <TextField
              id="lt-listen"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="e.g. 7.0"
              error={Boolean(errors.listening)}
              {...register('listening')}
            />
          </LabeledField>
          <LabeledField
            label="Reading"
            error={Boolean(errors.reading)}
            helperText={errors.reading?.message ?? ''}
            htmlFor="lt-read"
          >
            <TextField
              id="lt-read"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="e.g. 7.5"
              error={Boolean(errors.reading)}
              {...register('reading')}
            />
          </LabeledField>
          <LabeledField
            label="Writing"
            error={Boolean(errors.writing)}
            helperText={errors.writing?.message ?? ''}
            htmlFor="lt-write"
          >
            <TextField
              id="lt-write"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="e.g. 6.5"
              error={Boolean(errors.writing)}
              {...register('writing')}
            />
          </LabeledField>
          <LabeledField
            label="Speaking"
            error={Boolean(errors.speaking)}
            helperText={errors.speaking?.message ?? ''}
            htmlFor="lt-speak"
          >
            <TextField
              id="lt-speak"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="e.g. 7.0"
              error={Boolean(errors.speaking)}
              {...register('speaking')}
            />
          </LabeledField>
          <LabeledField
            label="Test date"
            required
            error={Boolean(errors.test_date)}
            helperText={errors.test_date?.message ?? ''}
            htmlFor="lt-date"
          >
            <TextField
              id="lt-date"
              type="date"
              fullWidth
              size="medium"
              hiddenLabel
              error={Boolean(errors.test_date)}
              {...register('test_date')}
            />
          </LabeledField>
          <LabeledField
            label="Expires on"
            error={Boolean(errors.expires_on)}
            helperText={errors.expires_on?.message ?? ''}
            htmlFor="lt-expires"
          >
            <TextField
              id="lt-expires"
              type="date"
              fullWidth
              size="medium"
              hiddenLabel
              error={Boolean(errors.expires_on)}
              {...register('expires_on')}
            />
          </LabeledField>
          <Box sx={{ gridColumn: { sm: '1 / -1' } }}>
            <LabeledField
              label="Certificate number"
              error={Boolean(errors.certificate_no)}
              helperText={errors.certificate_no?.message ?? ''}
              htmlFor="lt-cert"
            >
              <TextField
                id="lt-cert"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. 19IE0123ABC456D"
                error={Boolean(errors.certificate_no)}
                {...register('certificate_no')}
              />
            </LabeledField>
          </Box>
        </Box>
      </Box>
    </FormDialog>
  );
}
