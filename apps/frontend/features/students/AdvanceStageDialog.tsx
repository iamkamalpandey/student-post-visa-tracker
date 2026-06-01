// Refactored to SVT form-pattern (LabeledField + FormSection compact) per design pass.
'use client';

import { useEffect, useMemo } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Box,
  Chip,
  IconButton,
  ListSubheader,
  MenuItem,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import TimelineOutlinedIcon from '@mui/icons-material/TimelineOutlined';
import EventNoteOutlinedIcon from '@mui/icons-material/EventNoteOutlined';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import HelpOutlineOutlinedIcon from '@mui/icons-material/HelpOutlineOutlined';
import { useTranslations } from 'next-intl';
import { z } from 'zod';
import dayjs from 'dayjs';
import { Uuid } from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useUserContext } from '@/lib/format';
import { useStageTransitions } from '@/lib/queries';
import { isAdmin } from '@/lib/auth-helpers';
import AppDialog from '@/components/AppDialog';
import FormSection from '@/components/FormSection';
import LabeledField from '@/components/LabeledField';

type StageOption = {
  id: string;
  key: string;
  label: string;
  sequence: number;
  is_initial?: boolean;
  // SVT-LIFECYCLE-2026-05: needed to hide soft-deleted / inactive stages from
  // the dropdown. The list endpoint already filters inactive for non-admins,
  // but we double-check here so admins viewing `?include_inactive=true` (a
  // future toggle) don't get them in the advance dialog.
  is_active?: boolean;
  // v6: when present the dialog renders an extra <DateField> with this label
  // and forwards the captured value as `prompt_date_value` in the request.
  prompt_date_label?: string | null;
};

type Props = {
  open: boolean;
  onClose: () => void;
  studentId: string;
  currentStageId: string | null;
  stages: StageOption[];
};

// Local form schema — we collect a `datetime-local` value and convert it to ISO 8601
// with offset before sending to the server. Notes/reason_code are optional at this
// layer; the dialog adds an inline required-validation rule when the chosen target
// is a backward move (sequence < current.sequence).
//
// v6: prompt_date_value is captured by an extra <input type="date"> when the
// destination stage has a non-empty prompt_date_label. ISO date (YYYY-MM-DD).
const FormSchema = z.object({
  to_stage_id: Uuid,
  effective_at_local: z.string().optional(),
  reason_code: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
  prompt_date_value: z.string().optional(),
});
type FormValues = z.infer<typeof FormSchema>;

function nowLocalIsoMinutes(userTz: string): string {
  // Format current wall-clock time *in the user's configured timezone* as
  // `YYYY-MM-DDTHH:mm` for `<input type="datetime-local">`.
  return dayjs().tz(userTz).format('YYYY-MM-DDTHH:mm');
}

function localToOffsetIso(local: string, userTz: string): string {
  // Interpret the wall-clock value in the user's timezone, then emit UTC ISO.
  return dayjs.tz(local, userTz).utc().toISOString();
}

