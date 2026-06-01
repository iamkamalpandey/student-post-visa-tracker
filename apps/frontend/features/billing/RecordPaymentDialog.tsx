// SVT-WAVE-BILLING-2026-05 — Record-payment modal.
//
// Wraps useRecordPayment with a Zod-validated RHF form, optimistic cache
// patching for the active plan, and notistack snackbars. Allocations toggle
// switches between server-side FIFO (omit field) and manual per-installment
// amounts that must sum to gross.

'use client';

import { useEffect, useMemo } from 'react';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { useSnackbar } from 'notistack';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  FormControlLabel, MenuItem, Stack, Switch, TextField, Typography, Box,
} from '@mui/material';
import AppDialog from '../../components/AppDialog';
import LabeledField from '../../components/LabeledField';
import { useFormat } from '../../lib/format';
import {
  useRecordPayment,
  type FeePlan, type FeeInstallment, type PaymentMethod,
} from './queries';

const METHODS: PaymentMethod[] = ['CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'OTHER'];

type Props = {
  open: boolean;
  onClose: () => void;
  plan: FeePlan;
};

const amountStr = z
  .string()
  .trim()
  .min(1, 'Required')
  .regex(/^\d+(\.\d{1,4})?$/, 'Enter a positive amount');

const schema = z
  .object({
    gross_major: amountStr,
    method: z.enum(['CASH', 'BANK_TRANSFER', 'CARD', 'CHEQUE', 'OTHER']),
    received_on: z.string().min(1, 'Required'),
    reference: z.string().trim().max(120).optional().or(z.literal('')),
    notes: z.string().trim().max(2000).optional().or(z.literal('')),
    manual: z.boolean(),
    allocations: z.array(z.object({
      fee_installment_id: z.string().uuid(),
      label: z.string(),
      balance_minor: z.string(),
      amount_major: z.string(),
    })),
  })
  .superRefine((v, ctx) => {
    if (!v.manual) return;
    let sum = 0n;
    for (let i = 0; i < v.allocations.length; i += 1) {
      const raw = v.allocations[i]!.amount_major.trim();
      if (!raw) continue;
      if (!/^\d+(\.\d{1,4})?$/.test(raw)) {
        ctx.addIssue({ code: 'custom', path: ['allocations', i, 'amount_major'], message: 'Invalid' });
        return;
      }
      sum += toMinor(raw);
    }
    const gross = toMinor(v.gross_major);
    if (sum !== gross) {
      ctx.addIssue({
        code: 'custom', path: ['allocations'],
        message: `Allocations sum (${sum}) must equal gross (${gross}) in minor units.`,
      });
    }
  });

type FormShape = z.infer<typeof schema>;

function toMinor(major: string): bigint {
  const [whole, frac = ''] = major.split('.');
  const padded = (frac + '00').slice(0, 2);
  return BigInt(whole || '0') * 100n + BigInt(padded || '0');
}

export default function RecordPaymentDialog({ open, onClose, plan }: Props) {
  const { enqueueSnackbar } = useSnackbar();
  const fmt = useFormat();
  const qc = useQueryClient();
  const recordPayment = useRecordPayment();

  const openInstallments = useMemo<FeeInstallment[]>(
    () => (plan.installments ?? []).filter((i) => BigInt(i.balance_minor) > 0n),
    [plan.installments],
  );

  const defaultValues: FormShape = useMemo(() => ({
    gross_major: '',
    method: 'BANK_TRANSFER',
    received_on: dayjs().format('YYYY-MM-DD'),
    reference: '',
    notes: '',
    manual: false,
    allocations: openInstallments.map((i) => ({
      fee_installment_id: i.id,
      label: `${i.label} · due ${fmt.date(i.due_on)}`,
      balance_minor: i.balance_minor,
      amount_major: '',
    })),
  }), [openInstallments, fmt]);

  const { control, register, handleSubmit, watch, reset, formState: { errors } } =
    useForm<FormShape>({ resolver: zodResolver(schema), defaultValues });
  const { fields } = useFieldArray({ control, name: 'allocations' });
  const manual = watch('manual');

  useEffect(() => { if (open) reset(defaultValues); }, [open, defaultValues, reset]);

  async function recordOne(
    v: FormShape,
  ): Promise<ReturnType<typeof recordPayment.mutateAsync> | null> {
    const grossMinor = toMinor(v.gross_major).toString();
    const allocations = v.manual
      ? v.allocations
          .filter((a) => a.amount_major.trim() !== '')
          .map((a) => ({ fee_installment_id: a.fee_installment_id, amount_minor: toMinor(a.amount_major).toString() }))
      : undefined;

    const planKey = ['billing', 'plan', plan.id] as const;
    await qc.cancelQueries({ queryKey: planKey });
    const snapshot = qc.getQueryData<FeePlan>(planKey);

    if (snapshot?.installments) {
      let remaining = BigInt(grossMinor);
      const next = snapshot.installments.map((i) => {
        const explicit = allocations?.find((a) => a.fee_installment_id === i.id);
        const apply = explicit
          ? BigInt(explicit.amount_minor)
          : remaining > 0n
            ? (BigInt(i.balance_minor) < remaining ? BigInt(i.balance_minor) : remaining)
            : 0n;
        if (!explicit) remaining -= apply;
        const balance = BigInt(i.balance_minor) - apply;
        return {
          ...i,
          paid_minor: (BigInt(i.paid_minor) + apply).toString(),
          balance_minor: balance.toString(),
          status: balance === 0n ? ('PAID' as const) : apply > 0n ? ('PARTIAL' as const) : i.status,
        };
      });
      qc.setQueryData<FeePlan>(planKey, { ...snapshot, installments: next });
    }

    try {
      return await recordPayment.mutateAsync({
        enrollment_id: plan.enrollment_id,
        received_on: v.received_on,
        method: v.method,
        currency: plan.currency,
        gross_minor: grossMinor,
        reference: v.reference?.trim() || undefined,
        notes: v.notes?.trim() || undefined,
        allocations,
      });
    } catch (e) {
      if (snapshot) qc.setQueryData(planKey, snapshot);
      const msg = (e as { message?: string })?.message ?? 'Could not record payment.';
      enqueueSnackbar(msg, { variant: 'error' });
      return null;
    }
  }

  const onSubmit = handleSubmit(async (v) => {
    const created = await recordOne(v);
    if (created) {
      enqueueSnackbar('Payment recorded.', { variant: 'success' });
      onClose();
    }
  });

  const pending = recordPayment.isPending;
  const allocErr = (errors.allocations as { message?: string } | undefined)?.message;

  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title="Record payment"
      subtitle={`Plan currency: ${plan.currency}`}
      maxWidth="sm"
      primaryAction={{ label: 'Record', formId: 'record-payment-form', loading: pending, disabled: pending }}
    >
      <Box component="form" id="record-payment-form" onSubmit={onSubmit} noValidate>
        <Stack spacing={2}>
          <LabeledField label={`Amount (${plan.currency})`} required htmlFor="gross_major"
            error={!!errors.gross_major} helperText={errors.gross_major?.message}>
            <TextField id="gross_major" size="small" hiddenLabel fullWidth inputMode="decimal"
              placeholder="0.00" {...register('gross_major')} error={!!errors.gross_major} />
          </LabeledField>

          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <LabeledField label="Method" required htmlFor="method">
              <Controller name="method" control={control} render={({ field }) => (
                <TextField id="method" select size="small" hiddenLabel fullWidth {...field}>
                  {METHODS.map((m) => <MenuItem key={m} value={m}>{m.replace('_', ' ')}</MenuItem>)}
                </TextField>
              )} />
            </LabeledField>
            <LabeledField label="Received on" required htmlFor="received_on"
              error={!!errors.received_on} helperText={errors.received_on?.message}>
              <TextField id="received_on" type="date" size="small" hiddenLabel fullWidth
                {...register('received_on')} error={!!errors.received_on} />
            </LabeledField>
          </Stack>

          <LabeledField label="Reference" htmlFor="reference" helperText="Receipt / txn ID (optional).">
            <TextField id="reference" size="small" hiddenLabel fullWidth {...register('reference')} />
          </LabeledField>

          <LabeledField label="Notes" htmlFor="notes">
            <TextField id="notes" size="small" hiddenLabel fullWidth multiline minRows={2} {...register('notes')} />
          </LabeledField>

          <Controller name="manual" control={control} render={({ field }) => (
            <FormControlLabel control={<Switch checked={field.value} onChange={(_, c) => field.onChange(c)} />}
              label={field.value ? 'Manual allocation (per installment)' : 'Auto allocate (FIFO across open installments)'} />
          )} />

          {manual && (
            <Stack spacing={1.25}>
              <Typography variant="caption" color={allocErr ? 'error.main' : 'text.secondary'}>
                {allocErr ?? `Distribute the amount across ${fields.length} open installment(s). Leave blank to skip.`}
              </Typography>
              {fields.map((f, idx) => (
                <Stack key={f.id} direction="row" spacing={1} alignItems="center">
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" noWrap>{f.label}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Balance {fmt.money(f.balance_minor as never, plan.currency)}
                    </Typography>
                  </Box>
                  <TextField size="small" hiddenLabel sx={{ width: 140 }} inputMode="decimal" placeholder="0.00"
                    {...register(`allocations.${idx}.amount_major` as const)}
                    error={!!errors.allocations?.[idx]?.amount_major} />
                </Stack>
              ))}
            </Stack>
          )}
        </Stack>
      </Box>
    </AppDialog>
  );
}
