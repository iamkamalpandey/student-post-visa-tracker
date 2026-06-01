'use client';

// Refactored to SVT form-pattern per design pass.
import { useEffect, useMemo } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Autocomplete,
  Box,
  FormControlLabel,
  MenuItem,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import TuneOutlinedIcon from '@mui/icons-material/TuneOutlined';
import LabelOutlinedIcon from '@mui/icons-material/LabelOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import ChecklistOutlinedIcon from '@mui/icons-material/ChecklistOutlined';
import { useQuery } from '@tanstack/react-query';
import {
  CreateStageRequest,
  UpdateStageRequest,
  type StageCategory,
} from '@spv/zod-schemas';
import { ApiError, api } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import FormSection from '@/components/FormSection';
import StageChecklistEditor from './StageChecklistEditor';
import type { Stage, VisaTypeOption } from './types';

type Props = {
  open: boolean;
  stage: Stage | null;
  onClose: () => void;
  /** Used to suggest the next sequence on Create. */
  nextSequence: number;
};

type FormValues = {
  key: string;
  label: string;
  description: string;
  sequence: number;
  category: StageCategory;
  color_hex: string;
  icon: string;
  is_initial: boolean;
  is_terminal: boolean;
  sla_hours: string; // string in form, coerced to number on submit
  destination_country: string;
  // v6 ---------------------------------------------------------------
  visa_type_id: string | null;
  is_outcome_success: boolean;
  is_outcome_failure: boolean;
  show_on_dashboard: boolean;
  prompt_date_label: string;
};

const CATEGORY_OPTIONS: { value: FormValues['category']; label: string }[] = [
  { value: 'PRE_DEPARTURE', label: 'Pre-departure' },
  { value: 'IN_TRANSIT', label: 'In transit' },
  { value: 'POST_ARRIVAL', label: 'Post-arrival' },
  { value: 'ENROLLED', label: 'Enrolled' },
  { value: 'COMPLETED', label: 'Completed' },
  { value: 'EXCEPTION', label: 'Exception' },
  { value: 'IN_PROGRESS', label: 'In progress' },
];

function emptyDefaults(seq: number): FormValues {
  return {
    key: '',
    label: '',
    description: '',
    sequence: seq,
    category: 'IN_PROGRESS',
    color_hex: '#1976d2',
    icon: '',
    is_initial: false,
    is_terminal: false,
    sla_hours: '',
    destination_country: '',
    visa_type_id: null,
    is_outcome_success: false,
    is_outcome_failure: false,
    show_on_dashboard: true,
    prompt_date_label: '',
  };
}

function fromStage(s: Stage): FormValues {
  return {
    key: s.key,
    label: s.label,
    description: s.description ?? '',
    sequence: s.sequence,
    category: s.category,
    color_hex: s.color_hex ?? '#1976d2',
    icon: s.icon ?? '',
    is_initial: s.is_initial,
    is_terminal: s.is_terminal,
    sla_hours: s.sla_hours == null ? '' : String(s.sla_hours),
    destination_country: s.destination_country ?? '',
    visa_type_id: s.visa_type_id ?? null,
    is_outcome_success: s.is_outcome_success ?? false,
    is_outcome_failure: s.is_outcome_failure ?? false,
    show_on_dashboard: s.show_on_dashboard ?? true,
    prompt_date_label: s.prompt_date_label ?? '',
  };
}

