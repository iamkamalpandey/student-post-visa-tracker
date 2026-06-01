// Refactored to SVT form-pattern per design pass.
'use client';

import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  FormControlLabel,
  Switch,
  TextField,
  Typography,
} from '@mui/material';
import Grid from '@mui/material/Grid';
import { CreateInstitutionContactRequest } from '@spv/zod-schemas';
import AppDialog from '@/components/AppDialog';
import PhoneField from '@/components/PhoneField';
import LabeledField from '@/components/LabeledField';
import { useSaveBlockedReason } from '@/components/useSaveBlockedReason';
import { api, ApiError } from '@/lib/api';

const FORM_BOX_SX = {
  '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
  '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
  '& .react-international-phone-input-container .react-international-phone-input': { height: 44 },
  '& .react-international-phone-input-container .react-international-phone-country-selector-button': { height: 44 },
} as const;

type FormValues = {
  full_name: string;
  designation: string;
  department: string;
  email: string;
  phone_e164: string;
  is_primary: boolean;
  notes: string;
};

const empty = (): FormValues => ({
  full_name: '',
  designation: '',
  department: '',
  email: '',
  phone_e164: '',
  is_primary: false,
  notes: '',
});

function buildPayload(v: FormValues): Record<string, unknown> {
  const out: Record<string, unknown> = {
    full_name: v.full_name.trim(),
    is_primary: v.is_primary,
  };
  if (v.designation.trim()) out['designation'] = v.designation.trim();
  if (v.department.trim()) out['department'] = v.department.trim();
  if (v.email.trim()) out['email'] = v.email.trim();
  if (v.phone_e164.trim()) out['phone_e164'] = v.phone_e164.trim();
  if (v.notes.trim()) out['notes'] = v.notes.trim();
  return out;
}

export type ContactDialogProps = {
  open: boolean;
  institutionId: string;
  onClose: () => void;
};

export default function ContactDialog({
  open,
  institutionId,
  onClose,
}: ContactDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: empty() });

  useEffect(() => {
    if (open) reset(empty());
  }, [open, reset]);

  const mut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await api.post(`/institutions/${institutionId}/contacts`, payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Contact added.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['institutions', 'detail', institutionId] });
      void qc.invalidateQueries({
        queryKey: ['institutions', institutionId, 'contacts'],
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
      const payload = buildPayload(values);
      const parsed = CreateInstitutionContactRequest.safeParse(payload);
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
      title="New contact"
      primaryAction={{
        label: 'Add contact',
        loadingLabel: 'Saving…',
        loading: submitting,
        formId: 'contact-form',
        disabled: saveDisabled,
      }}
    >
      <Box component="form" id="contact-form" onSubmit={onSubmit} noValidate sx={FORM_BOX_SX}>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Grid container spacing={2.5}>
          <Grid item xs={12}>
            <LabeledField
              label="Full name"
              required
              error={Boolean(errors.full_name)}
              helperText={errors.full_name?.message ?? ''}
              htmlFor="con-full_name"
            >
              <TextField
                id="con-full_name"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. Sarah Patel"
                error={Boolean(errors.full_name)}
                {...register('full_name', { required: 'Required' })}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Designation"
              error={Boolean(errors.designation)}
              helperText={errors.designation?.message ?? ''}
              htmlFor="con-designation"
            >
              <TextField
                id="con-designation"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. Director of International Admissions"
                error={Boolean(errors.designation)}
                {...register('designation')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Department"
              error={Boolean(errors.department)}
              helperText={errors.department?.message ?? ''}
              htmlFor="con-department"
            >
              <TextField
                id="con-department"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="e.g. Admissions Office"
                error={Boolean(errors.department)}
                {...register('department')}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <LabeledField
              label="Email"
              error={Boolean(errors.email)}
              helperText={errors.email?.message ?? ''}
              htmlFor="con-email"
            >
              <TextField
                id="con-email"
                type="email"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="sarah.patel@example.edu"
                error={Boolean(errors.email)}
                {...register('email')}
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
            <LabeledField label="Primary contact">
              <Controller
                name="is_primary"
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
                    label={field.value ? 'Primary contact' : 'Secondary contact'}
                  />
                )}
              />
            </LabeledField>
          </Grid>
          <Grid item xs={12}>
            <LabeledField
              label="Notes"
              error={Boolean(errors.notes)}
              helperText={errors.notes?.message ?? ''}
              htmlFor="con-notes"
            >
              <TextField
                id="con-notes"
                fullWidth
                hiddenLabel
                multiline
                minRows={2}
                placeholder="Internal notes about this contact"
                error={Boolean(errors.notes)}
                {...register('notes')}
              />
            </LabeledField>
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
