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
  MenuItem,
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
import { CreateReminderRequest } from '@spv/zod-schemas';

import { api, ApiError } from '@/lib/api';
import { useUserContext } from '@/lib/format';
import AppDialog from '@/components/AppDialog';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';
import {
  useStudentEnrollments,
  useStudentsLite,
  useUsersLite,
  type StudentLite,
} from '@/lib/queries';
import { useAuth } from '@/lib/auth';
import { isAdmin } from '@/lib/auth-helpers';
import {
  REMINDER_TYPES,
  assigneeLabel,
  prettifyType,
  type ReminderType,
} from './types';

// Re-use the EditCoreProfileDialog "blanks → undefined" trick so that an
// empty Description (or a cleared autocomplete) doesn't trigger zod's
// "expected uuid"/"too short" branches on optional fields.
//
// Override `scheduled_for`: native <input type="datetime-local"> emits
// "YYYY-MM-DDTHH:mm" (no timezone, no seconds), which the wire `Iso8601DateTime`
// validator rejects. Conversion to UTC ISO happens at submit (`localInputToIso`).
// The FE-side schema accepts either format; submit-time conversion handles the
// wire requirement.
const DatetimeLocalOrIso = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
    'Pick a valid date and time',
  );
const FormSchema = z.preprocess((value) => {
  if (typeof value !== 'object' || value === null) return value;
  const obj = { ...(value as Record<string, unknown>) };
  for (const k of Object.keys(obj)) {
    if (typeof obj[k] === 'string' && (obj[k] as string).trim() === '') {
      delete obj[k];
    }
  }
  return obj;
}, CreateReminderRequest.extend({ scheduled_for: DatetimeLocalOrIso }));

type FormValues = {
  type: ReminderType;
  title: string;
  description: string;
  student_id: string;
  enrollment_id: string;
  assigned_to_id: string;
  due_on: string;
  scheduled_for: string;
};

const WRITABLE_PATHS: Set<keyof FormValues> = new Set([
  'type',
  'title',
  'description',
  'student_id',
  'enrollment_id',
  'assigned_to_id',
  'due_on',
  'scheduled_for',
]);

