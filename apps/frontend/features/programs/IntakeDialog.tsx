// Refactored to SVT form-pattern per design pass.
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  Button,
  FormControlLabel,
  MenuItem,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import EventNoteOutlinedIcon from '@mui/icons-material/EventNoteOutlined';
import AssignmentOutlinedIcon from '@mui/icons-material/AssignmentOutlined';
import ClassOutlinedIcon from '@mui/icons-material/ClassOutlined';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import {
  CreateProgramIntakeRequest,
  UpdateProgramIntakeRequest,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';
import { useSaveBlockedReason } from '@/components/useSaveBlockedReason';
import {
  MONTHS,
  type DurationPattern,
  type ProgramIntakeRow,
  type ProgramRow,
} from './types';

const FORM_BOX_SX = {
  '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
  '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
  '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
} as const;

type FormValues = {
  intake_label: string;
  intake_year: string;
  intake_month: string;
  application_open: string;
  application_close: string;
  decision_date: string;
  classes_start_on: string;
  classes_end_on: string;
  capacity: string;
  is_open: boolean;
  notes: string;
};

const empty = (): FormValues => ({
  intake_label: '',
  intake_year: String(new Date().getFullYear()),
  intake_month: '9',
  application_open: '',
  application_close: '',
  decision_date: '',
  classes_start_on: '',
  classes_end_on: '',
  capacity: '',
  is_open: true,
  notes: '',
});

function fromIntake(i: ProgramIntakeRow): FormValues {
  return {
    intake_label: i.intake_label,
    intake_year: String(i.intake_year),
    intake_month: String(i.intake_month),
    application_open: i.application_open ? i.application_open.slice(0, 10) : '',
    application_close: i.application_close ? i.application_close.slice(0, 10) : '',
    decision_date: i.decision_date ? i.decision_date.slice(0, 10) : '',
    classes_start_on: i.classes_start_on ? i.classes_start_on.slice(0, 10) : '',
    classes_end_on: i.classes_end_on ? i.classes_end_on.slice(0, 10) : '',
    capacity: i.capacity != null ? String(i.capacity) : '',
    is_open: i.is_open,
    notes: i.notes ?? '',
  };
}

function buildPayload(v: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    intake_label: v.intake_label.trim(),
    intake_year: Number(v.intake_year),
    intake_month: Number(v.intake_month),
    is_open: v.is_open,
  };
  if (v.application_open.trim()) out['application_open'] = v.application_open;
  if (v.application_close.trim()) out['application_close'] = v.application_close;
  if (v.decision_date.trim()) out['decision_date'] = v.decision_date;
  if (v.classes_start_on.trim()) out['classes_start_on'] = v.classes_start_on;
  if (v.classes_end_on.trim()) out['classes_end_on'] = v.classes_end_on;
  if (v.capacity.trim()) out['capacity'] = Number(v.capacity);
  if (v.notes.trim()) out['notes'] = v.notes.trim();
  return out;
}

export type IntakeDialogProps = {
  open: boolean;
  programId: string;
  intake: ProgramIntakeRow | null;
  /**
   * Pre-fills the form with values shifted forward one year. Used by the
   * "Clone latest intake" action on the program detail page. Ignored when
   * `intake` is provided (edit mode always wins).
   */
  cloneFrom?: ProgramIntakeRow | null;
  /**
   * Parent program. When provided and `program.duration_pattern` is set, the
   * dialog computes intake-label and class-date *suggestions* (helper text).
   * Suggestions are never auto-applied — the user must click "Use suggestion".
   * If omitted, the dialog will try to fetch the program lightly.
   */
  program?: ProgramRow | null;
  onClose: () => void;
};

// ---- Cadence-driven suggestion helpers ----------------------------------

function suggestIntakeLabel(
  pattern: DurationPattern | null | undefined,
  year: number,
  month: number,
): string | null {
  if (!pattern || !Number.isFinite(year) || !Number.isFinite(month)) return null;
  const monthName = MONTHS.find((m) => m.value === month)?.label;
  switch (pattern) {
    case 'SEMESTER_2_PER_YEAR':
      // Northern-hemisphere convention: Aug-Dec = Fall, Jan-May = Spring,
      // Jun-Jul = Summer.
      if (month >= 8 && month <= 12) return `Fall ${year}`;
      if (month >= 1 && month <= 5) return `Spring ${year}`;
      return `Summer ${year}`;
    case 'TRIMESTER_3_PER_YEAR': {
      // Group months 1-4 / 5-8 / 9-12.
      const t = month <= 4 ? 1 : month <= 8 ? 2 : 3;
      return `T${t} ${year}`;
    }
    case 'QUARTER_4_PER_YEAR': {
      const q = Math.ceil(month / 3);
      return `Q${q} ${year}`;
    }
    case 'ANNUAL_COHORT':
      return `Year ${year}`;
    case 'BIANNUAL_2_YEARS':
      // Conventionally two cohorts: January and July.
      return month >= 7 ? `July ${year} cohort` : `January ${year} cohort`;
    case 'MONTHLY_INTAKE':
      return monthName ? `${monthName} ${year}` : null;
    case 'CONTINUOUS_ENROLLMENT':
    case 'MODULAR':
    default:
      return null;
  }
}

