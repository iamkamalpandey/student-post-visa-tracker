'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import { Box, Stack, TextField, Typography } from '@mui/material';
import { InvoiceRequest } from '@spv/zod-schemas';

import { api, ApiError } from '@/lib/api';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import type { CommissionRow } from './types';

type FormValues = { invoice_no?: string };

export type InvoiceDialogProps = {
  open: boolean;
  claim: CommissionRow | null;
  onClose: () => void;
};

/**
 * CLAIMED → INVOICED transition. Caller may type a custom invoice number; if
 * left blank the server auto-generates one in the canonical
 * `COM-YYYY-MM-NNNNNN` format.
 */
export default function InvoiceDialog({ open, claim, onClose }: InvoiceDialogProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const t = useTranslations('commissions.dialogs.invoice');

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues>({
    resolver: zodResolver(InvoiceRequest),
    defaultValues: { invoice_no: '' },
  });

  useEffect(() => {
    if (open) reset({ invoice_no: '' });
  }, [open, claim?.id, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      if (!claim) throw new Error('Missing claim');
      // Send invoice_no only when non-blank — empty string is not a valid
      // payload for the wire schema (min(1) when present).
      const body = values.invoice_no?.trim() ? { invoice_no: values.invoice_no.trim() } : {};
      const res = await api.post(`/commissions/${claim.id}/invoice`, body);
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

  // Invoice number is optional — auto-generation means the user can submit
  // without dirtying the form. Don't gate on isDirty here.
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
        formId: 'commission-invoice-form',
      }}
    >
      <Box
        component="form"
        id="commission-invoice-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
        }}
      >
        <Stack spacing={2}>
          <LabeledField
            label="Invoice number"
            error={Boolean(errors.invoice_no)}
            helperText={
              errors.invoice_no?.message ??
              'Leave blank to auto-generate (COM-YYYY-MM-NNNNNN).'
            }
            htmlFor="commission-invoice-no"
          >
            <TextField
              id="commission-invoice-no"
              fullWidth
              hiddenLabel
              size="medium"
              placeholder="INV-2026-0042"
              error={Boolean(errors.invoice_no)}
              inputProps={{ maxLength: 60 }}
              {...register('invoice_no')}
            />
          </LabeledField>
          {claim ? (
            <Typography variant="caption" color="text.secondary">
              {t('footnote')}
            </Typography>
          ) : null}
          {/* Reference isDirty so the linter knows the destructured value is intentional. */}
          {isDirty ? null : null}
        </Stack>
      </Box>
    </AppDialog>
  );
}