export default function AdvanceStageDialog({
  open,
  onClose,
  studentId,
  currentStageId,
  stages,
}: Props) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { timezone: userTz } = useUserContext();
  const { user } = useAuth();
  const t = useTranslations('students.advanceStage');

  // SVT-LIFECYCLE-2026-05: hide inactive stages and pre-sort. Active filter
  // tolerates omitted `is_active` (treated as active) so existing list calls
  // that don't request the column don't accidentally hide everything.
  const sortedStages = useMemo<StageOption[]>(
    () =>
      [...stages]
        .filter((s) => s.is_active !== false)
        .sort((a, b) => a.sequence - b.sequence),
    [stages],
  );

  const currentStage = useMemo<StageOption | null>(
    () => sortedStages.find((s) => s.id === currentStageId) ?? null,
    [sortedStages, currentStageId],
  );

  // SVT-LIFECYCLE-2026-05: when the matrix has rows for the current stage,
  // it ENFORCES the allowed targets. When empty, we fall back to the
  // sequence-direction rule (forward = free, backward = admin + reason).
  const transitionsQuery = useStageTransitions(currentStageId);
  const allowedTargetIds = useMemo<Set<string>>(() => {
    const rows = transitionsQuery.data ?? [];
    return new Set(rows.map((r) => r.to_stage_id));
  }, [transitionsQuery.data]);
  const matrixActive = (transitionsQuery.data?.length ?? 0) > 0;

  // Bucket the candidate stages relative to the current sequence.
  const groups = useMemo(() => {
    if (!currentStage) {
      return {
        suggested: null as StageOption | null,
        forward: [] as StageOption[],
        backward: [] as StageOption[],
      };
    }
    const cur = currentStage;
    const suggested =
      sortedStages.find((s) => s.sequence === cur.sequence + 1 && s.id !== cur.id) ?? null;
    const forward = sortedStages.filter(
      (s) => s.sequence > cur.sequence && s.id !== cur.id && s.id !== suggested?.id,
    );
    const backward = sortedStages.filter(
      (s) => s.sequence < cur.sequence && s.id !== cur.id,
    );
    return { suggested, forward, backward };
  }, [sortedStages, currentStage]);

  const userIsAdmin = isAdmin(user?.role ?? null);

  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    watch,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      to_stage_id: '',
      effective_at_local: nowLocalIsoMinutes(userTz),
      reason_code: '',
      notes: '',
      prompt_date_value: '',
    },
  });

  useEffect(() => {
    if (open) {
      reset({
        to_stage_id: '',
        effective_at_local: nowLocalIsoMinutes(userTz),
        reason_code: '',
        notes: '',
        prompt_date_value: '',
      });
    }
  }, [open, reset, userTz]);

  // v6: derive the prompt-date label from the currently-selected target stage so
  // the date field appears / disappears as the admin chooses different stages.
  const selectedToStageId = watch('to_stage_id');
  const selectedStage = useMemo<StageOption | null>(
    () => sortedStages.find((s) => s.id === selectedToStageId) ?? null,
    [selectedToStageId, sortedStages],
  );
  const promptDateLabel = useMemo<string | null>(() => {
    const label = selectedStage?.prompt_date_label;
    return label && label.trim().length > 0 ? label : null;
  }, [selectedStage]);

  // Detect the user picking a backward target so the dialog can render the
  // inline alert + flip reason_code to required.
  const isBackwardSelected = useMemo<boolean>(() => {
    if (!selectedStage || !currentStage) return false;
    return selectedStage.sequence < currentStage.sequence;
  }, [selectedStage, currentStage]);

  const advance = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      const payload: Record<string, unknown> = { to_stage_id: values.to_stage_id };
      if (values.effective_at_local) {
        payload['effective_at'] = localToOffsetIso(values.effective_at_local, userTz);
      }
      if (values.reason_code) payload['reason_code'] = values.reason_code;
      if (values.notes) payload['notes'] = values.notes;
      // v6: only forward the prompt_date_value when the chosen stage actually
      // requested one — otherwise the backend zod schema rejects unknown extras.
      if (promptDateLabel && values.prompt_date_value) {
        payload['prompt_date_value'] = values.prompt_date_value;
      }
      const res = await api.post(`/students/${studentId}/transitions`, payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(t('successToast'), { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['student', studentId] });
      qc.invalidateQueries({ queryKey: ['student-timeline', studentId] });
      qc.invalidateQueries({ queryKey: ['students'] });
      // SVT-WAVE41-DASH-INVALIDATE-2026-05 — stage transitions move students
      // in/out of SLA-bearing stages and update the pipeline totals on the
      // dashboard summary. Without these, the user sees a stale widget for
      // up to 30s after acting on a breach.
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      onClose();
    },
    onError: (err) => {
      for (const fe of err.errors ?? []) {
        const path = fe.path.split('.').pop();
        if (path === 'to_stage_id' || path === 'reason_code' || path === 'notes') {
          setError(path as keyof FormValues, { type: 'server', message: fe.message });
        }
      }
      enqueueSnackbar(err.detail || err.title || t('errorToast'), {
        variant: 'error',
      });
    },
  });

  const onSubmit = handleSubmit((values) => {
    // Client-side guard: backward transitions need a >=3 char reason. Mirrors
    // the backend so the user sees the field error inline rather than a 422.
    if (isBackwardSelected) {
      const r = (values.reason_code ?? '').trim();
      if (r.length < 3) {
        setError('reason_code', {
          type: 'manual',
          message: t('reasonRequiredBackward'),
        });
        return;
      }
    }
    advance.mutate(values);
  });

  const topLevelError =
    advance.isError && advance.error && !advance.error.errors?.length
      ? advance.error.detail || advance.error.title || null
      : null;

  // Helper to flag matrix-disallowed targets when the matrix is active.
  // Counsellors don't see disallowed items at all (they're filtered out
  // upstream); admins see them grouped but each gets a warning chip + the
  // backend still 422s if they try to submit.
  const isMatrixDisallowed = (stageId: string): boolean =>
    matrixActive && !allowedTargetIds.has(stageId);

  // For counsellors, intersect forward/backward with the matrix when it's
  // active — admins keep the full sets (with disallowed items annotated).
  const visibleForward = useMemo<StageOption[]>(() => {
    if (matrixActive && !userIsAdmin) {
      return groups.forward.filter((s) => allowedTargetIds.has(s.id));
    }
    return groups.forward;
  }, [groups.forward, matrixActive, userIsAdmin, allowedTargetIds]);

  const suggestedAllowed =
    !matrixActive || userIsAdmin || (groups.suggested && allowedTargetIds.has(groups.suggested.id))
      ? groups.suggested
      : null;

  const visibleBackward = useMemo<StageOption[]>(() => {
    if (matrixActive && !userIsAdmin) {
      return groups.backward.filter((s) => allowedTargetIds.has(s.id));
    }
    return groups.backward;
  }, [groups.backward, matrixActive, userIsAdmin, allowedTargetIds]);

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t('title')}
      subtitle={t('subtitle')}
      errorText={topLevelError}
      primaryAction={{
        label: 'Advance stage',
        loadingLabel: 'Advancing…',
        loading: isSubmitting,
        disabled: !isDirty || isSubmitting || advance.isPending,
        formId: 'advance-stage-form',
      }}
    >
      <Box
        component="form"
        id="advance-stage-form"
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

        <FormSection
          title="Target stage"
          subtitle="Choose where this student should move to next"
          icon={<TimelineOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Stack spacing={2}>
            {/* SVT-WAVE-POLISH-2026-05 — Allowed-transitions hint. When the
                stage transition matrix is active, show a help icon next to
                the field that lists the explicitly-allowed targets so the
                user knows why some stages are missing/disabled. */}
            {matrixActive ? (
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: -1 }}>
                <Typography variant="caption" color="text.secondary">
                  Allowed transitions from {currentStage?.label ?? 'current stage'}
                </Typography>
                <Tooltip
                  arrow
                  placement="right"
                  title={
                    allowedTargetIds.size === 0 ? (
                      <Typography variant="caption">
                        No transitions are allowed from this stage.
                      </Typography>
                    ) : (
                      <Box>
                        <Typography variant="caption" sx={{ display: 'block', fontWeight: 600, mb: 0.5 }}>
                          Allowed targets
                        </Typography>
                        {sortedStages
                          .filter((s) => allowedTargetIds.has(s.id))
                          .map((s) => (
                            <Typography key={s.id} variant="caption" sx={{ display: 'block' }}>
                              · {s.label}
                            </Typography>
                          ))}
                      </Box>
                    )
                  }
                >
                  <IconButton size="small" aria-label="Show allowed transitions">
                    <HelpOutlineOutlinedIcon fontSize="inherit" />
                  </IconButton>
                </Tooltip>
              </Stack>
            ) : null}

            <Controller
              name="to_stage_id"
              control={control}
              render={({ field }) => (
                <LabeledField
                  label={t('targetStage')}
                  required
                  error={Boolean(errors.to_stage_id)}
                  helperText={errors.to_stage_id?.message ?? ''}
                  htmlFor="adv-to-stage"
                >
                  <TextField
                    id="adv-to-stage"
                    select
                    fullWidth
                    size="medium"
                    hiddenLabel
                    error={Boolean(errors.to_stage_id)}
                    SelectProps={{
                      MenuProps: { PaperProps: { sx: { maxHeight: 480 } } },
                    }}
                    {...field}
                  >
                    {/* --- Current --- */}
                    {currentStage && [
                      <ListSubheader key="grp-current">{t('groupCurrent')}</ListSubheader>,
                      <MenuItem key={currentStage.id} value={currentStage.id} disabled>
                        {currentStage.label} {t('currentSuffix')}
                      </MenuItem>,
                    ]}

                    {/* --- Suggested next --- */}
                    {suggestedAllowed && [
                      <ListSubheader key="grp-suggested">{t('groupSuggested')}</ListSubheader>,
                      <MenuItem
                        key={suggestedAllowed.id}
                        value={suggestedAllowed.id}
                        sx={{ color: 'success.main', fontWeight: 600 }}
                      >
                        {suggestedAllowed.label}
                        {isMatrixDisallowed(suggestedAllowed.id) && userIsAdmin ? (
                          <Chip
                            label={t('matrixDisallowed')}
                            size="small"
                            color="warning"
                            sx={{ ml: 1 }}
                          />
                        ) : null}
                      </MenuItem>,
                    ]}

                    {/* --- Other forward stages --- */}
                    {visibleForward.length > 0 && [
                      <ListSubheader key="grp-forward">{t('groupForward')}</ListSubheader>,
                      ...visibleForward.map((s) => (
                        <MenuItem key={s.id} value={s.id}>
                          {s.label}
                          {isMatrixDisallowed(s.id) && userIsAdmin ? (
                            <Chip
                              label={t('matrixDisallowed')}
                              size="small"
                              color="warning"
                              sx={{ ml: 1 }}
                            />
                          ) : null}
                        </MenuItem>
                      )),
                    ]}

                    {/* --- Move backward (admin override) --- */}
                    {visibleBackward.length > 0 && userIsAdmin && [
                      <ListSubheader key="grp-backward">{t('groupBackward')}</ListSubheader>,
                      ...visibleBackward.map((s) => (
                        <MenuItem
                          key={s.id}
                          value={s.id}
                          sx={{ color: 'warning.main' }}
                        >
                          {`← ${s.label}`}
                          {isMatrixDisallowed(s.id) ? (
                            <Chip
                              label={t('matrixDisallowed')}
                              size="small"
                              color="warning"
                              sx={{ ml: 1 }}
                            />
                          ) : null}
                        </MenuItem>
                      )),
                    ]}
                    {visibleBackward.length > 0 && !userIsAdmin && [
                      <ListSubheader key="grp-backward-disabled">
                        {t('groupBackwardDisabled')}
                      </ListSubheader>,
                      ...visibleBackward.map((s) => (
                        <MenuItem key={s.id} value={s.id} disabled>
                          {`← ${s.label}`}
                        </MenuItem>
                      )),
                    ]}
                  </TextField>
                </LabeledField>
              )}
            />

            {isBackwardSelected ? (
              <Alert severity="warning" variant="outlined">
                {t('backwardWarning')}
              </Alert>
            ) : null}
          </Stack>
        </FormSection>

        <FormSection
          title="Timing"
          subtitle="When the transition takes effect"
          icon={<EventNoteOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Stack spacing={2}>
            <LabeledField label="Effective at" htmlFor="adv-effective-at">
              <TextField
                id="adv-effective-at"
                type="datetime-local"
                fullWidth
                size="medium"
                hiddenLabel
                {...register('effective_at_local')}
              />
            </LabeledField>

            {promptDateLabel ? (
              <LabeledField
                label={promptDateLabel}
                required
                helperText="Required by this stage"
                htmlFor="adv-prompt-date"
              >
                <TextField
                  id="adv-prompt-date"
                  type="date"
                  fullWidth
                  size="medium"
                  hiddenLabel
                  {...register('prompt_date_value')}
                />
              </LabeledField>
            ) : null}
          </Stack>
        </FormSection>

        <FormSection
          title="Audit context"
          subtitle="Reason and notes recorded against the transition"
          icon={<StickyNote2OutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Stack spacing={2}>
            <LabeledField
              label="Reason code"
              required={isBackwardSelected}
              error={Boolean(errors.reason_code)}
              helperText={errors.reason_code?.message ?? ''}
              htmlFor="adv-reason-code"
            >
              <TextField
                id="adv-reason-code"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder={isBackwardSelected ? 'e.g. STUDENT_REQUEST' : 'e.g. CAS_ISSUED'}
                error={Boolean(errors.reason_code)}
                {...register('reason_code')}
              />
            </LabeledField>

            <LabeledField
              label="Notes"
              error={Boolean(errors.notes)}
              helperText={errors.notes?.message ?? 'Context for the audit log'}
              htmlFor="adv-notes"
            >
              <TextField
                id="adv-notes"
                fullWidth
                hiddenLabel
                multiline
                minRows={3}
                placeholder="Counsellor met student on Monday; documents verified."
                error={Boolean(errors.notes)}
                {...register('notes')}
              />
            </LabeledField>
          </Stack>
        </FormSection>
      </Box>
    </AppDialog>
  );
}
