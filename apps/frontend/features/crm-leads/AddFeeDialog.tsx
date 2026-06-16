'use client';

import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Stack, TextField } from '@mui/material';
import { useSnackbar } from 'notistack';

import AppDialog from '@/components/AppDialog';
import LabeledField from '@/components/LabeledField';
import { ApiError } from '@/lib/api';
import { majorToMinor } from '@/lib/money';
import { useCreateLeadFee, useTenant } from '@/lib/queries';

// Amount entered in MAJOR units; converted to minor before send (storage is minor).
const FeeFormSchema = z.object({
  session_label: z.string().min(1, 'Required').max(160),
  amount_major: z.string().min(1, 'Required').regex(/^\d+(\.\d{1,3})?$/, 'Enter an amount like 1200 or 1200.50'),
  currency: z.string().regex(/^[A-Za-z]{3}$/, '3-letter code'),
  due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Required'),
  notes: z.string().max(2000).optional(),
});
type FeeFormValues = z.infer<typeof FeeFormSchema>;

const WRITABLE = new Set(['session_label', 'amount_minor', 'currency', 'due_on', 'notes']);

export default function AddFeeDialog({ open, leadId, onClose }: { open: boolean; leadId: string; onClose: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const defaultCurrency = useTenant().data?.default_currency ?? 'NPR';
  const createFee = useCreateLeadFee(leadId);

  const { register, handleSubmit, reset, setError, formState: { errors } } = useForm<FeeFormValues>({
    resolver: zodResolver(FeeFormSchema),
    mode: 'onBlur',
    defaultValues: { session_label: '', amount_major: '', currency: defaultCurrency, due_on: '', notes: '' },
  });

  useEffect(() => {
    if (open) reset({ session_label: '', amount_major: '', currency: defaultCurrency, due_on: '', notes: '' });
  }, [open, defaultCurrency, reset]);

  const onSubmit = handleSubmit((values) => {
    const currency = values.currency.toUpperCase();
    // Currency-aware, precise major→minor (no float); respects 0/2/3-dp currencies.
    const amount_minor = majorToMinor(values.amount_major, currency);
    if (amount_minor === null) {
      setError('amount_major', { type: 'manual', message: 'Invalid amount' });
      return;
    }
    createFee.mutate(
      { session_label: values.session_label, amount_minor, currency, due_on: values.due_on, notes: values.notes?.trim() ? values.notes.trim() : undefined },
      {
        onSuccess: () => { enqueueSnackbar('Fee added.', { variant: 'success' }); onClose(); },
        onError: (err) => {
          if (err instanceof ApiError) {
            for (const fe of err.errors) {
              const leaf = fe.path.split('.').pop();
              if (leaf === 'amount_minor') setError('amount_major', { type: 'server', message: fe.message });
              else if (leaf && WRITABLE.has(leaf)) setError(leaf as keyof FeeFormValues, { type: 'server', message: fe.message });
            }
            enqueueSnackbar(err.detail || err.title || 'Could not add fee', { variant: 'error' });
          } else {
            enqueueSnackbar('Could not add fee', { variant: 'error' });
          }
        },
      },
    );
  });

  return (
    <AppDialog open={open} title="Add session fee" subtitle="Schedule a fee instalment for an upcoming session." onClose={onClose} primaryAction={{ label: 'Add fee', formId: 'add-lead-fee-form', loading: createFee.isPending }}>
      <form id="add-lead-fee-form" onSubmit={onSubmit} noValidate>
        <Stack spacing={1.5}>
          <LabeledField label="Session label" required htmlFor="fee-session" error={Boolean(errors.session_label)} helperText={errors.session_label?.message ?? 'e.g. “Fall 2026 — Term 1”'}>
            <TextField id="fee-session" fullWidth hiddenLabel size="medium" error={Boolean(errors.session_label)} {...register('session_label')} />
          </LabeledField>
          <Stack direction="row" spacing={1.5}>
            <LabeledField label="Amount" required htmlFor="fee-amount" error={Boolean(errors.amount_major)} helperText={errors.amount_major?.message ?? 'Major units'}>
              <TextField id="fee-amount" fullWidth hiddenLabel size="medium" inputMode="decimal" placeholder="1200.00" error={Boolean(errors.amount_major)} {...register('amount_major')} />
            </LabeledField>
            <LabeledField label="Currency" required htmlFor="fee-currency" error={Boolean(errors.currency)} helperText={errors.currency?.message ?? ' '}>
              <TextField id="fee-currency" fullWidth hiddenLabel size="medium" inputProps={{ maxLength: 3, style: { textTransform: 'uppercase' } }} error={Boolean(errors.currency)} {...register('currency')} />
            </LabeledField>
          </Stack>
          <LabeledField label="Due date" required htmlFor="fee-due" error={Boolean(errors.due_on)} helperText={errors.due_on?.message ?? ' '}>
            <TextField id="fee-due" type="date" fullWidth hiddenLabel size="medium" error={Boolean(errors.due_on)} {...register('due_on')} />
          </LabeledField>
          <LabeledField label="Notes" htmlFor="fee-notes" error={Boolean(errors.notes)} helperText={errors.notes?.message ?? 'Optional'}>
            <TextField id="fee-notes" fullWidth hiddenLabel size="medium" multiline minRows={2} error={Boolean(errors.notes)} {...register('notes')} />
          </LabeledField>
        </Stack>
      </form>
    </AppDialog>
  );
}
