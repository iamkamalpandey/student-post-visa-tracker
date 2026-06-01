'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Autocomplete,
  Box,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { CreateDSARRequest, DSARTypeEnum } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { api, ApiError } from '@/lib/api';
import type { StudentRow as FullStudentRow } from '@/features/students/types';
import type { UserRow as FullUserRow } from '@/features/users/types';

type FormValues = {
  subject_type: 'student' | 'user';
  subject_id: string;
  type: (typeof DSARTypeEnum.options)[number];
  notes?: string;
};

const SUBJECT_TYPES = [
  { value: 'student', label: 'Student' },
  { value: 'user', label: 'User' },
] as const;

const DSAR_TYPES = DSARTypeEnum.options.map((t) => ({
  value: t,
  label: t.charAt(0) + t.slice(1).toLowerCase().replace(/_/g, ' '),
}));

type SubjectOption = { id: string; label: string };

// Narrow projections of the canonical row types — this dialog only needs the
// columns it shows in the autocomplete, and the source of truth for the full
// shapes lives in `features/students/types` and `features/users/types`.
type StudentRow = Pick<FullStudentRow, 'id' | 'given_name' | 'family_name' | 'student_code'>;
type UserRow = Pick<FullUserRow, 'id' | 'email' | 'given_name' | 'family_name'>;

export type CreateDSARDialogProps = {
  open: boolean;
  onClose: () => void;
};

