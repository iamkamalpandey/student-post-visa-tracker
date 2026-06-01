'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect, useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import { Box, InputAdornment, Stack, TextField, Tooltip, Typography } from '@mui/material';

import { api, ApiError } from '@/lib/api';
import { useCurrencies } from '@/lib/queries';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import type { CommissionRow } from './types';

// Form values are kept as strings — we coerce to BigInt only at submit time so
// the user can freely edit a "12.34" amount without losing precision via
// number-input quirks.
type FormValues = {
  amount_major: string;
  commission_pct: string;
  notes: string;
};

function minorToMajorString(minor: bigint | string | number, fractionDigits: number): string {
  const scale = 10n ** BigInt(fractionDigits);
  const big = typeof minor === 'bigint' ? minor : BigInt(typeof minor === 'string' ? minor : Math.trunc(minor));
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const whole = abs / scale;
  const frac = abs % scale;
  if (fractionDigits === 0) return `${negative ? '-' : ''}${whole}`;
  const fracStr = frac.toString().padStart(fractionDigits, '0').replace(/0+$/, '');
  if (!fracStr) return `${negative ? '-' : ''}${whole}`;
  return `${negative ? '-' : ''}${whole}.${fracStr}`;
}

function majorStringToMinor(major: string, fractionDigits: number): bigint | null {
  const trimmed = major.trim();
  if (!trimmed) return null;
  // Only digits and an optional single decimal point — keep it strict so a
  // typo like "12.3.4" is rejected before we hit the wire.
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) return null;
  const negative = trimmed.startsWith('-');
  const body = negative ? trimmed.slice(1) : trimmed;
  const [whole, frac = ''] = body.split('.');
  if (frac.length > fractionDigits) return null;
  const padded = (frac + '0'.repeat(fractionDigits)).slice(0, fractionDigits);
  const combined = `${whole}${padded}`.replace(/^0+(?=\d)/, '');
  const big = BigInt(combined || '0');
  return negative ? -big : big;
}

export type EditCommissionDialogProps = {
  open: boolean;
  claim: CommissionRow | null;
  onClose: () => void;
};

/**
 * Admin-only manual edit. The wire schema only allows monetary corrections
 * and free-text notes — currency, status, and lifecycle dates are deliberately
 * read-only and live behind their dedicated transition endpoints.
 *
 * PATCH carries the standard `If-Match: "${version}"` header for optimistic
 * concurrency. A 412 response surfaces a "someone else updated" toast so the
 * admin reloads instead of clobbering the collaborator's edits.
 */
