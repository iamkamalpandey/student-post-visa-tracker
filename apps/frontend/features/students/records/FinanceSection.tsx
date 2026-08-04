'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect } from 'react';
import { Box, Button, MenuItem, TextField, Typography } from '@mui/material';
import LabeledField from '@/components/LabeledField';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { z } from 'zod';
import {
  CreateFinanceRequest,
  FinanceCategoryEnum,
  FinanceStatusEnum,
  type CreateFinanceRequest as CreateFinanceRequestType,
} from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { useTenant } from '@/lib/queries';
import { formatDate, formatMoney, todayLocalIso } from '@/lib/format';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
import CurrencyAutocomplete from '@/components/CurrencyAutocomplete';
import StatusChip from '@/components/StatusChip';
import {
  FormDialog,
  RowActions,
  SectionHeader,
  SectionStates,
  compactPayload,
  unwrapList,
  useCanWrite,
  useDialogState,
} from '../sectionShared';

type Finance = {
  id: string;
  enrollment_id?: string | null;
  sponsor_id?: string | null;
  category: string;
  description: string;
  amount_minor: number | string;
  currency: string;
  invoice_no?: string | null;
  due_on?: string | null;
  paid_on?: string | null;
  status: 'PENDING' | 'PAID' | 'OVERDUE' | 'WAIVED' | 'REFUNDED';
  reference?: string | null;
};

export type FinanceSectionProps = { studentId: string };

/**
 * Best-effort minor-unit count for the supplied currency. Defaults to 2 when
 * the currency is unknown to the runtime Intl tables.
 */