export default function CreateDSARDialog({ open, onClose }: CreateDSARDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const queryClient = useQueryClient();
  const [subjectQuery, setSubjectQuery] = useState('');

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    watch,
    setValue,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(CreateDSARRequest),
    mode: 'onBlur',
    defaultValues: {
      subject_type: 'student',
      subject_id: '',
      type: 'ACCESS',
      notes: '',
    },
  });

  const subjectType = watch('subject_type');

  // Lookup students or users for the autocomplete. Optional — manual UUID entry still works.
  const lookupQuery = useQuery({
    queryKey: ['privacy', 'subject-lookup', subjectType, subjectQuery],
    queryFn: async ({ signal }) => {
      if (subjectType === 'student') {
        const res = await api.get<{ data: StudentRow[] }>('/students', {
          params: { limit: 10, ...(subjectQuery ? { search: subjectQuery } : {}) },
          signal,
        });
        return (res.data?.data ?? []).map<SubjectOption>((s) => ({
          id: s.id,
          label: `${s.given_name} ${s.family_name}`.trim() || s.student_code || s.id,
        }));
      }
      const res = await api.get<{ data: UserRow[] }>('/users', {
        params: { limit: 10, ...(subjectQuery ? { search: subjectQuery } : {}) },
        signal,
      });
      return (res.data?.data ?? []).map<SubjectOption>((u) => ({
        id: u.id,
        label: u.email,
      }));
    },
    enabled: open,
    placeholderData: (prev) => prev,
  });

  const createMut = useMutation({
    mutationFn: async (values: FormValues) => {
      const payload = {
        subject_type: values.subject_type,
        subject_id: values.subject_id,
        type: values.type,
        ...(values.notes?.trim() ? { notes: values.notes.trim() } : {}),
      };
      const res = await api.post('/dsar', payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('DSAR request created.', { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['dsar'] });
      // SVT-WAVE42-DASH-INVALIDATE-2026-05 — bump the DSAR dashboard widget.
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      reset();
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (
            fe.path === 'subject_type' ||
            fe.path === 'subject_id' ||
            fe.path === 'type' ||
            fe.path === 'notes'
          ) {
            setError(fe.path as keyof FormValues, { type: 'server', message: fe.message });
          }
        }
        enqueueSnackbar(err.detail || err.title || 'Failed to create DSAR.', {
          variant: 'error',
        });
      } else {
        enqueueSnackbar('Network error. Please try again.', { variant: 'error' });
      }
    },
  });

  const onSubmit = handleSubmit((values) => createMut.mutate(values));

  const handleClose = () => {
    if (isSubmitting) return;
    reset();
    setSubjectQuery('');
    onClose();
  };

  // Reset autocomplete state when subject type flips.
  useEffect(() => {
    setValue('subject_id', '', { shouldValidate: false });
    setSubjectQuery('');
  }, [subjectType, setValue]);

  const saveDisabled = !isDirty || isSubmitting || createMut.isPending;
  const saveBlockedReason = !isDirty ? 'Make a change to enable saving' : null;

  return (
    <AppDialog
      open={open}
      onClose={handleClose}
      title="New DSAR request"
      primaryAction={{
        label: 'Create request',
        loadingLabel: 'Creating…',
        loading: isSubmitting,
        formId: 'create-dsar-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="create-dsar-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root': { paddingTop: '0 !important', paddingBottom: '0 !important' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': { padding: '0 6px !important' },
        }}
      >
        {/* Required-field legend. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Stack spacing={2.5}>
          <LabeledField
            label="Subject type"
            required
            error={Boolean(errors.subject_type)}
            helperText={errors.subject_type?.message ?? ''}
            htmlFor="dsar-subject-type"
          >
            <Controller
              name="subject_type"
              control={control}
              render={({ field }) => (
                <TextField
                  {...field}
                  id="dsar-subject-type"
                  select
                  fullWidth
                  hiddenLabel
                  size="medium"
                  error={Boolean(errors.subject_type)}
                >
                  {SUBJECT_TYPES.map((s) => (
                    <MenuItem key={s.value} value={s.value}>
                      {s.label}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
          <LabeledField
            label="Subject ID (UUID)"
            required
            encrypted
            error={Boolean(errors.subject_id)}
            helperText={errors.subject_id?.message ?? 'Pick from the list or paste a UUID.'}
          >
            <Controller
              name="subject_id"
              control={control}
              render={({ field }) => (
                <Autocomplete
                  freeSolo
                  options={lookupQuery.data ?? []}
                  getOptionLabel={(opt) => (typeof opt === 'string' ? opt : `${opt.label} (${opt.id.slice(0, 8)}…)`)}
                  isOptionEqualToValue={(o, v) => (typeof o === 'object' ? o.id : o) === (typeof v === 'object' ? v.id : v)}
                  onInputChange={(_, val) => setSubjectQuery(val)}
                  onChange={(_, val) => {
                    if (!val) field.onChange('');
                    else if (typeof val === 'string') field.onChange(val);
                    else field.onChange(val.id);
                  }}
                  fullWidth
                  size="medium"
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      hiddenLabel
                      placeholder="Search or paste UUID, e.g. 8f2c…"
                      error={Boolean(errors.subject_id)}
                    />
                  )}
                  loading={lookupQuery.isFetching}
                />
              )}
            />
          </LabeledField>
          <LabeledField
            label="Request type"
            required
            error={Boolean(errors.type)}
            helperText={errors.type?.message ?? ''}
            htmlFor="dsar-type"
          >
            <Controller
              name="type"
              control={control}
              render={({ field }) => (
                <TextField
                  {...field}
                  id="dsar-type"
                  select
                  fullWidth
                  hiddenLabel
                  size="medium"
                  error={Boolean(errors.type)}
                >
                  {DSAR_TYPES.map((opt) => (
                    <MenuItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
          <LabeledField
            label="Notes"
            error={Boolean(errors.notes)}
            helperText={errors.notes?.message ?? ''}
            htmlFor="dsar-notes"
          >
            <TextField
              id="dsar-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={3}
              placeholder="Caller verified by passport on 2026-05-01."
              error={Boolean(errors.notes)}
              {...register('notes')}
            />
          </LabeledField>
          {saveBlockedReason && (
            <Tooltip title="">
              <Typography variant="caption" color="text.secondary">
                {saveBlockedReason}
              </Typography>
            </Tooltip>
          )}
        </Stack>
      </Box>
    </AppDialog>
  );
}