export default function EditCommissionDialog({
  open,
  claim,
  onClose,
}: EditCommissionDialogProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const currenciesQuery = useCurrencies();
  const t = useTranslations('commissions.dialogs.edit');
  const tToast = useTranslations('commissions.list.toasts');

  const fractionDigits = useMemo(() => {
    const list = currenciesQuery.data ?? [];
    const found = list.find((c) => c.code === claim?.currency);
    return found?.minor_unit ?? 2;
  }, [currenciesQuery.data, claim?.currency]);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting, isDirty },
    setError,
  } = useForm<FormValues>({
    defaultValues: { amount_major: '', commission_pct: '', notes: '' },
  });

  useEffect(() => {
    if (!open || !claim) return;
    reset({
      amount_major: minorToMajorString(claim.amount_minor, fractionDigits),
      commission_pct: claim.commission_pct ?? '',
      notes: claim.notes ?? '',
    });
  }, [open, claim, fractionDigits, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      if (!claim) throw new Error('Missing claim');
      const body: Record<string, unknown> = {};

      const amountTrim = values.amount_major.trim();
      if (amountTrim !== '') {
        const minor = majorStringToMinor(amountTrim, fractionDigits);
        if (minor === null) {
          throw new ApiError({
            type: 'about:blank',
            title: 'Invalid amount',
            status: 422,
            detail: `Amount must be a number with up to ${fractionDigits} decimal place${fractionDigits === 1 ? '' : 's'}.`,
            errors: [{ path: 'amount_major', message: 'Invalid amount' }],
          });
        }
        // Wire schema accepts coerced bigint — send as string so JSON
        // serialisation doesn't drop precision on very large values.
        body.amount_minor = minor.toString();
      }

      const pctTrim = values.commission_pct.trim();
      if (pctTrim !== '') body.commission_pct = pctTrim;

      const notesTrim = values.notes.trim();
      if (notesTrim !== '') body.notes = notesTrim;

      const res = await api.patch(`/commissions/${claim.id}`, body, {
        headers: { 'If-Match': `"${claim.version}"` },
      });
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(t('successToast'), { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['commissions'] });
      qc.invalidateQueries({ queryKey: ['commission', claim?.id] });
      onClose();
    },
    onError: (err) => {
      if (err.status === 412) {
        enqueueSnackbar(tToast('concurrencyWarn'), {
          variant: 'warning',
        });
        qc.invalidateQueries({ queryKey: ['commissions'] });
        qc.invalidateQueries({ queryKey: ['commission', claim?.id] });
        return;
      }
      for (const fe of err.errors ?? []) {
        const leaf = fe.path.split('.').pop();
        if (leaf === 'amount_minor' || leaf === 'amount_major') {
          setError('amount_major', { type: 'server', message: fe.message });
        } else if (leaf === 'commission_pct') {
          setError('commission_pct', { type: 'server', message: fe.message });
        } else if (leaf === 'notes') {
          setError('notes', { type: 'server', message: fe.message });
        }
      }
      enqueueSnackbar(err.detail || err.title || t('errorToast'), { variant: 'error' });
    },
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));

  const currencyLabel = claim?.currency ?? '';

  const saveDisabled = !isDirty || isSubmitting || mutation.isPending;
  const saveBlockedReason = !isDirty ? 'Make a change to enable saving' : null;

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
      errorText={
        mutation.isError && mutation.error && mutation.error.status !== 412 && !mutation.error.errors?.length
          ? mutation.error.detail || mutation.error.title || null
          : null
      }
      primaryAction={{
        label: t('submit'),
        loadingLabel: t('submitting'),
        loading: isSubmitting || mutation.isPending,
        formId: 'commission-edit-form',
        disabled: saveDisabled,
      }}
    >
      <Box
        component="form"
        id="commission-edit-form"
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
            label={`Amount (${currencyLabel || 'major units'})`}
            error={Boolean(errors.amount_major)}
            helperText={
              errors.amount_major?.message ??
              `Decimal amount in ${currencyLabel || 'the claim currency'}; converted to ${fractionDigits === 0 ? 'whole units' : `${fractionDigits}-decimal minor units`} server-side.`
            }
            htmlFor="commission-edit-amount"
          >
            <TextField
              id="commission-edit-amount"
              fullWidth
              hiddenLabel
              size="medium"
              placeholder="1250.00"
              error={Boolean(errors.amount_major)}
              InputProps={
                currencyLabel
                  ? {
                      endAdornment: (
                        <InputAdornment position="end">{currencyLabel}</InputAdornment>
                      ),
                    }
                  : undefined
              }
              inputProps={{ inputMode: 'decimal' }}
              {...register('amount_major')}
            />
          </LabeledField>
          <LabeledField
            label="Commission percentage"
            error={Boolean(errors.commission_pct)}
            helperText={
              errors.commission_pct?.message ??
              'Decimal percentage with up to 2 decimal places (Postgres Decimal(5,2)).'
            }
            htmlFor="commission-edit-pct"
          >
            <TextField
              id="commission-edit-pct"
              fullWidth
              hiddenLabel
              size="medium"
              placeholder="12.50"
              error={Boolean(errors.commission_pct)}
              InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
              inputProps={{ inputMode: 'decimal', maxLength: 6 }}
              {...register('commission_pct')}
            />
          </LabeledField>
          <LabeledField
            label="Notes"
            error={Boolean(errors.notes)}
            helperText={
              errors.notes?.message ??
              'Internal note explaining the manual correction. Audit-logged.'
            }
            htmlFor="commission-edit-notes"
          >
            <TextField
              id="commission-edit-notes"
              fullWidth
              hiddenLabel
              multiline
              minRows={3}
              placeholder="Adjusted amount after partner re-confirmed enrollment date."
              inputProps={{ maxLength: 4000 }}
              error={Boolean(errors.notes)}
              {...register('notes')}
            />
          </LabeledField>
          <Typography variant="caption" color="text.secondary">
            Sent with `If-Match: &quot;{claim?.version ?? '?'}&quot;` for optimistic concurrency.
          </Typography>
          {saveBlockedReason && (
            <Tooltip title="">
              <Typography variant="caption" color="text.secondary">
                {saveBlockedReason}
              </Typography>
            </Tooltip>
          )}
        </Stack>
      </Box>
    </AppDialog>
  );
}
