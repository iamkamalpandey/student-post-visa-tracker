'use client';

import { useEffect, useMemo } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { Box, MenuItem, Stack, TextField, Typography } from '@mui/material';
import Grid from '@mui/material/Grid';
import {
  CreateInterviewQuestionRequest,
  UpdateInterviewQuestionRequest,
  INTERVIEW_QUESTION_CATEGORY_LABEL,
  ACADEMIC_LEVEL_LABEL,
} from '@spv/zod-schemas';
import { ApiError, api } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import type { InterviewQuestionRow, CountryLite, InstitutionLite } from './types';

type Props = {
  open: boolean;
  row: InterviewQuestionRow | null;
  countries: CountryLite[];
  institutions: InstitutionLite[];
  onClose: () => void;
};

type FormValues = {
  country_code: string;
  academic_level: string;
  institution_id: string;
  category: string;
  question_text: string;
  model_answer: string;
  tips: string;
  sort_order: number;
  is_active: boolean;
};

const CATEGORIES = Object.entries(INTERVIEW_QUESTION_CATEGORY_LABEL);
const LEVELS = Object.entries(ACADEMIC_LEVEL_LABEL);

function emptyDefaults(): FormValues {
  return {
    country_code: '',
    academic_level: '',
    institution_id: '',
    category: 'GENERAL',
    question_text: '',
    model_answer: '',
    tips: '',
    sort_order: 0,
    is_active: true,
  };
}

function fromRow(r: InterviewQuestionRow): FormValues {
  return {
    country_code: r.country_code,
    academic_level: r.academic_level ?? '',
    institution_id: r.institution_id ?? '',
    category: r.category,
    question_text: r.question_text,
    model_answer: r.model_answer ?? '',
    tips: r.tips ?? '',
    sort_order: r.sort_order,
    is_active: r.is_active,
  };
}

function toPayload(v: FormValues) {
  return {
    country_code: v.country_code || undefined,
    academic_level: v.academic_level || null,
    institution_id: v.institution_id || null,
    category: v.category || undefined,
    question_text: v.question_text || undefined,
    model_answer: v.model_answer || null,
    tips: v.tips || null,
    sort_order: v.sort_order,
    is_active: v.is_active,
  };
}

