'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import { Box, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { z } from 'zod';

import { api, ApiError } from '@/lib/api';
import { majorToMinor, currencyMinorDigits } from '@/lib/money';
import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import type { CommissionRow } from './types';

// SVT-FIN-2026-08 — this dialog is where claimed-vs-received reconciliation was
// silently lost.
//
// `CommissionClaim.received_minor` exists, `MarkPaidRequest` accepts it, and
// `summary()` was fixed to report cash received rather than claimed — but this
// form only ever sent `paid_on` and `payment_reference`, so the service
// defaulted `received_minor` to the FULL claimed amount. The variance was
// therefore structurally always zero: a university remitting 18,400 against a
// 20,000 claim booked as paid in full, and the 1,600 short-payment was
// invisible everywhere. The whole ledger was built and the last mile was one
// field.
//
// The form takes MAJOR units (what the operator reads off the remittance
// advice) and converts with the currency's real ISO-4217 exponent, so it is
// correct for 0-, 2- and 3-decimal currencies alike.
const formSchema = z
  .object({
    paid_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid date'),
    payment_reference: z.string().max(120).optional(),
    received_major: z
      .string()
      .trim()
      .regex(/^\d+(\.\d+)?$/, 'Enter an amount, e.g. 18400.00'),
  })
  .strict();

type FormValues = z.infer<typeof formSchema>;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Minor-unit string → major-unit string, for prefilling from the claim. */
function minorToMajor(minor: string, currency: string): string {
  const exp = currencyMinorDigits(currency);
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(exp + 1, '0');
  const whole = digits.slice(0, digits.length - exp) || '0';
  const frac = exp > 0 ? digits.slice(digits.length - exp) : '';
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
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
    resolver: zodResolver(formSchema),
    defaultValues: { paid_on: todayIso(), payment_reference: '', received_major: '' },
  });

  // Prefill with the claimed amount: settling in full is the common case, and
  // it makes any edit an explicit, deliberate statement that less arrived.
  const claimedMajor = claim ? minorToMajor(String(claim.amount_minor), claim.currency) : '';

  useEffect(() => {
    if (open) {
      reset({ paid_on: todayIso(), payment_reference: '', received_major: claimedMajor });
    }
  }, [open, claim?.id, claimedMajor, reset]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (values) => {
      if (!claim) throw new Error('Missing claim');
      const body: Record<string, unknown> = { paid_on: values.paid_on };
      const ref = values.payment_reference?.trim();
      if (ref) body.payment_reference = ref;
      const receivedMinor = majorToMinor(values.received_major, claim.currency);
      // majorToMinor returns null only on input the schema already rejected;
      // omitting the key on that path keeps the server's "settled in full"
      // default rather than sending a bad number.
      if (receivedMinor !== null) body.received_minor = receivedMinor;
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
            label={`Amount received${claim ? ` (${claim.currency})` : ''}`}
            required
            error={Boolean(errors.received_major)}
            helperText={
              errors.received_major?.message ??
              (claim && claimedMajor
                ? `Claimed ${claimedMajor} ${claim.currency}. Change this if the institution remitted less — the shortfall is recorded as a variance instead of the claim looking settled in full.`
                : 'What the institution actually remitted.')
            }
            htmlFor="commission-received"
          >
            <TextField
              id="commission-received"
              fullWidth
              hiddenLabel
              size="medium"
              inputMode="decimal"
              error={Boolean(errors.received_major)}
              {...register('received_major')}
            />
          </LabeledField>
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