function addMonthsIso(year: number, month: number, monthsToAdd: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  // month is 1-indexed in our form; Date is 0-indexed.
  const start = new Date(Date.UTC(year, month - 1, 1));
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + monthsToAdd);
  // Step back one day so end-date is inclusive of the last term.
  end.setUTCDate(end.getUTCDate() - 1);
  return end.toISOString().slice(0, 10);
}

function suggestClassesStart(year: number, month: number): string | null {
  if (!Number.isFinite(year) || !Number.isFinite(month)) return null;
  const d = new Date(Date.UTC(year, month - 1, 1));
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

function cloneFromIntake(i: ProgramIntakeRow): FormValues {
  const base = fromIntake(i);
  // Shift dates +1 year and bump the intake_year. Capacity is preserved; the
  // intake_label drops the year (admin can edit before saving).
  const shift = (iso: string): string => {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    d.setFullYear(d.getFullYear() + 1);
    return d.toISOString().slice(0, 10);
  };
  const nextYear = i.intake_year + 1;
  const monthName =
    MONTHS.find((m) => m.value === i.intake_month)?.label ?? base.intake_label;
  return {
    ...base,
    intake_year: String(nextYear),
    intake_label: `${monthName} ${nextYear}`,
    application_open: shift(base.application_open),
    application_close: shift(base.application_close),
    decision_date: shift(base.decision_date),
    classes_start_on: shift(base.classes_start_on),
    classes_end_on: shift(base.classes_end_on),
    is_open: true,
    notes: '',
  };
}

export default function IntakeDialog({
  open,
  programId,
  intake,
  cloneFrom,
  program,
  onClose,
}: IntakeDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const isEdit = Boolean(intake);
  const isClone = !intake && Boolean(cloneFrom);

  // If the caller didn't pass a program, fetch it (lightly) so we can drive
  // cadence-based suggestions. Skipped in edit mode since suggestions only
  // matter for greenfield intakes.
  const programQ = useQuery({
    queryKey: ['programs', 'detail', programId],
    enabled: open && !program && !isEdit && Boolean(programId),
    queryFn: async () => {
      const res = await api.get<ProgramRow>(`/programs/${programId}`);
      return res.data;
    },
    staleTime: 60_000,
  });
  const effectiveProgram: ProgramRow | null | undefined = program ?? programQ.data;

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    setValue,
    watch,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: empty() });

  useEffect(() => {
    if (!open) return;
    if (intake) reset(fromIntake(intake));
    else if (cloneFrom) reset(cloneFromIntake(cloneFrom));
    else reset(empty());
  }, [open, intake, cloneFrom, reset]);

  const mut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (intake) {
        const res = await api.patch(`/programs/intakes/${intake.id}`, payload);
        return res.data;
      }
      const res = await api.post(`/programs/${programId}/intakes`, payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'Intake updated.' : 'Intake added.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['programs', 'detail', programId] });
      void qc.invalidateQueries({ queryKey: ['programs', programId, 'intakes'] });
      // Refresh the courses list so the per-row intake count chip updates.
      void qc.invalidateQueries({ queryKey: ['programs', 'list'] });
      void qc.invalidateQueries({ queryKey: ['institutions'] });
      onClose();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        for (const fe of err.errors) {
          if (fe.path in (empty() as object)) {
            setError(fe.path as keyof FormValues, { type: 'server', message: fe.message });
          }
        }
        enqueueSnackbar(err.detail || err.title || 'Failed.', { variant: 'error' });
      } else {
        enqueueSnackbar('Network error.', { variant: 'error' });
      }
    },
  });

  // Compute suggestions reactively from the current form values + the
  // parent program's cadence. These are display-only — applied via buttons.
  const watchedYear = watch('intake_year');
  const watchedMonth = watch('intake_month');
  const watchedLabel = watch('intake_label');
  const watchedClassesStart = watch('classes_start_on');
  const watchedClassesEnd = watch('classes_end_on');

  const suggestions = useMemo(() => {
    const pattern = effectiveProgram?.duration_pattern ?? null;
    const yearN = Number(watchedYear);
    const monthN = Number(watchedMonth);
    const durationMonths = effectiveProgram?.duration_months ?? null;

    const labelSugg = suggestIntakeLabel(pattern, yearN, monthN);
    const startSugg = suggestClassesStart(yearN, monthN);
    const endSugg =
      durationMonths != null ? addMonthsIso(yearN, monthN, durationMonths) : null;

    return {
      label: labelSugg && labelSugg !== watchedLabel.trim() ? labelSugg : null,
      // Suggestions only when *both* class-date fields are blank — never
      // overwrite values the admin already entered.
      classesStart:
        !watchedClassesStart.trim() && !watchedClassesEnd.trim() ? startSugg : null,
      classesEnd:
        !watchedClassesStart.trim() && !watchedClassesEnd.trim() ? endSugg : null,
    };
  }, [
    effectiveProgram,
    watchedYear,
    watchedMonth,
    watchedLabel,
    watchedClassesStart,
    watchedClassesEnd,
  ]);

  const onSubmit = handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      const payload = buildPayload(values);
      const schema = isEdit ? UpdateProgramIntakeRequest : CreateProgramIntakeRequest;
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const path = issue.path[0]?.toString();
          if (path && path in (empty() as object)) {
            setError(path as keyof FormValues, {
              type: 'validate',
              message: issue.message,
            });
          }
        }
        return;
      }
      await mut.mutateAsync(payload);
    } finally {
      setSubmitting(false);
    }
  });

  const { disabled: saveDisabled, reason: saveBlockedReason } = useSaveBlockedReason({
    isDirty,
    isSubmitting,
    submitting: submitting || mut.isPending,
  });

  // Build the dynamic helperText nodes once so LabeledField receives a single
  // ReactNode (it accepts string only by type, but renders ReactNode children fine).
  const labelHelperNode: React.ReactNode =
    errors.intake_label?.message ??
    (suggestions.label ? (
      <Box component="span" sx={{ display: 'inline-flex', gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span>Suggested: {suggestions.label}</span>
        <Button
          size="small"
          variant="text"
          sx={{ minWidth: 0, p: 0, textTransform: 'none' }}
          onClick={() =>
            setValue('intake_label', suggestions.label ?? '', {
              shouldDirty: true,
            })
          }
        >
          Use suggestion
        </Button>
      </Box>
    ) : null);

  const classesStartHelperNode: React.ReactNode =
    errors.classes_start_on?.message ??
    (suggestions.classesStart ? (
      <Box component="span" sx={{ display: 'inline-flex', gap: 1, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span>Suggested: {suggestions.classesStart}</span>
        <Button
          size="small"
          variant="text"
          sx={{ minWidth: 0, p: 0, textTransform: 'none' }}
          onClick={() => {
            if (suggestions.classesStart) {
              setValue('classes_start_on', suggestions.classesStart, {
                shouldDirty: true,
              });
            }
            if (suggestions.classesEnd) {
              setValue('classes_end_on', suggestions.classesEnd, {
                shouldDirty: true,
              });
            }
          }}
        >
          Use suggestion
        </Button>
      </Box>
    ) : null);

  const classesEndHelperText =
    errors.classes_end_on?.message ??
    (suggestions.classesEnd
      ? `Suggested: ${suggestions.classesEnd} (start + ${effectiveProgram?.duration_months ?? '?'} months)`
      : '');

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit intake' : isClone ? 'Clone latest intake' : 'New intake'}
      subtitle={
        isClone
          ? 'Dates have been shifted forward by one year. Review and adjust before saving.'
          : undefined
      }
      maxWidth="md"
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Add intake',
        loadingLabel: 'Saving…',
        loading: submitting,
        formId: 'intake-form',
        disabled: saveDisabled,
      }}
    >
      <Box component="form" id="intake-form" onSubmit={onSubmit} noValidate sx={FORM_BOX_SX}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>

        {/* --- Schedule --------------------------------------------- */}
        <FormSection
          title="Schedule"
          subtitle="When this intake runs"
          icon={<EventNoteOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12}>
              {/* Cadence-driven suggestion node passed via helperText slot,
                  preserving the original "Use suggestion" interaction. */}
              <LabeledField
                label="Label"
                required
                error={Boolean(errors.intake_label)}
                helperText={labelHelperNode as unknown as string}
                htmlFor="ik-label"
              >
                <TextField
                  id="ik-label"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="September 2026"
                  error={Boolean(errors.intake_label)}
                  {...register('intake_label', { required: 'Required' })}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <LabeledField
                label="Year"
                required
                error={Boolean(errors.intake_year)}
                helperText={errors.intake_year?.message ?? ''}
                htmlFor="ik-year"
              >
                <TextField
                  id="ik-year"
                  type="number"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="2026"
                  error={Boolean(errors.intake_year)}
                  {...register('intake_year', { required: 'Required' })}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <LabeledField
                label="Month"
                required
                error={Boolean(errors.intake_month)}
                helperText={errors.intake_month?.message ?? ''}
                htmlFor="ik-month"
              >
                <Controller
                  name="intake_month"
                  control={control}
                  render={({ field }) => (
                    <TextField
                      {...field}
                      id="ik-month"
                      select
                      fullWidth
                      size="medium"
                      hiddenLabel
                      error={Boolean(errors.intake_month)}
                    >
                      {MONTHS.map((m) => (
                        <MenuItem key={m.value} value={String(m.value)}>
                          {m.label}
                        </MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <LabeledField label="Open for applications">
                <Controller
                  name="is_open"
                  control={control}
                  render={({ field }) => (
                    <FormControlLabel
                      sx={{ m: 0, height: 44, alignItems: 'center' }}
                      control={
                        <Switch
                          checked={field.value}
                          onChange={(_, c) => field.onChange(c)}
                        />
                      }
                      label={field.value ? 'Open' : 'Closed'}
                    />
                  )}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        {/* --- Applications ----------------------------------------- */}
        <FormSection
          title="Applications"
          subtitle="Open / close window and decision date"
          icon={<AssignmentOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={4}>
              <LabeledField
                label="Application opens"
                error={Boolean(errors.application_open)}
                helperText={errors.application_open?.message ?? ''}
                htmlFor="ik-app_open"
              >
                <TextField
                  id="ik-app_open"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.application_open)}
                  {...register('application_open')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <LabeledField
                label="Application closes"
                error={Boolean(errors.application_close)}
                helperText={errors.application_close?.message ?? ''}
                htmlFor="ik-app_close"
              >
                <TextField
                  id="ik-app_close"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.application_close)}
                  {...register('application_close')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <LabeledField
                label="Decision date"
                error={Boolean(errors.decision_date)}
                helperText={errors.decision_date?.message ?? ''}
                htmlFor="ik-decision"
              >
                <TextField
                  id="ik-decision"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.decision_date)}
                  {...register('decision_date')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        {/* --- Classes ---------------------------------------------- */}
        <FormSection
          title="Classes"
          subtitle="Term dates and seat capacity"
          icon={<ClassOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={4}>
              {/* Cadence suggestion rendered via helperText slot. */}
              <LabeledField
                label="Classes start"
                error={Boolean(errors.classes_start_on)}
                helperText={classesStartHelperNode as unknown as string}
                htmlFor="ik-classes_start"
              >
                <TextField
                  id="ik-classes_start"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.classes_start_on)}
                  {...register('classes_start_on')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <LabeledField
                label="Classes end"
                error={Boolean(errors.classes_end_on)}
                helperText={classesEndHelperText}
                htmlFor="ik-classes_end"
              >
                <TextField
                  id="ik-classes_end"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.classes_end_on)}
                  {...register('classes_end_on')}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <LabeledField
                label="Capacity"
                error={Boolean(errors.capacity)}
                helperText={errors.capacity?.message ?? ''}
                htmlFor="ik-capacity"
              >
                <TextField
                  id="ik-capacity"
                  type="number"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  placeholder="120"
                  error={Boolean(errors.capacity)}
                  {...register('capacity')}
                />
              </LabeledField>
            </Grid>
          </Grid>
        </FormSection>

        {/* --- Notes ------------------------------------------------ */}
        <FormSection
          title="Notes"
          subtitle="Internal commentary, not shown to applicants"
          icon={<StickyNote2OutlinedIcon />}
          iconColor="muted"
          compact
        >
          <LabeledField
            label="Notes"
            error={Boolean(errors.notes)}
            helperText={errors.notes?.message ?? ''}
            htmlFor="ik-notes"
          >
            <TextField
              id="ik-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={2}
              placeholder="e.g. Pre-CAS interviews scheduled in August"
              error={Boolean(errors.notes)}
              {...register('notes')}
            />
          </LabeledField>
        </FormSection>

        {saveBlockedReason && (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 1, textAlign: 'right' }}
          >
            {saveBlockedReason}
          </Typography>
        )}
      </Box>
    </AppDialog>
  );
}
