'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect, useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import {
  Autocomplete,
  Box,
  Chip,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import LabelOutlinedIcon from '@mui/icons-material/LabelOutlined';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import EventOutlinedIcon from '@mui/icons-material/EventOutlined';
import { z } from 'zod';
import dayjs from 'dayjs';
import { UpdateReminderRequest } from '@spv/zod-schemas';

import { api, ApiError } from '@/lib/api';
import { useUserContext } from '@/lib/format';
import AppDialog from '@/components/AppDialog';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';
import { useStudentsLite, useUsersLite, type StudentLite } from '@/lib/queries';
import { useAuth } from '@/lib/auth';
import { isAdmin } from '@/lib/auth-helpers';
import {
  REMINDER_TYPE_COLORS,
  assigneeLabel,
  prettifyType,
  studentLabel,
  type Reminder,
} from './types';

// Same blanks→undefined preprocessor as the Create dialog. UpdateReminder is
// already a partial of CreateReminder so omitting fields is acceptable.
const FormSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null) return value;
  const obj = { ...(value as Record<string, unknown>) };
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'string' && (obj[k] as string).trim() === '') {
      delete obj[k];
    }
  }
  return obj;
}, UpdateReminderRequest);

type FormValues = {
  title: string;
  description: string;
  student_id: string;
  enrollment_id: string;
  assigned_to_id: string;
  due_on: string;
  scheduled_for: string;
};

const WRITABLE_PATHS: Set<keyof FormValues> = new Set([
  'title',
  'description',
  'student_id',
  'enrollment_id',
  'assigned_to_id',
  'due_on',
  'scheduled_for',
]);

function isoToLocalInput(iso: string | null | undefined, userTz: string): string {
  if (!iso) return '';
  const dt = dayjs.utc(iso).tz(userTz);
  if (!dt.isValid()) return '';
  return dt.format('YYYY-MM-DDTHH:mm');
}

function localInputToIso(local: string, userTz: string): string | undefined {
  if (!local) return undefined;
  const dt = dayjs.tz(local, userTz);
  if (!dt.isValid()) return undefined;
  return dt.utc().toISOString();
}

function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export type EditReminderDialogProps = {
  open: boolean;
  onClose: () => void;
  reminder: Reminder;
};