// Returns YYYY-MM-DDTHH:mm in **local** time, suitable for input[type=datetime-local].
// We deliberately default to 09:00 because that's the bell-fire window the
// backend scanner uses; the helper text under the input documents this.
function defaultScheduledFor(dueOn: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) return '';
  const [y, m, d] = dueOn.split('-').map(Number);
  const dt = new Date((y as number), (m as number) - 1, (d as number), 9, 0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

// `datetime-local` produces a wall-clock string with no timezone. Interpret
// the wall clock in the *user's* configured timezone (not the browser's) and
// emit a UTC ISO 8601 so the backend zod schema (Iso8601DateTime) accepts it.
function localInputToIso(local: string, userTz: string): string | undefined {
  if (!local) return undefined;
  const dt = dayjs.tz(local, userTz);
  if (!dt.isValid()) return undefined;
  return dt.utc().toISOString();
}

function todayIso(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

export type CreateReminderDialogProps = {
  open: boolean;
  onClose: () => void;
  /** When set, the Student picker is pre-populated and locked. */
  presetStudent?: StudentLite | null;
};

export default function CreateReminderDialog({
  open,
  onClose,
  presetStudent,
}: CreateReminderDialogProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { user } = useAuth();
  const { timezone: userTz } = useUserContext();
  const admin = isAdmin(user?.role);
  const t = useTranslations('reminders.dialogs.create');

  const [studentSearch, setStudentSearch] = useState('');
  const debouncedStudentSearch = useDebounced(studentSearch, 250);
  const studentsQuery = useStudentsLite(debouncedStudentSearch);
  const usersQuery = useUsersLite(admin);

  const initialDueOn = todayIso();
  const defaults: FormValues = useMemo(
    () => ({
      type: 'CUSTOM',
      title: '',
      description: '',
      student_id: presetStudent?.id ?? '',
      enrollment_id: '',
      // Default to "me" for non-admins so a counsellor's quick-create doesn't
      // accidentally drop a row off everyone else's queue.
      assigned_to_id: admin ? '' : (user?.id ?? ''),
      due_on: initialDueOn,
      scheduled_for: defaultScheduledFor(initialDueOn),
    }),
    [presetStudent?.id, admin, user?.id, initialDueOn],
  );

  const [selectedStudent, setSelectedStudent] = useState<StudentLite | null>(
    presetStudent ?? null,
  );

  const {
    register,
    control,
    handleSubmit,
    reset,
    watch,
    setValue,
    setError,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    mode: 'onBlur',
    defaultValues: defaults,
  });

  // Reset when the dialog re-opens, and re-seed the student picker.
  useEffect(() => {
    if (open) {
      reset(defaults);
      setSelectedStudent(presetStudent ?? null);
      setStudentSearch('');
    }
    // Run only on the open transition; pulling `defaults`/`presetStudent`
    // into the deps would re-reset mid-edit when upstream identities flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Auto-rewrite scheduled_for whenever due_on changes AND the user hasn't
  // hand-edited the time. We treat "matches the previous default" as a proxy
  // for "untouched" so the helper text remains accurate.
  const dueOn = watch('due_on');
  const scheduledFor = watch('scheduled_for');
  useEffect(() => {
    if (!dueOn) return;
    const computed = defaultScheduledFor(dueOn);
    // If scheduled is empty OR matches a previously-computed default, sync it.
    if (!scheduledFor || /^\d{4}-\d{2}-\d{2}T09:00$/.test(scheduledFor)) {
      setValue('scheduled_for', computed, { shouldDirty: false });
    }
    // Trigger only on `dueOn` change; depending on `scheduledFor` would
    // create a feedback loop since this effect writes to it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dueOn]);

  const createMutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      // Strip blanks; convert datetime-local → ISO before sending.
      const payload: Record<string, unknown> = {
        type: values.type,
        title: values.title.trim(),
        due_on: values.due_on,
      };
      if (values.description.trim()) payload['description'] = values.description.trim();
      if (values.student_id) payload['student_id'] = values.student_id;
      if (values.enrollment_id) payload['enrollment_id'] = values.enrollment_id;
      if (values.assigned_to_id) payload['assigned_to_id'] = values.assigned_to_id;
      const iso = localInputToIso(values.scheduled_for, userTz);
      if (iso) payload['scheduled_for'] = iso;
      const res = await api.post('/reminders', payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(t('successToast'), { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['reminders'] });
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

  const onSubmit = handleSubmit((values) => createMutation.mutate(values));

  const topLevelError =
    createMutation.isError &&
    createMutation.error &&
    !createMutation.error.errors?.length
      ? createMutation.error.detail || createMutation.error.title || null
      : null;

  // Enrollment options are pulled from /students/:id/enrollments once a
  // student has been chosen. We map intake metadata into a single label so the
  // dropdown is self-explanatory ("BSc Computing — Sep 2025") even when the
  // backend omits one half of the join.
  const watchedStudentId = watch('student_id');
  const enrollmentsQuery = useStudentEnrollments(watchedStudentId || undefined);
  const enrollmentOptions = useMemo(() => {
    const rows = enrollmentsQuery.data ?? [];
    return rows.map((row) => {
      const programName =
        row.program?.name?.trim() || 'Program (unknown)';
      const intakeLabel =
        row.program_intake?.intake_label?.trim() ||
        (row.program_intake?.intake_year && row.program_intake?.intake_month
          ? `${row.program_intake.intake_year}-${String(row.program_intake.intake_month).padStart(2, '0')}`
          : row.intake_label?.trim() || '—');
      return {
        id: row.id,
        label: `${programName} — ${intakeLabel}`,
      };
    });
  }, [enrollmentsQuery.data]);

  const saveDisabled = !isDirty || isSubmitting || createMutation.isPending;
  const saveBlockedReason = !isDirty ? 'Make a change to enable saving' : null;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t('title')}
      subtitle={t('subtitle')}
      maxWidth="md"
      errorText={topLevelError}
      primaryAction={{
        label: t('submit'),
        loadingLabel: t('submitting'),
        loading: isSubmitting || createMutation.isPending,
        formId: 'create-reminder-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="create-reminder-form"
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
          subtitle="What this reminder is about"
          icon={<LabelOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={4}>
              <LabeledField
                label="Type"
                required
                error={Boolean(errors.type)}
                helperText={errors.type?.message ?? ''}
                htmlFor="cr-type"
              >
                <Controller
                  name="type"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      id="cr-type"
                      select
                      fullWidth
                      hiddenLabel
                      size="medium"
                      error={Boolean(errors.type)}
                    >
                      {REMINDER_TYPES.map((rt) => (
                        <MenuItem key={rt} value={rt}>
                          {prettifyType(rt)}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={8}>
              <LabeledField
                label="Title"
                required
                error={Boolean(errors.title)}
                helperText={errors.title?.message ?? ''}
                htmlFor="cr-title"
              >
                <TextField
                  id="cr-title"
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
                helperText={errors.description?.message ?? 'Optional context shown on the reminder card.'}
                htmlFor="cr-description"
              >
                <TextField
                  id="cr-description"
                  fullWidth
                  hiddenLabel
                  multiline
                  minRows={3}
                  placeholder="Confirm Maya has uploaded her CoE before the consulate appointment."
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
          subtitle="Tie the reminder to a student, enrolment, or assignee"
          icon={<LinkOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6}>
              <LabeledField
                label="Student"
                error={Boolean(errors.student_id)}
                helperText={
                  errors.student_id?.message ??
                  (presetStudent ? 'Locked to current student.' : 'Optional.')
                }
              >
                <Controller
                  name="student_id"
                  control={control}
                  render={({ field }) => (
                    <Autocomplete<StudentLite, false, false, false>
                      options={studentsQuery.data ?? []}
                      loading={studentsQuery.isFetching}
                      value={selectedStudent}
                      disabled={Boolean(presetStudent)}
                      onInputChange={(_, v) => setStudentSearch(v)}
                      onChange={(_, v) => {
                        setSelectedStudent(v);
                        field.onChange(v?.id ?? '');
                        // Clear linked enrollment whenever the student changes.
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
              <Controller
                name="enrollment_id"
                control={control}
                render={({ field }) => {
                  const isLoading = Boolean(
                    selectedStudent && enrollmentsQuery.isFetching,
                  );
                  const helper = errors.enrollment_id?.message
                    ? errors.enrollment_id.message
                    : !selectedStudent
                      ? 'Pick a student first.'
                      : isLoading
                        ? 'Loading enrollments…'
                        : enrollmentsQuery.isError
                          ? 'Could not load enrollments.'
                          : enrollmentOptions.length === 0
                            ? 'No enrollments to choose from.'
                            : 'Optional — link this reminder to a specific enrollment.';
                  return (
                    <LabeledField
                      label="Enrollment"
                      error={Boolean(errors.enrollment_id)}
                      helperText={helper}
                      htmlFor="cr-enrollment"
                    >
                      <TextField
                        {...field}
                        id="cr-enrollment"
                        select
                        fullWidth
                        hiddenLabel
                        size="medium"
                        disabled={
                          !selectedStudent ||
                          isLoading ||
                          enrollmentOptions.length === 0
                        }
                        error={Boolean(errors.enrollment_id)}
                      >
                        <MenuItem value="">— Not linked —</MenuItem>
                        {enrollmentOptions.map((e) => (
                          <MenuItem key={e.id} value={e.id}>
                            {e.label}
                          </MenuItem>
                        ))}
                      </TextField>
                    </LabeledField>
                  );
                }}
              />
            </Grid>
            <Grid item xs={12}>
              <Controller
                name="assigned_to_id"
                control={control}
                render={({ field }) => {
                  if (!admin) {
                    // Non-admins can only assign to themselves; render a static
                    // read-only line so the intent is obvious without a picker.
                    return (
                      <LabeledField
                        label="Assigned to"
                        helperText="Defaults to you. Only admins can reassign."
                        htmlFor="cr-assignee-readonly"
                      >
                        <TextField
                          id="cr-assignee-readonly"
                          fullWidth
                          hiddenLabel
                          size="medium"
                          value={user?.display_name || user?.email || 'Me'}
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
                      helperText={errors.assigned_to_id?.message ?? 'Leave blank to leave unassigned.'}
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
                helperText={errors.due_on?.message ?? 'The deadline this reminder tracks.'}
                htmlFor="cr-due-on"
              >
                <TextField
                  id="cr-due-on"
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
                helperText={
                  errors.scheduled_for?.message ?? 'When the bell badge fires (defaults to 09:00 local on the due date).'
                }
                htmlFor="cr-scheduled-for"
              >
                <TextField
                  id="cr-scheduled-for"
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
