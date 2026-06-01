'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import { Box, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { MarkPaidRequest } from '@spv/zod-schemas';

import { api, ApiError } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import type { CommissionRow } from './types';

type FormValues = {
  paid_on: string;
  payment_reference?: string;
};

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export type MarkPaidDialogProps = {
  open: boolean;
  claim: CommissionRow | null;
  onClose: () => void;
};

/**
 * INVOICED → PAID transition. `paid_on` defaults to today; the optional
 * payment_reference captures wire / cheque / card-terminal IDs for the audit trail.
 */
export default function MarkPaidDialog({ open, claim, onClose }: MarkPaidDialogProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const t = useTranslations('commissions.dialogs.markPaid');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(MarkPaidRequest),
    defaultValues: { paid_on: todayIso(), payment_reference: '' },
  });

  useEffect(() => {
    if (open) reset({ paid_on: todayIso(), payment_reference: '' });
  }, [open, claim?.id, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      if (!claim) throw new Error('Missing claim');
      const body: Record<string, unknown> = { paid_on: values.paid_on };
      const ref = values.payment_reference?.trim();
      if (ref) body.payment_reference = ref;
      const res = await api.post(`/commissions/${claim.id}/mark-paid`, body);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(t('successToast'), { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['commissions'] });
      qc.invalidateQueries({ queryKey: ['commission', claim?.id] });
      onClose();
    },
    onError: (err) =>
      enqueueSnackbar(err.detail || err.title || t('errorToast'), { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));

  // The form is pre-populated with `paid_on` = today; allow submission even
  // without dirtying so the common case (mark paid today, no ref) is one click.
  const saveDisabled = isSubmitting || mutation.isPending;
  const helperHint = !isDirty ? 'Defaults to today — confirm or adjust the date.' : null;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t('title')}
      subtitle={
        claim
          ? t('subtitle', { institution: claim.institution.display_name })
          : undefined
      }
      errorText={mutation.error?.detail ?? null}
      primaryAction={{
        label: t('submit'),
        loadingLabel: t('submitting'),
        loading: isSubmitting || mutation.isPending,
        formId: 'commission-paid-form',
        color: 'success',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="commission-paid-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        {/* Required-field legend. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Stack spacing={2}>
          <LabeledField
            label="Paid on"
            required
            error={Boolean(errors.paid_on)}
            helperText={errors.paid_on?.message ?? 'Date the funds were received.'}
            htmlFor="commission-paid-on"
          >
            <TextField
              id="commission-paid-on"
              type="date"
              fullWidth
              hiddenLabel
              size="medium"
              error={Boolean(errors.paid_on)}
              {...register('paid_on')}
            />
          </LabeledField>
          <LabeledField
            label="Payment reference"
            error={Boolean(errors.payment_reference)}
            helperText={errors.payment_reference?.message ?? 'Optional. Helps auditors trace the payment.'}
            htmlFor="commission-paid-ref"
          >
            <TextField
              id="commission-paid-ref"
              fullWidth
              hiddenLabel
              size="medium"
              placeholder="Wire 9F84A2 / Cheque #1234"
              inputProps={{ maxLength: 120 }}
              error={Boolean(errors.payment_reference)}
              {...register('payment_reference')}
            />
          </LabeledField>
          {helperHint && (
            <Tooltip title="">
              <Typography variant="caption" color="text.secondary">
                {helperHint}
              </Typography>
            </Tooltip>
          )}
        </Stack>
      </Box>
    </AppDialog>
  );
}