export default function StageEditDialog({ open, stage, onClose, nextSequence }: Props) {
  const isEdit = stage !== null;
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  // v6: load the visa-types catalogue for the optional autocomplete. Cheap to
  // share via react-query — same key the /visa-types page uses (with a "all"
  // suffix to avoid clashing with the country-filtered list there).
  const visaTypesQuery = useQuery({
    queryKey: ['visa-types', null],
    queryFn: async () => {
      const res = await api.get<{ data: VisaTypeOption[] }>('/visa-types');
      return res.data.data;
    },
    enabled: open,
  });

  const defaults = useMemo<FormValues>(
    () => (stage ? fromStage(stage) : emptyDefaults(nextSequence)),
    [stage, nextSequence],
  );

  // We resolve against CreateStageRequest for the new flow and UpdateStageRequest for edits.
  // The form-level shape is identical; the only difference is `partial()` on update.
  const resolverSchema = isEdit ? UpdateStageRequest : CreateStageRequest;

  const {
    control,
    handleSubmit,
    reset,
    register,
    watch,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    defaultValues: defaults,
    // We hand-shape the payload before validation, so use a thin custom resolver
    // that converts form strings → API shape and then runs the zod schema.
    resolver: (async (values: FormValues) => {
      const payload = toPayload(values);
      const parsed = resolverSchema.safeParse(payload);
      if (parsed.success) return { values, errors: {} };
      // Map zod errors back onto form fields (best-effort).
      const fieldErrors: Record<string, { type: string; message: string }> = {};
      for (const issue of parsed.error.issues) {
        const path = issue.path[0];
        if (typeof path === 'string') {
          fieldErrors[path] = { type: 'validation', message: issue.message };
        }
      }
      return { values: {}, errors: fieldErrors };
    }) as Resolver<FormValues>,
  });

  // Reset whenever we open with a different stage.
  useEffect(() => {
    if (open) reset(defaults);
  }, [open, defaults, reset]);

  const colorValue = watch('color_hex');

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const payload = toPayload(values);
      if (isEdit && stage) {
        const res = await api.patch(`/stages/${stage.id}`, payload);
        return res.data as Stage;
      }
      const res = await api.post('/stages', payload);
      return res.data as Stage;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'Stage updated' : 'Stage created', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['stages'] });
      onClose();
    },
    onError: (err: unknown) => {
      const message = err instanceof ApiError ? err.detail || err.title : 'Save failed';
      enqueueSnackbar(message, { variant: 'error' });
    },
  });

  // Save gating: on Create allow saving immediately; on Edit require a change.
  const saveBlockedReason =
    isEdit && !isDirty ? 'Make a change to enable saving' : null;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={isEdit ? `Edit stage: ${stage?.label}` : 'New stage'}
      subtitle={isEdit ? 'Update the stage definition. Changes apply to all students immediately.' : 'Define a new lifecycle stage. Sequence determines its position in the pipeline.'}
      maxWidth="sm"
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Create stage',
        loadingLabel: isEdit ? 'Saving…' : 'Creating…',
        loading: isSubmitting || mutation.isPending,
        disabled: Boolean(saveBlockedReason) || isSubmitting || mutation.isPending,
        onClick: handleSubmit((v) => mutation.mutate(v)),
      }}
    >
      <Box
        component="form"
        noValidate
        onSubmit={handleSubmit((v) => mutation.mutate(v))}
        sx={{
          // Standardise input heights to 44px so date, text, select,
          // autocomplete align vertically. Multiline excluded so it can grow.
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root': { paddingTop: '0 !important', paddingBottom: '0 !important' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': { padding: '0 6px !important' },
        }}
      >
        {/* Required-field legend — explicit so the convention is unambiguous. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>

        {/* --- Identity --------------------------------------------- */}
        <FormSection
          title="Identity"
          subtitle="Stable key and human label"
          icon={<LabelOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Stack spacing={2}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Box sx={{ flex: 1 }}>
                <LabeledField
                  label="Key"
                  required
                  htmlFor="stage-key"
                  error={Boolean(errors.key)}
                  helperText={
                    errors.key?.message ??
                    'Stable identifier used by the API. 2–64 chars, a–z 0–9 with - or _.'
                  }
                >
                  <TextField
                    id="stage-key"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="e.g. pre-departure-briefing"
                    error={Boolean(errors.key)}
                    {...register('key')}
                  />
                </LabeledField>
              </Box>
              <Box sx={{ flex: 1 }}>
                <LabeledField
                  label="Label"
                  required
                  htmlFor="stage-label"
                  error={Boolean(errors.label)}
                  helperText={errors.label?.message ?? 'Human-readable name shown in the UI.'}
                >
                  <TextField
                    id="stage-label"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="e.g. Pre-departure briefing"
                    error={Boolean(errors.label)}
                    {...register('label')}
                  />
                </LabeledField>
              </Box>
            </Stack>

            <LabeledField
              label="Description"
              htmlFor="stage-desc"
              error={Boolean(errors.description)}
              helperText={errors.description?.message ?? 'Optional. Up to 2000 characters.'}
            >
              <TextField
                id="stage-desc"
                fullWidth
                hiddenLabel
                multiline
                minRows={2}
                placeholder="e.g. Counsellor walks the student through visa, travel and accommodation."
                error={Boolean(errors.description)}
                {...register('description')}
              />
            </LabeledField>
          </Stack>
        </FormSection>

        {/* --- Placement & SLA -------------------------------------- */}
        <FormSection
          title="Placement"
          subtitle="Where this stage sits in the pipeline"
          icon={<TuneOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Stack spacing={2}>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Box sx={{ flex: { sm: '0 0 160px' } }}>
                <LabeledField
                  label="Sequence"
                  required
                  htmlFor="stage-seq"
                  error={Boolean(errors.sequence)}
                  helperText={errors.sequence?.message ?? 'Lower = earlier in the chain.'}
                >
                  <TextField
                    id="stage-seq"
                    type="number"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="e.g. 10"
                    error={Boolean(errors.sequence)}
                    {...register('sequence', { valueAsNumber: true })}
                  />
                </LabeledField>
              </Box>
              <Box sx={{ flex: 1 }}>
                <LabeledField
                  label="Category"
                  required
                  htmlFor="stage-category"
                  error={Boolean(errors.category)}
                  helperText={errors.category?.message ?? 'Used for grouping and analytics.'}
                >
                  <Controller
                    name="category"
                    control={control}
                    render={({ field }) => (
                      <TextField
                        id="stage-category"
                        select
                        fullWidth
                        size="medium"
                        hiddenLabel
                        error={Boolean(errors.category)}
                        {...field}
                      >
                        {CATEGORY_OPTIONS.map((opt) => (
                          <MenuItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </MenuItem>
                        ))}
                      </TextField>
                    )}
                  />
                </LabeledField>
              </Box>
            </Stack>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start">
              <Box sx={{ minWidth: 180 }}>
                <LabeledField
                  label="Color"
                  htmlFor="stage-color"
                  error={Boolean(errors.color_hex)}
                  helperText={errors.color_hex?.message ?? 'Used in pipeline badges.'}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, height: 44 }}>
                    <Controller
                      name="color_hex"
                      control={control}
                      render={({ field }) => (
                        <input
                          id="stage-color"
                          type="color"
                          value={field.value || '#1976d2'}
                          onChange={(e) => field.onChange(e.target.value)}
                          style={{
                            width: 44,
                            height: 44,
                            border: '1px solid rgba(0,0,0,0.23)',
                            borderRadius: 6,
                            background: 'transparent',
                            cursor: 'pointer',
                          }}
                        />
                      )}
                    />
                    <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                      {colorValue}
                    </Typography>
                  </Box>
                </LabeledField>
              </Box>

              <Box sx={{ flex: 1 }}>
                <LabeledField
                  label="Icon"
                  htmlFor="stage-icon"
                  error={Boolean(errors.icon)}
                  helperText={errors.icon?.message ?? 'Optional MUI icon name.'}
                >
                  <TextField
                    id="stage-icon"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="e.g. flight, school"
                    error={Boolean(errors.icon)}
                    {...register('icon')}
                  />
                </LabeledField>
              </Box>
            </Stack>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Box sx={{ flex: 1 }}>
                <LabeledField
                  label="SLA (hours)"
                  htmlFor="stage-sla"
                  error={Boolean(errors.sla_hours)}
                  helperText={
                    errors.sla_hours?.message ?? 'Optional target time before flagging as stalled.'
                  }
                >
                  <TextField
                    id="stage-sla"
                    type="number"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="e.g. 72"
                    error={Boolean(errors.sla_hours)}
                    {...register('sla_hours')}
                  />
                </LabeledField>
              </Box>
              <Box sx={{ flex: 1 }}>
                <LabeledField
                  label="Destination country"
                  htmlFor="stage-country"
                  error={Boolean(errors.destination_country)}
                  helperText={
                    errors.destination_country?.message ?? 'ISO 3166-1 alpha-2. Leave blank if generic.'
                  }
                >
                  <TextField
                    id="stage-country"
                    fullWidth
                    size="medium"
                    hiddenLabel
                    placeholder="e.g. AU, GB, CA"
                    inputProps={{ maxLength: 2, style: { textTransform: 'uppercase' } }}
                    error={Boolean(errors.destination_country)}
                    {...register('destination_country')}
                  />
                </LabeledField>
              </Box>
            </Stack>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Controller
                name="is_initial"
                control={control}
                render={({ field }) => (
                  <Box sx={{ flex: 1 }}>
                    <FormControlLabel
                      control={
                        <Switch checked={field.value} onChange={(_, v) => field.onChange(v)} />
                      }
                      label="Initial stage"
                    />
                    <Typography variant="caption" color="text.secondary" display="block">
                      New students are placed here by default. Only one stage should be marked
                      initial.
                    </Typography>
                  </Box>
                )}
              />
              <Controller
                name="is_terminal"
                control={control}
                render={({ field }) => (
                  <Box sx={{ flex: 1 }}>
                    <FormControlLabel
                      control={
                        <Switch checked={field.value} onChange={(_, v) => field.onChange(v)} />
                      }
                      label="Terminal stage"
                    />
                    <Typography variant="caption" color="text.secondary" display="block">
                      Marks the end of the journey — students here are excluded from active
                      workloads.
                    </Typography>
                  </Box>
                )}
              />
            </Stack>
          </Stack>
        </FormSection>

        {/* --- Visa workflow & dashboard ---------------------------- */}
        <FormSection
          title="Visa workflow"
          subtitle="Optionally pin to a visa type and configure dashboard / outcome behaviour."
          icon={<VisibilityOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <Stack spacing={2}>
            <LabeledField
              label="Visa type"
              htmlFor="stage-visa-type"
              helperText="Leave empty to apply this stage to every visa type."
            >
              <Controller
                name="visa_type_id"
                control={control}
                render={({ field }) => {
                  const options = visaTypesQuery.data ?? [];
                  const selected = options.find((o) => o.id === field.value) ?? null;
                  return (
                    <Autocomplete
                      size="medium"
                      options={options}
                      value={selected}
                      onChange={(_, v) => field.onChange(v?.id ?? null)}
                      getOptionLabel={(o) => `${o.country_code} · ${o.name}`}
                      isOptionEqualToValue={(a, b) => a.id === b.id}
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          id="stage-visa-type"
                          hiddenLabel
                          placeholder="Select a visa type (optional)"
                        />
                      )}
                    />
                  );
                }}
              />
            </LabeledField>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Controller
                name="is_outcome_success"
                control={control}
                render={({ field }) => (
                  <Box sx={{ flex: 1 }}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={field.value}
                          onChange={(_, v) => field.onChange(v)}
                        />
                      }
                      label="Outcome: success"
                    />
                    <Typography variant="caption" color="text.secondary" display="block">
                      Triggers commission recalculation when entered. Mutually exclusive with failure.
                    </Typography>
                    {errors.is_outcome_success ? (
                      <Typography variant="caption" color="error" display="block">
                        {errors.is_outcome_success.message}
                      </Typography>
                    ) : null}
                  </Box>
                )}
              />
              <Controller
                name="is_outcome_failure"
                control={control}
                render={({ field }) => (
                  <Box sx={{ flex: 1 }}>
                    <FormControlLabel
                      control={
                        <Switch
                          checked={field.value}
                          onChange={(_, v) => field.onChange(v)}
                        />
                      }
                      label="Outcome: failure"
                    />
                    <Typography variant="caption" color="text.secondary" display="block">
                      Schedules a follow-up reminder for the assignee when entered.
                    </Typography>
                    {errors.is_outcome_failure ? (
                      <Typography variant="caption" color="error" display="block">
                        {errors.is_outcome_failure.message}
                      </Typography>
                    ) : null}
                  </Box>
                )}
              />
            </Stack>

            <Controller
              name="show_on_dashboard"
              control={control}
              render={({ field }) => (
                <Box>
                  <FormControlLabel
                    control={
                      <Switch checked={field.value} onChange={(_, v) => field.onChange(v)} />
                    }
                    label="Show on dashboard"
                  />
                  <Typography variant="caption" color="text.secondary" display="block">
                    Include in the dashboard's stage-counts widget. Default on so existing stages stay visible.
                  </Typography>
                </Box>
              )}
            />

            <LabeledField
              label="Prompt date label"
              htmlFor="stage-prompt-label"
              error={Boolean(errors.prompt_date_label)}
              helperText={
                errors.prompt_date_label?.message ??
                'Show extra date field when entering this stage.'
              }
            >
              <TextField
                id="stage-prompt-label"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. Departed on, Arrived on"
                error={Boolean(errors.prompt_date_label)}
                {...register('prompt_date_label')}
              />
            </LabeledField>
          </Stack>
        </FormSection>

        {/* --- Checklist tasks -------------------------------------- */}
        <FormSection
          title="Checklist tasks"
          subtitle="Tasks counsellors should complete while students are on this stage."
          icon={<ChecklistOutlinedIcon />}
          iconColor="muted"
          compact
        >
          <StageChecklistEditor stageId={stage?.id ?? null} />
        </FormSection>

        {saveBlockedReason ? (
          <Typography
            variant="caption"
            color="text.secondary"
            sx={{ display: 'block', mt: 2, textAlign: 'right' }}
          >
            {saveBlockedReason}
          </Typography>
        ) : null}
      </Box>
    </AppDialog>
  );
}

