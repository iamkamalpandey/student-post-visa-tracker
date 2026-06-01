// SVT-WAVE-BILLING-2026-05 — Refund-payment modal.
//
// Wraps useCreateRefund with a Zod-validated RHF form + notistack snackbars.
// Refund lifecycle is CREATE → PENDING here; a separate "Complete refund"
// action on the admin /billing page transitions PENDING → COMPLETED.
//
// The Idempotency-Key is auto-injected by the axios interceptor in
// `apps/frontend/lib/api.ts`, so we don't set it manually.

'use client';

import { useEffect, useMemo, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useSnackbar } from 'notistack';
import {
  Box, MenuItem, Stack, TextField,
} from '@mui/material';
import AppDialog from '../../components/AppDialog';
import LabeledField from '../../components/LabeledField';
import { ApiError } from '../../lib/api';
import { useFormat } from '../../lib/format';
import {
  useCreateRefund,
  type Payment, type PaymentMethod,
} from './queries';
import { MfaStepUpField, mfaStatusFromError, type MfaStepUpStatus } from './MfaStepUpField';

const METHODS: PaymentMethod[] = ['CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'OTHER'];

const REASON_CODES = [
  { value: 'DUPLICATE', label: 'Duplicate' },
  { value: 'FRAUDULENT', label: 'Fraudulent' },
  { value: 'REQUESTED_BY_CUSTOMER', label: 'Requested by customer' },
  { value: 'OTHER', label: 'Other' },
] as const;

type Props = {
  open: boolean;
  onClose: () => void;
  payment: Payment;
};

const amountStr = z
  .string()
  .trim()
  .min(1, 'Required')
  .regex(/^\d+(\.\d{1,4})?$/, 'Enter a positive amount');

function toMinor(major: string): bigint {
  const [whole, frac = ''] = major.split('.');
  const padded = (frac + '00').slice(0, 2);
  return BigInt(whole || '0') * 100n + BigInt(padded || '0');
}

function minorToMajor(minor: string | bigint): string {
  const n = typeof minor === 'bigint' ? minor : BigInt(minor);
  const whole = n / 100n;
  const frac = (n % 100n).toString().padStart(2, '0');
  return `${whole}.${frac}`;
}

export default function RefundPaymentDialog({ open, onClose, payment }: Props) {
  const { enqueueSnackbar } = useSnackbar();
  const fmt = useFormat();
  const createRefund = useCreateRefund();

  // Ceiling for the refund — for now we use payment.gross_minor as the upper
  // bound. The backend enforces the true outstanding (gross minus completed
  // refunds), so worst case we surface a 422 → field error.
  const ceilingMinor = useMemo(() => BigInt(payment.gross_minor), [payment.gross_minor]);

  const schema = useMemo(() => z
    .object({
      amount_major: amountStr,
      method: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'OTHER']),
      reason_code: z.enum(['DUPLICATE', 'FRAUDULENT', 'REQUESTED_BY_CUSTOMER', 'OTHER']),
      reason_text: z.string().trim().min(3, 'Required').max(500, 'Max 500 characters'),
      reference: z.string().trim().max(200).optional().or(z.literal('')),
      notes: z.string().trim().max(4000).optional().or(z.literal('')),
    })
    .superRefine((v, ctx) => {
      const minor = toMinor(v.amount_major);
      if (minor <= 0n) {
        ctx.addIssue({ code: 'custom', path: ['amount_major'], message: 'Must be greater than zero' });
        return;
      }
      if (minor > ceilingMinor) {
        ctx.addIssue({
          code: 'custom', path: ['amount_major'],
          message: `Cannot exceed payment amount (${fmt.money(ceilingMinor.toString(), payment.currency)})`,
        });
      }
    }), [ceilingMinor, payment.currency, fmt]);

  type FormShape = z.infer<typeof schema>;

  const defaultValues: FormShape = useMemo(() => ({
    amount_major: minorToMajor(payment.gross_minor),
    method: payment.method,
    reason_code: 'REQUESTED_BY_CUSTOMER',
    reason_text: '',
    reference: '',
    notes: '',
  }), [payment.gross_minor, payment.method]);

  const { control, register, handleSubmit, reset, setError, formState: { errors } } =
    useForm<FormShape>({ resolver: zodResolver(schema), defaultValues });

  // SVT-SEC-MFA-STEPUP-2026-05 — inline MFA prompt state. `idle` keeps the
  // dialog identical to the pre-MFA shape; the backend flips us into
  // 'required' on the first submit when the caller has MFA enabled.
  const [mfaStatus, setMfaStatus] = useState<MfaStepUpStatus>('idle');
  const [mfaCode, setMfaCode] = useState('');

  useEffect(() => {
    if (open) {
      reset(defaultValues);
      setMfaStatus('idle');
      setMfaCode('');
    }
  }, [open, defaultValues, reset]);

  const onSubmit = handleSubmit(async (v) => {
    try {
      await createRefund.mutateAsync({
        payment_id: payment.id,
        amount_minor: toMinor(v.amount_major).toString(),
        method: v.method,
        reason_code: v.reason_code,
        reason_text: v.reason_text.trim(),
        reference: v.reference?.trim() || undefined,
        notes: v.notes?.trim() || undefined,
        ...(mfaCode ? { mfa_code: mfaCode } : {}),
      });
      enqueueSnackbar('Refund created (pending completion).', { variant: 'success' });
      onClose();
    } catch (e) {
      // SVT-SEC-MFA-STEPUP-2026-05 — if the backend asked for a step-up,
      // open the inline TOTP prompt and let the user re-submit. We do NOT
      // toast on this branch — the inline Alert + helper text is the
      // user-facing affordance.
      const mfa = mfaStatusFromError(e);
      if (mfa) {
        setMfaStatus(mfa);
        // 'invalid' / 'replay' — code was wrong; clear so they can re-enter.
        if (mfa !== 'required') setMfaCode('');
        return;
      }
      // Map RFC 7807 field errors back to RHF where possible.
      if (e instanceof ApiError && e.errors.length > 0) {
        for (const f of e.errors) {
          const path = f.path.replace(/^body\./, '');
          const mapped =
            path === 'amount_minor' ? 'amount_major' :
            (['amount_major', 'method', 'reason_code', 'reason_text', 'reference', 'notes'].includes(path) ? path : null);
          if (mapped) {
            setError(mapped as keyof FormShape, { type: 'server', message: f.message });
          }
        }
      }
      const msg = (e as { message?: string })?.message ?? 'Could not create refund.';
      enqueueSnackbar(msg, { variant: 'error' });
    }
  });

  const pending = createRefund.isPending;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Refund payment"
      subtitle={`Receipt ${payment.receipt_no} · ${fmt.money(payment.gross_minor, payment.currency)} ${payment.currency}`}
      maxWidth="sm"
      primaryAction={{
        label: 'Create refund',
        formId: 'refund-payment-form',
        loading: pending,
        disabled: pending,
      }}
    >
      <Box component="form" id="refund-payment-form" onSubmit={onSubmit} noValidate>
        <Stack spacing={2}>
          <LabeledField
            label={`Amount (${payment.currency})`}
            required
            htmlFor="refund-amount"
            error={!!errors.amount_major}
            helperText={errors.amount_major?.message ?? `Refund creates a PENDING row; complete it from the refund queue once cleared.`}
          >
            <TextField
              id="refund-amount" size="small" hiddenLabel fullWidth inputMode="decimal"
              placeholder="0.00"
              {...register('amount_major')}
              error={!!errors.amount_major}
            />
          </LabeledField>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <LabeledField label="Method" required htmlFor="refund-method">
              <Controller name="method" control={control} render={({ field }) => (
                <TextField id="refund-method" select size="small" hiddenLabel fullWidth {...field}>
                  {METHODS.map((m) => <MenuItem key={m} value={m}>{m.replace('_', ' ')}</MenuItem>)}
                </TextField>
              )} />
            </LabeledField>
            <LabeledField label="Reason" required htmlFor="refund-reason-code"
              error={!!errors.reason_code} helperText={errors.reason_code?.message}>
              <Controller name="reason_code" control={control} render={({ field }) => (
                <TextField id="refund-reason-code" select size="small" hiddenLabel fullWidth {...field}>
                  {REASON_CODES.map((r) => <MenuItem key={r.value} value={r.value}>{r.label}</MenuItem>)}
                </TextField>
              )} />
            </LabeledField>
          </Stack>

          <LabeledField
            label="Reason detail" required htmlFor="refund-reason-text"
            error={!!errors.reason_text}
            helperText={errors.reason_text?.message ?? 'Surfaced on the audit log.'}
          >
            <TextField
              id="refund-reason-text" size="small" hiddenLabel fullWidth multiline minRows={2}
              {...register('reason_text')}
              error={!!errors.reason_text}
              inputProps={{ maxLength: 500 }}
            />
          </LabeledField>

          <LabeledField label="Reference" htmlFor="refund-reference"
            helperText={errors.reference?.message ?? 'Bank / txn reference (optional).'}
            error={!!errors.reference}>
            <TextField
              id="refund-reference" size="small" hiddenLabel fullWidth
              {...register('reference')}
              error={!!errors.reference}
            />
          </LabeledField>

          <LabeledField label="Notes" htmlFor="refund-notes" error={!!errors.notes}
            helperText={errors.notes?.message}>
            <TextField
              id="refund-notes" size="small" hiddenLabel fullWidth multiline minRows={2}
              {...register('notes')}
              error={!!errors.notes}
            />
          </LabeledField>

          <MfaStepUpField
            status={mfaStatus}
            value={mfaCode}
            onChange={setMfaCode}
            id="refund-mfa-code"
          />
        </Stack>
      </Box>
    </AppDialog>
  );
}
