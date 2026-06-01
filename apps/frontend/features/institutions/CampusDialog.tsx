// Refactored to SVT form-pattern per design pass.
'use client';

import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  FormControlLabel,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import {
  CreateCampusRequest,
  UpdateCampusRequest,
} from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import PhoneField from '@/components/PhoneField';
import LabeledField from '@/components/LabeledField';
import { useSaveBlockedReason } from '@/components/useSaveBlockedReason';
import { api, ApiError } from '@/lib/api';
import type { CampusRow } from './types';

const FORM_BOX_SX = {
  '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
  '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
  '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
  '& .react-international-phone-input-container .react-international-phone-input': { height: 44 },
  '& .react-international-phone-input-container .react-international-phone-country-selector-button': { height: 44 },
} as const;

type FormValues = {
  name: string;
  is_main: boolean;
  is_active: boolean;
  timezone: string;
  phone_e164: string;
  email: string;
};

const empty = (): FormValues => ({
  name: '',
  is_main: false,
  is_active: true,
  timezone: 'UTC',
  phone_e164: '',
  email: '',
});

function fromCampus(c: CampusRow): FormValues {
  return {
    name: c.name,
    is_main: c.is_main,
    is_active: c.is_active,
    timezone: c.timezone || 'UTC',
    phone_e164: c.phone_e164 ?? '',
    email: c.email ?? '',
  };
}

function buildCreatePayload(v: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: v.name.trim(),
    is_main: v.is_main,
  };
  if (v.timezone.trim()) out['timezone'] = v.timezone.trim();
  if (v.phone_e164.trim()) out['phone_e164'] = v.phone_e164.trim();
  if (v.email.trim()) out['email'] = v.email.trim();
  return out;
}

function buildUpdatePayload(v: FormValues): Record<string, unknown> {
  return {
    name: v.name.trim(),
    is_main: v.is_main,
    is_active: v.is_active,
    timezone: v.timezone.trim() || 'UTC',
    phone_e164: v.phone_e164.trim() || undefined,
    email: v.email.trim() || undefined,
  };
}

export type CampusDialogProps = {
  open: boolean;
  institutionId: string;
  campus: CampusRow | null;
  onClose: () => void;
};

export default function CampusDialog({
  open,
  institutionId,
  campus,
  onClose,
}: CampusDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const isEdit = Boolean(campus);

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: empty() });

  useEffect(() => {
    if (open) reset(campus ? fromCampus(campus) : empty());
  }, [open, campus, reset]);

  const mut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      if (campus) {
        const res = await api.patch(`/institutions/campuses/${campus.id}`, payload);
        return res.data;
      }
      const res = await api.post(`/institutions/${institutionId}/campuses`, payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(isEdit ? 'Campus updated.' : 'Campus added.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['institutions', 'detail', institutionId] });
      void qc.invalidateQueries({
        queryKey: ['institutions', institutionId, 'campuses'],
      });
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

  const onSubmit = handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      const payload = isEdit ? buildUpdatePayload(values) : buildCreatePayload(values);
      const schema = isEdit ? UpdateCampusRequest : CreateCampusRequest;
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

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={isEdit ? 'Edit campus' : 'New campus'}
      primaryAction={{
        label: isEdit ? 'Save changes' : 'Add campus',
        loadingLabel: 'Saving…',
        loading: submitting,
        formId: 'campus-form',
        disabled: saveDisabled,
      }}
    >
      <Box component="form" id="campus-form" onSubmit={onSubmit} noValidate sx={FORM_BOX_SX}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Grid container spacing={2.5}>
          <Grid item xs={12}>
            <LabeledField
              label="Name"
              required
              error={Boolean(errors.name)}
              helperText={errors.name?.message ?? ''}
              htmlFor="cmp-name"
            >
              <TextField
                id="cmp-name"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. Manchester Main Campus"
                error={Boolean(errors.name)}
                {...register('name', { required: 'Required' })}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Timezone"
              error={Boolean(errors.timezone)}
              helperText={errors.timezone?.message ?? 'IANA tz, e.g. Europe/London.'}
              htmlFor="cmp-timezone"
            >
              <TextField
                id="cmp-timezone"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="Europe/London"
                error={Boolean(errors.timezone)}
                {...register('timezone')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Phone"
              error={Boolean(errors.phone_e164)}
              helperText={errors.phone_e164?.message ?? 'E.164 format with country code.'}
            >
              <Controller
                name="phone_e164"
                control={control}
                render={({ field }) => (
                  <PhoneField
                    label=""
                    fullWidth
                    value={field.value ?? ''}
                    onChange={field.onChange}
                    error={Boolean(errors.phone_e164)}
                  />
                )}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12}>
            <LabeledField
              label="Email"
              error={Boolean(errors.email)}
              helperText={errors.email?.message ?? ''}
              htmlFor="cmp-email"
            >
              <TextField
                id="cmp-email"
                type="email"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="campus@example.edu"
                error={Boolean(errors.email)}
                {...register('email')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12}>
            <Stack direction="row" spacing={3}>
              <Controller
                name="is_main"
                control={control}
                render={({ field }) => (
                  <FormControlLabel
                    control={
                      <Switch
                        checked={field.value}
                        onChange={(_, c) => field.onChange(c)}
                      />
                    }
                    label="Main campus"
                  />
                )}
              />
              {isEdit ? (
                <Controller
                  name="is_active"
                  control={control}
                  render={({ field }) => (
                    <FormControlLabel
                      control={
                        <Switch
                          checked={field.value}
                          onChange={(_, c) => field.onChange(c)}
                        />
                      }
                      label={field.value ? 'Active' : 'Inactive'}
                    />
                  )}
                />
              ) : null}
            </Stack>
          </Grid>
        </Grid>
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