// ---------------------------------------------------------------------------
// Helpers — convert form fields → API payload (drop empty optionals).
// ---------------------------------------------------------------------------

function toPayload(values: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    key: values.key.trim(),
    label: values.label.trim(),
    // v6: always include the new flags so PATCH semantics are explicit
    // (otherwise an admin un-checking a flag wouldn't propagate).
    is_outcome_success: values.is_outcome_success,
    is_outcome_failure: values.is_outcome_failure,
    show_on_dashboard: values.show_on_dashboard,
    sequence: values.sequence,
    category: values.category,
    is_initial: values.is_initial,
    is_terminal: values.is_terminal,
  };

  const desc = values.description.trim();
  if (desc) out.description = desc;

  if (values.color_hex) out.color_hex = values.color_hex;

  const icon = values.icon.trim();
  if (icon) out.icon = icon;

  if (values.sla_hours !== '' && values.sla_hours != null) {
    const n = Number(values.sla_hours);
    if (!Number.isNaN(n)) out.sla_hours = n;
  }

  const country = values.destination_country.trim().toUpperCase();
  if (country) out.destination_country = country;

  // v6: visa_type_id is null when "no pin"; pass it through so PATCH can clear an existing pin.
  out.visa_type_id = values.visa_type_id ?? null;

  const promptLabel = values.prompt_date_label.trim();
  // Send null on PATCH to clear; on Create, the schema accepts null/optional.
  out.prompt_date_label = promptLabel.length > 0 ? promptLabel : null;

  return out;
}