export default function EditReminderDialog({
  open,
  onClose,
  reminder,
}: EditReminderDialogProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { user } = useAuth();
  const { timezone: userTz } = useUserContext();
  const admin = isAdmin(user?.role);
  const t = useTranslations('reminders.dialogs.edit');

  const [studentSearch, setStudentSearch] = useState('');
  const debouncedStudentSearch = useDebounced(studentSearch, 250);
  const studentsQuery = useStudentsLite(debouncedStudentSearch);
  const usersQuery = useUsersLite(admin);

  // Seed the picker with whatever the row already has so the user can see
  // the current selection without having to retype the query.
  const initialStudent: StudentLite | null = useMemo(() => {
    if (!reminder.student) return null;
    return {
      id: reminder.student.id,
      student_code: reminder.student.student_code,
      given_name: reminder.student.given_name,
      family_name: reminder.student.family_name,
    };
  }, [reminder.student]);

  const [selectedStudent, setSelectedStudent] = useState<StudentLite | null>(initialStudent);

  const defaults: FormValues = useMemo(
    () => ({
      title: reminder.title ?? '',
      description: reminder.description ?? '',
      student_id: reminder.student_id ?? '',
      enrollment_id: reminder.enrollment_id ?? '',
      assigned_to_id: reminder.assigned_to_id ?? '',
      due_on: (reminder.due_on ?? '').slice(0, 10),
      scheduled_for: isoToLocalInput(reminder.scheduled_for, userTz),
    }),
    [reminder, userTz],
  );

  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    mode: 'onBlur',
    defaultValues: defaults,
  });

  useEffect(() => {
    if (open) {
      reset(defaults);
      setSelectedStudent(initialStudent);
      setStudentSearch('');
    }
    // Re-seed only on open transition or when the underlying record id changes;
    // including `defaults`/`reset` would clobber user typing on background refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reminder.id]);

  const updateMutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      const payload: Record<string, unknown> = {};
      if (values.title.trim()) payload['title'] = values.title.trim();
      if (values.description.trim()) payload['description'] = values.description.trim();
      if (values.student_id) payload['student_id'] = values.student_id;
      if (values.enrollment_id) payload['enrollment_id'] = values.enrollment_id;
      if (values.assigned_to_id) payload['assigned_to_id'] = values.assigned_to_id;
      if (values.due_on) payload['due_on'] = values.due_on;
      const iso = localInputToIso(values.scheduled_for, userTz);
      if (iso) payload['scheduled_for'] = iso;
      const res = await api.patch(`/reminders/${reminder.id}`, payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(t('successToast'), { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['reminders'] });
      qc.invalidateQueries({ queryKey: ['reminder', reminder.id] });
      onClose();
    },
    onError: (err) => {
      for (const fe of err.errors ?? []) {
        const leaf = fe.path.split('.').pop() as keyof FormValues | undefined;
        if (leaf && WRITABLE_PATHS.has(leaf)) {
          setError(leaf, { type: 'server', message: fe.message });
        }
      }
      enqueueSnackbar(err.detail || err.title || t('errorToast'), {
        variant: 'error',
      });
    },
  });

  const onSubmit = handleSubmit((values) => updateMutation.mutate(values));

  const topLevelError =
    updateMutation.isError &&
    updateMutation.error &&
    !updateMutation.error.errors?.length
      ? updateMutation.error.detail || updateMutation.error.title || null
      : null;

  const typeSwatch = REMINDER_TYPE_COLORS[reminder.type];
  const enrollmentOptions: { id: string; label: string }[] = [];

  const saveDisabled = !isDirty || isSubmitting || updateMutation.isPending;
  const saveBlockedReason = !isDirty ? 'Make a change to enable saving' : null;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t('title')}
      subtitle={
        <Stack direction="row" spacing={1} alignItems="center">
          <Chip
            size="small"
            label={prettifyType(reminder.type)}
            sx={{
              bgcolor: typeSwatch?.bg,
              color: typeSwatch?.fg,
              fontWeight: 600,
              border: 'none',
            }}
          />
          <Typography variant="body2" color="text.secondary">
            {t('subtitleNote')}
          </Typography>
        </Stack>
      }
      maxWidth="md"
      errorText={topLevelError}
      primaryAction={{
        label: t('submit'),
        loadingLabel: t('submitting'),
        loading: isSubmitting || updateMutation.isPending,
        formId: 'edit-reminder-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="edit-reminder-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="datetime-local"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root': { paddingTop: '0 !important', paddingBottom: '0 !important' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': { padding: '0 6px !important' },
        }}
      >
        {/* Required-field legend. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>

        <FormSection
          title="Identity"
          subtitle="Title and free-text context"
          icon={<LabelOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12}>
              <LabeledField
                label="Title"
                required
                error={Boolean(errors.title)}
                helperText={errors.title?.message ?? ''}
                htmlFor="er-title"
              >
                <TextField
                  id="er-title"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  placeholder="Follow up on visa lodgement"
                  inputProps={{ maxLength: 200 }}
                  error={Boolean(errors.title)}
                  {...register('title')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12}>
              <LabeledField
                label="Description"
                error={Boolean(errors.description)}
                helperText={errors.description?.message ?? ''}
                htmlFor="er-description"
              >
                <TextField
                  id="er-description"
                  fullWidth
                  hiddenLabel
                  multiline
                  minRows={3}
                  placeholder="Optional context shown on the reminder card."
                  inputProps={{ maxLength: 4000 }}
                  error={Boolean(errors.description)}
                  {...register('description')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Linkage"
          subtitle="Student, enrolment and assignee"
          icon={<LinkOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Student"
                error={Boolean(errors.student_id)}
                helperText={errors.student_id?.message ?? (initialStudent ? studentLabel(reminder.student) : 'Optional.')}
              >
                <Controller
                  name="student_id"
                  control={control}
                  render={({ field }) => (
                    <Autocomplete<StudentLite, false, false, false>
                      options={studentsQuery.data ?? []}
                      loading={studentsQuery.isFetching}
                      value={selectedStudent}
                      onInputChange={(_, v) => setStudentSearch(v)}
                      onChange={(_, v) => {
                        setSelectedStudent(v);
                        field.onChange(v?.id ?? '');
                        setValue('enrollment_id', '');
                      }}
                      getOptionLabel={(o) =>
                        `${o.given_name} ${o.family_name} · ${o.student_code}`
                      }
                      isOptionEqualToValue={(a, b) => a.id === b.id}
                      filterOptions={(x) => x}
                      noOptionsText={
                        studentSearch.trim() ? 'No matches' : 'Type to search students'
                      }
                      fullWidth
                      size="medium"
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          hiddenLabel
                          placeholder="Search by name or student code"
                          error={Boolean(errors.student_id)}
                        />
                      )}
                    />
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Enrollment"
                error={Boolean(errors.enrollment_id)}
                helperText={
                  errors.enrollment_id?.message ??
                  (selectedStudent
                    ? 'No enrollments to choose from.'
                    : 'Pick a student first.')
                }
                htmlFor="er-enrollment"
              >
                <Controller
                  name="enrollment_id"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      id="er-enrollment"
                      select
                      SelectProps={{ native: true }}
                      fullWidth
                      hiddenLabel
                      size="medium"
                      disabled={!selectedStudent || enrollmentOptions.length === 0}
                      error={Boolean(errors.enrollment_id)}
                    >
                      <option value="">— Not linked —</option>
                      {enrollmentOptions.map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.label}
                        </option>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12}>
              <Controller
                name="assigned_to_id"
                control={control}
                render={({ field }) => {
                  if (!admin) {
                    return (
                      <LabeledField
                        label="Assigned to"
                        helperText="Only admins can reassign reminders."
                        htmlFor="er-assignee-readonly"
                      >
                        <TextField
                          id="er-assignee-readonly"
                          fullWidth
                          hiddenLabel
                          size="medium"
                          value={assigneeLabel(reminder.assigned_to ?? null)}
                          disabled
                        />
                      </LabeledField>
                    );
                  }
                  const opts = usersQuery.data ?? [];
                  const selected = opts.find((u) => u.id === field.value) ?? null;
                  return (
                    <LabeledField
                      label="Assigned to"
                      error={Boolean(errors.assigned_to_id)}
                      helperText={errors.assigned_to_id?.message ?? ''}
                    >
                      <Autocomplete
                        options={opts}
                        loading={usersQuery.isLoading}
                        value={selected}
                        onChange={(_, v) => field.onChange(v?.id ?? '')}
                        getOptionLabel={(o) =>
                          assigneeLabel({
                            id: o.id,
                            given_name: o.given_name,
                            family_name: o.family_name,
                            display_name: o.display_name,
                          }) + ` · ${o.email}`
                        }
                        isOptionEqualToValue={(a, b) => a.id === b.id}
                        fullWidth
                        size="medium"
                        renderInput={(params) => (
                          <TextField
                            {...params}
                            hiddenLabel
                            placeholder="Search counsellors / admins"
                            error={Boolean(errors.assigned_to_id)}
                          />
                        )}
                      />
                    </LabeledField>
                  );
                }}
              />
            </Grid>
          </Grid>
        </FormSection>

        <FormSection
          title="Schedule"
          subtitle="Due date and bell-fire time"
          icon={<EventOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Due on"
                required
                error={Boolean(errors.due_on)}
                helperText={errors.due_on?.message ?? ''}
                htmlFor="er-due-on"
              >
                <TextField
                  id="er-due-on"
                  type="date"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  error={Boolean(errors.due_on)}
                  {...register('due_on')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Scheduled for"
                error={Boolean(errors.scheduled_for)}
                helperText={errors.scheduled_for?.message ?? 'When the bell badge fires.'}
                htmlFor="er-scheduled-for"
              >
                <TextField
                  id="er-scheduled-for"
                  type="datetime-local"
                  fullWidth
                  hiddenLabel
                  size="medium"
                  error={Boolean(errors.scheduled_for)}
                  {...register('scheduled_for')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        {saveBlockedReason && (
          <Tooltip title="">
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              {saveBlockedReason}
            </Typography>
          </Tooltip>
        )}
      </Box>
    </AppDialog>
  );
}