function minorUnitFor(currency: string): number {
  try {
    const opts = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions();
    return opts.maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

function majorToMinor(majorString: string, currency: string): string {
  if (!majorString) return '';
  const minor = minorUnitFor(currency);
  // Pure-string conversion to avoid float precision errors on amounts like 9.99.
  const sign = majorString.startsWith('-') ? '-' : '';
  const abs = majorString.replace(/^-/, '').trim();
  const [intPart, fracPart = ''] = abs.split('.');
  const fracPadded = (fracPart + '0'.repeat(minor)).slice(0, minor);
  const composed = `${intPart || '0'}${fracPadded}`.replace(/^0+(?=\d)/, '');
  return `${sign}${composed || '0'}`;
}

function minorToMajor(minor: string | number | bigint, currency: string): string {
  const m = typeof minor === 'bigint' ? minor.toString() : String(minor);
  const minorUnits = minorUnitFor(currency);
  if (minorUnits === 0) return m;
  const negative = m.startsWith('-');
  const abs = negative ? m.slice(1) : m;
  const padded = abs.padStart(minorUnits + 1, '0');
  const intPart = padded.slice(0, padded.length - minorUnits);
  const fracPart = padded.slice(-minorUnits);
  return `${negative ? '-' : ''}${intPart}.${fracPart}`;
}

const CATEGORY_LABELS: Record<string, string> = {
  TUITION: 'Tuition',
  ACCOMMODATION: 'Accommodation',
  TRAVEL: 'Travel',
  INSURANCE: 'Insurance',
  LIVING_COST: 'Living cost',
  CONSULTANCY: 'Consultancy',
  COMMISSION: 'Commission',
  OTHER: 'Other',
};

export default function FinanceSection({ studentId }: FinanceSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Finance>();
  const deleteDlg = useDialogState<Finance>();

  const queryKey = ['students', studentId, 'finance'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/finance`);
      return unwrapList<Finance>(res.data);
    },
  });

  const markPaidMutation = useMutation<unknown, ApiError, Finance>({
    mutationFn: async (row) =>
      api.patch(`/finance/${row.id}`, {
        status: 'PAID',
        // SVT-QA-2026-08 — use LOCAL day, not UTC. A user marking a fee paid
        // at 21:00 EDT was recording it one day early via toISOString().
        paid_on: todayLocalIso(),
      }),
    onSuccess: () => {
      enqueueSnackbar('Marked as paid', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const columns: DataTableColumn<Finance>[] = [
    { key: 'cat', label: 'Category', render: (r) => CATEGORY_LABELS[r.category] ?? r.category },
    { key: 'desc', label: 'Description', render: (r) => r.description },
    {
      key: 'amount',
      label: 'Amount',
      align: 'right',
      render: (r) => formatMoney(r.amount_minor, r.currency),
    },
    { key: 'due', label: 'Due', render: (r) => formatDate(r.due_on ?? '') },
    { key: 'paid', label: 'Paid', render: (r) => formatDate(r.paid_on ?? '') },
    { key: 'status', label: 'Status', render: (r) => <StatusChip status={r.status} /> },
    {
      key: 'mark',
      label: '',
      render: (r) =>
        canWrite && r.status !== 'PAID' ? (
          <Button
            size="small"
            variant="text"
            disabled={markPaidMutation.isPending}
            onClick={(e) => {
              e.stopPropagation();
              markPaidMutation.mutate(r);
            }}
          >
            Mark paid
          </Button>
        ) : null,
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (r) => (
        <RowActions
          canWrite={canWrite}
          onEdit={() => dlg.openEdit(r)}
          onDelete={() => deleteDlg.openEdit(r)}
        />
      ),
    },
  ];

  const removeMutation = useMutation<void, ApiError, Finance>({
    mutationFn: async (row) => {
      await api.delete(`/finance/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Finance line deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Finance"
        description="Tuition, accommodation, insurance and other line items with payment status."
        onAdd={dlg.openCreate}
        addLabel="Add line item"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="finance entries"
        onAdd={dlg.openCreate}
        addLabel="Add line item"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <FinanceFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey })}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete finance line?"
        description="This permanently removes the finance record."
        confirmText="Delete"
        loading={removeMutation.isPending}
        errorText={removeMutation.error?.detail ?? null}
        onClose={() => deleteDlg.close()}
        onConfirm={() => {
          if (deleteDlg.editing) removeMutation.mutate(deleteDlg.editing);
        }}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------

type FormValues = Omit<CreateFinanceRequestType, 'amount_minor'> & {
  amount_major: string;
};

function FinanceFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Finance | null;
  studentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();

  // We work in major units in the UI (more familiar) and convert to minor on submit.
  // Build a derived schema that swaps amount_minor for an amount_major string.
  const FormSchema = CreateFinanceRequest.omit({ amount_minor: true }).extend({
    amount_major: z.string().min(1, 'Amount required'),
  });

  const {
    register,
    control,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      category: 'TUITION',
      description: '',
      amount_major: '',
      currency: '',
      status: 'PENDING',
    } as FormValues,
  });

  // SVT-WAVE28-DEFAULTS-2026-05 — currency seeded from tenant default on
  // create. Edit path still echoes the row's existing currency.
  const tenantQ = useTenant(open && !editing);

  useEffect(() => {
    if (!open) return;
    reset({
      category: (editing?.category as FormValues['category']) ?? 'TUITION',
      description: editing?.description ?? '',
      amount_major:
        editing?.amount_minor != null && editing.currency
          ? minorToMajor(editing.amount_minor, editing.currency)
          : '',
      currency:
        editing?.currency ?? (tenantQ.data?.default_currency ?? ''),
      due_on: editing?.due_on?.slice(0, 10),
      paid_on: editing?.paid_on?.slice(0, 10),
      status: editing?.status ?? 'PENDING',
      invoice_no: editing?.invoice_no ?? '',
      reference: editing?.reference ?? '',
    } as FormValues);
  }, [open, editing, reset, tenantQ.data?.default_currency]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (raw) => {
      const { amount_major, currency, ...rest } = raw;
      const amount_minor = majorToMinor(String(amount_major), currency);
      const body = compactPayload({ ...rest, currency, amount_minor });
      if (editing) return api.patch(`/finance/${editing.id}`, body);
      return api.post(`/students/${studentId}/finance`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Finance line updated' : 'Finance line added', {
        variant: 'success',
      });
      onSaved();
      onClose();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));

  return (
    <FormDialog
      open={open}
      title={editing ? 'Edit finance line' : 'Add finance line'}
      formId="finance-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="finance-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          // Standardise input heights to 44px so date, text, select, currency
          // autocomplete all line up vertically. CurrencyAutocomplete is built
          // on MUI Autocomplete so the autocomplete-specific override applies.
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root': { paddingTop: '0 !important', paddingBottom: '0 !important' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': { padding: '0 6px !important' },
        }}
      >
        {/* Required-field legend — explicit so the convention is unambiguous. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
          <LabeledField
            label="Category"
            required
            error={Boolean(errors.category)}
            helperText={errors.category?.message ?? ''}
            htmlFor="fin-cat"
          >
            <Controller
              name="category"
              control={control}
              render={({ field }) => (
                <TextField
                  id="fin-cat"
                  select
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.category)}
                  {...field}
                >
                  {FinanceCategoryEnum.options.map((o) => (
                    <MenuItem key={o} value={o}>
                      {CATEGORY_LABELS[o] ?? o}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
          <LabeledField
            label="Status"
            error={Boolean(errors.status)}
            helperText={errors.status?.message ?? ''}
            htmlFor="fin-status"
          >
            <Controller
              name="status"
              control={control}
              render={({ field }) => (
                <TextField
                  id="fin-status"
                  select
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.status)}
                  {...field}
                >
                  {FinanceStatusEnum.options.map((o) => (
                    <MenuItem key={o} value={o}>
                      {o}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
          <Box sx={{ gridColumn: { sm: '1 / -1' } }}>
            <LabeledField
              label="Description"
              required
              error={Boolean(errors.description)}
              helperText={errors.description?.message ?? ''}
              htmlFor="fin-desc"
            >
              <TextField
                id="fin-desc"
                fullWidth
                size="medium"
                hiddenLabel
                placeholder="What this charge is for"
                error={Boolean(errors.description)}
                {...register('description')}
              />
            </LabeledField>
          </Box>
          <LabeledField
            label="Amount"
            required
            error={Boolean(errors.amount_major)}
            helperText={errors.amount_major?.message ?? 'Enter the major value (e.g. 1234.56).'}
            htmlFor="fin-amt"
          >
            <TextField
              id="fin-amt"
              type="number"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="1234.56"
              inputProps={{ min: 0, step: '0.01' }}
              error={Boolean(errors.amount_major)}
              {...register('amount_major')}
            />
          </LabeledField>
          <LabeledField
            label="Currency"
            required
            error={Boolean(errors.currency)}
            helperText={errors.currency?.message ?? ''}
          >
            <Controller
              name="currency"
              control={control}
              render={({ field }) => (
                <CurrencyAutocomplete
                  name="currency"
                  value={field.value ?? ''}
                  onChange={field.onChange}
                  required
                  clearable={false}
                  error={Boolean(errors.currency)}
                />
              )}
            />
          </LabeledField>
          <LabeledField
            label="Invoice number"
            error={Boolean(errors.invoice_no)}
            helperText={errors.invoice_no?.message ?? ''}
            htmlFor="fin-inv"
          >
            <TextField
              id="fin-inv"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="Provider's invoice ref"
              error={Boolean(errors.invoice_no)}
              {...register('invoice_no')}
            />
          </LabeledField>
          <LabeledField
            label="Reference"
            error={Boolean(errors.reference)}
            helperText={errors.reference?.message ?? ''}
            htmlFor="fin-ref"
          >
            <TextField
              id="fin-ref"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="Internal reference"
              error={Boolean(errors.reference)}
              {...register('reference')}
            />
          </LabeledField>
          <LabeledField
            label="Due on"
            error={Boolean(errors.due_on)}
            helperText={errors.due_on?.message ?? ''}
            htmlFor="fin-due"
          >
            <TextField
              id="fin-due"
              type="date"
              fullWidth
              size="medium"
              hiddenLabel
              error={Boolean(errors.due_on)}
              {...register('due_on')}
            />
          </LabeledField>
          <LabeledField
            label="Paid on"
            error={Boolean(errors.paid_on)}
            helperText={errors.paid_on?.message ?? ''}
            htmlFor="fin-paid"
          >
            <TextField
              id="fin-paid"
              type="date"
              fullWidth
              size="medium"
              hiddenLabel
              error={Boolean(errors.paid_on)}
              {...register('paid_on')}
            />
          </LabeledField>
        </Box>
      </Box>
    </FormDialog>
  );
}
