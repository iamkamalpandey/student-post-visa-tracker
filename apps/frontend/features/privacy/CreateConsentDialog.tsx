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
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import { CreateConsentRequest, LawfulBasisEnum } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { api, ApiError } from '@/lib/api';
import type { StudentRow as FullStudentRow } from '@/features/students/types';
import type { UserRow as FullUserRow } from '@/features/users/types';

type FormValues = {
  subject_type: 'student' | 'user';
  subject_id: string;
  purpose: string;
  lawful_basis: (typeof LawfulBasisEnum.options)[number];
  granted: boolean;
};

const SUBJECT_TYPES = [
  { value: 'student', label: 'Student' },
  { value: 'user', label: 'User' },
] as const;

const LAWFUL_BASES = LawfulBasisEnum.options.map((b) => ({
  value: b,
  label: b
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' '),
}));

type SubjectOption = { id: string; label: string };

// Narrow projections of the canonical row types — this dialog only needs the
// columns it shows in the autocomplete.
type StudentRow = Pick<FullStudentRow, 'id' | 'given_name' | 'family_name' | 'student_code'>;
type UserRow = Pick<FullUserRow, 'id' | 'email'>;

export type CreateConsentDialogProps = {
  open: boolean;
  onClose: () => void;
};

export default function CreateConsentDialog({ open, onClose }: CreateConsentDialogProps) {
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
    resolver: zodResolver(CreateConsentRequest),
    mode: 'onBlur',
    defaultValues: {
      subject_type: 'student',
      subject_id: '',
      purpose: '',
      lawful_basis: 'CONSENT',
      granted: true,
    },
  });

  const subjectType = watch('subject_type');

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
      return (res.data?.data ?? []).map<SubjectOption>((u) => ({ id: u.id, label: u.email }));
    },
    enabled: open,
    placeholderData: (prev) => prev,
  });

  const createMut = useMutation({
    mutationFn: async (values: FormValues) => {
      const res = await api.post('/consents', values);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Consent recorded.', { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['consents'] });
      reset();
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (
            fe.path === 'subject_type' ||
            fe.path === 'subject_id' ||
            fe.path === 'purpose' ||
            fe.path === 'lawful_basis' ||
            fe.path === 'granted'
          ) {
            setError(fe.path as keyof FormValues, { type: 'server', message: fe.message });
          }
        }
        enqueueSnackbar(err.detail || err.title || 'Failed to record consent.', {
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
      title="Record consent"
      primaryAction={{
        label: 'Record consent',
        loadingLabel: 'Saving…',
        loading: isSubmitting,
        formId: 'create-consent-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="create-consent-form"
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
            htmlFor="consent-subject-type"
          >
            <Controller
              name="subject_type"
              control={control}
              render={({ field }) => (
                <TextField
                  {...field}
                  id="consent-subject-type"
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
                  getOptionLabel={(opt) =>
                    typeof opt === 'string' ? opt : `${opt.label} (${opt.id.slice(0, 8)}…)`
                  }
                  isOptionEqualToValue={(o, v) =>
                    (typeof o === 'object' ? o.id : o) === (typeof v === 'object' ? v.id : v)
                  }
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
            label="Purpose"
            required
            error={Boolean(errors.purpose)}
            helperText={errors.purpose?.message ?? 'e.g. Marketing emails, Course recommendations'}
            htmlFor="consent-purpose"
          >
            <TextField
              id="consent-purpose"
              fullWidth
              hiddenLabel
              size="medium"
              placeholder="Marketing emails about new programs"
              error={Boolean(errors.purpose)}
              {...register('purpose')}
            />
          </LabeledField>
          <LabeledField
            label="Lawful basis"
            required
            error={Boolean(errors.lawful_basis)}
            helperText={errors.lawful_basis?.message ?? ''}
            htmlFor="consent-basis"
          >
            <Controller
              name="lawful_basis"
              control={control}
              render={({ field }) => (
                <TextField
                  {...field}
                  id="consent-basis"
                  select
                  fullWidth
                  hiddenLabel
                  size="medium"
                  error={Boolean(errors.lawful_basis)}
                >
                  {LAWFUL_BASES.map((b) => (
                    <MenuItem key={b.value} value={b.value}>
                      {b.label}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
          <Controller
            name="granted"
            control={control}
            render={({ field }) => (
              <FormControlLabel
                control={
                  <Switch
                    checked={field.value}
                    onChange={(_, v) => field.onChange(v)}
                    inputProps={{ 'aria-label': 'Granted' }}
                  />
                }
                label={field.value ? 'Granted' : 'Withheld'}
              />
            )}
          />
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
