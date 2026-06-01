// SVT-WAVE-BILLING-2026-05 — Void-payment modal.
//
// Wraps useVoidPayment with a Zod-validated RHF form + notistack snackbars.
// Voiding reverses all allocations and is irreversible — the dialog leans
// hard on a warning Alert + destructive primary action color to match.

'use client';

import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useSnackbar } from 'notistack';
import { Alert, Box, Stack, TextField } from '@mui/material';
import AppDialog from '../../components/AppDialog';
import LabeledField from '../../components/LabeledField';
import { ApiError } from '../../lib/api';
import { useFormat } from '../../lib/format';
import { useVoidPayment, type Payment } from './queries';
import { MfaStepUpField, mfaStatusFromError, type MfaStepUpStatus } from './MfaStepUpField';

type Props = {
  open: boolean;
  onClose: () => void;
  payment: Payment;
};

const schema = z.object({
  reason: z.string().trim().min(3, 'Required').max(500, 'Max 500 characters'),
});
type FormShape = z.infer<typeof schema>;

export default function VoidPaymentDialog({ open, onClose, payment }: Props) {
  const { enqueueSnackbar } = useSnackbar();
  const fmt = useFormat();
  const voidPayment = useVoidPayment();

  const { register, handleSubmit, reset, setError, formState: { errors } } =
    useForm<FormShape>({ resolver: zodResolver(schema), defaultValues: { reason: '' } });

  // SVT-SEC-MFA-STEPUP-2026-05 — see RefundPaymentDialog for shared rationale.
  const [mfaStatus, setMfaStatus] = useState<MfaStepUpStatus>('idle');
  const [mfaCode, setMfaCode] = useState('');

  useEffect(() => {
    if (open) {
      reset({ reason: '' });
      setMfaStatus('idle');
      setMfaCode('');
    }
  }, [open, reset]);

  const onSubmit = handleSubmit(async (v) => {
    try {
      await voidPayment.mutateAsync({
        id: payment.id,
        reason: v.reason.trim(),
        ...(mfaCode ? { mfa_code: mfaCode } : {}),
      });
      enqueueSnackbar('Payment voided.', { variant: 'success' });
      onClose();
    } catch (e) {
      const mfa = mfaStatusFromError(e);
      if (mfa) {
        setMfaStatus(mfa);
        if (mfa !== 'required') setMfaCode('');
        return;
      }
      if (e instanceof ApiError && e.errors.length > 0) {
        for (const f of e.errors) {
          const path = f.path.replace(/^body\./, '');
          if (path === 'reason') {
            setError('reason', { type: 'server', message: f.message });
          }
        }
      }
      const msg = (e as { message?: string })?.message ?? 'Could not void payment.';
      enqueueSnackbar(msg, { variant: 'error' });
    }
  });

  const pending = voidPayment.isPending;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Void payment"
      subtitle={`Receipt ${payment.receipt_no} · ${fmt.money(payment.gross_minor, payment.currency)} ${payment.currency}`}
      maxWidth="sm"
      primaryAction={{
        label: 'Void payment',
        formId: 'void-payment-form',
        loading: pending,
        disabled: pending,
        color: 'error',
        loadingLabel: 'Voiding…',
      }}
    >
      <Box component="form" id="void-payment-form" onSubmit={onSubmit} noValidate>
        <Stack spacing={2}>
          <Alert severity="warning" variant="outlined">
            <strong>Voiding reverses all allocations and cannot be undone.</strong>{' '}
            Installments tied to this payment will be restored to their prior
            balance. Use this only when the receipt was logged in error.
          </Alert>

          <LabeledField
            label="Reason"
            required
            htmlFor="void-reason"
            error={!!errors.reason}
            helperText={errors.reason?.message ?? 'Surfaced on the audit log.'}
          >
            <TextField
              id="void-reason"
              size="small"
              hiddenLabel
              fullWidth
              multiline
              minRows={3}
              autoFocus
              {...register('reason')}
              error={!!errors.reason}
              inputProps={{ maxLength: 500 }}
            />
          </LabeledField>

          <MfaStepUpField
            status={mfaStatus}
            value={mfaCode}
            onChange={setMfaCode}
            id="void-mfa-code"
          />
        </Stack>
      </Box>
    </AppDialog>
  );
}