export default function InterviewQuestionEditDialog({ open, row, countries, institutions, onClose }: Props) {
  const isEdit = row !== null;
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();

  const defaults = useMemo<FormValues>(() => (row ? fromRow(row) : emptyDefaults()), [row]);
  const resolverSchema = isEdit ? UpdateInterviewQuestionRequest : CreateInterviewQuestionRequest;

  const {
    control,
    handleSubmit,
    register,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    defaultValues: defaults,
    resolver: (async (values: FormValues) => {
      const payload = toPayload(values);
      const parsed = resolverSchema.safeParse(payload);
      if (parsed.success) return { values, errors: {} };
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

  useEffect(() => {
    if (open) reset(defaults);
  }, [open, defaults, reset]);

  const mutation = useMutation({
    mutationFn: async (values: FormValues) => {
      const payload = toPayload(values);
      if (isEdit && row) {
        return (await api.patch(`/interview-questions/${row.id}`, payload)).data;
      }
      return (await api.post('/interview-questions', payload)).data;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'Question updated' : 'Question created', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['interview-questions'] });
      onClose();
    },
    onError: (err: unknown) => {
      const message = err instanceof ApiError ? err.detail || err.title : 'Save failed';
      enqueueSnackbar(message, { variant: 'error' });
    },
  });

  const saveDisabled = !isDirty || isSubmitting || mutation.isPending;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit question' : 'New interview question'}
      subtitle={isEdit ? 'Update the question details.' : 'Add a new question to the interview bank.'}
      maxWidth="md"
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Create question',
        loadingLabel: isEdit ? 'Saving…' : 'Creating…',
        loading: isSubmitting || mutation.isPending,
        onClick: handleSubmit((v) => mutation.mutate(v)),
        disabled: saveDisabled,
      }}
    >
      <Box
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Stack spacing={2.5}>
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={4}>
              <LabeledField label="Country" required error={Boolean(errors.country_code)} helperText={errors.country_code?.message} htmlFor="iq-country">
                <Controller
                  name="country_code"
                  control={control}
                  render={({ field }) => (
                    <TextField {...field} id="iq-country" select size="small" fullWidth>
                      <MenuItem value="">Select country</MenuItem>
                      {countries.map((c) => (
                        <MenuItem key={c.code_alpha2} value={c.code_alpha2}>{c.name}</MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <LabeledField label="Category" required error={Boolean(errors.category)} helperText={errors.category?.message} htmlFor="iq-category">
                <Controller
                  name="category"
                  control={control}
                  render={({ field }) => (
                    <TextField {...field} id="iq-category" select size="small" fullWidth>
                      {CATEGORIES.map(([k, label]) => (
                        <MenuItem key={k} value={k}>{label}</MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <LabeledField label="Academic level" helperText="Leave blank for all levels" htmlFor="iq-level">
                <Controller
                  name="academic_level"
                  control={control}
                  render={({ field }) => (
                    <TextField {...field} id="iq-level" select size="small" fullWidth>
                      <MenuItem value="">All levels</MenuItem>
                      {LEVELS.map(([k, label]) => (
                        <MenuItem key={k} value={k}>{label}</MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
          </Grid>

          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={8}>
              <LabeledField label="Institution" helperText="Leave blank for general questions" htmlFor="iq-inst">
                <Controller
                  name="institution_id"
                  control={control}
                  render={({ field }) => (
                    <TextField {...field} id="iq-inst" select size="small" fullWidth>
                      <MenuItem value="">General (all institutions)</MenuItem>
                      {institutions.map((i) => (
                        <MenuItem key={i.id} value={i.id}>{i.display_name}</MenuItem>
                      ))}
                    </TextField>
                  )}
                />
              </LabeledField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <LabeledField label="Sort order" htmlFor="iq-sort">
                <TextField
                  {...register('sort_order', { valueAsNumber: true })}
                  id="iq-sort"
                  type="number"
                  size="small"
                  fullWidth
                  inputProps={{ min: 0, max: 9999 }}
                />
              </LabeledField>
            </Grid>
          </Grid>

          <LabeledField label="Question" required error={Boolean(errors.question_text)} helperText={errors.question_text?.message} htmlFor="iq-q">
            <TextField
              {...register('question_text')}
              id="iq-q"
              size="small"
              fullWidth
              multiline
              minRows={2}
              maxRows={6}
              placeholder="What is the purpose of your visit?"
            />
          </LabeledField>

          <LabeledField label="Model answer" helperText="Shown to student after completion" htmlFor="iq-answer">
            <TextField
              {...register('model_answer')}
              id="iq-answer"
              size="small"
              fullWidth
              multiline
              minRows={2}
              maxRows={6}
              placeholder="A strong answer includes..."
            />
          </LabeledField>

          <LabeledField label="Tips" helperText="Optional guidance shown alongside model answer" htmlFor="iq-tips">
            <TextField
              {...register('tips')}
              id="iq-tips"
              size="small"
              fullWidth
              multiline
              minRows={1}
              maxRows={4}
            />
          </LabeledField>

          <Controller
            name="is_active"
            control={control}
            render={({ field }) => (
              <LabeledField label="Active" helperText="Inactive questions are hidden from students">
                <TextField
                  select
                  size="small"
                  value={field.value ? 'true' : 'false'}
                  onChange={(e) => field.onChange(e.target.value === 'true')}
                  sx={{ width: 140 }}
                >
                  <MenuItem value="true">Active</MenuItem>
                  <MenuItem value="false">Inactive</MenuItem>
                </TextField>
              </LabeledField>
            )}
          />
        </Stack>
      </Box>
    </AppDialog>
  );
}
