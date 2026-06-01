'use client';

// Refactored to SVT form-pattern per design pass.
import { useEffect, useState } from 'react';
import { useForm, Controller } from 'react-hook-form';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  MenuItem,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import { CreateProgramFeeRequest } from '@spv/zod-schemas';
import { api, ApiError } from '@/lib/api';
import { useCurrencies, useTenant } from '@/lib/queries';
import { formatMoney } from '@/lib/format';
import ConfirmDialog from '@/components/ConfirmDialog';
import CurrencyAutocomplete from '@/components/CurrencyAutocomplete';
import LabeledField from '@/components/LabeledField';
import {
  FEE_AUDIENCES,
  FEE_PERIODS,
  FEE_TYPES,
  type FeeAudience,
  type FeePeriod,
  type FeeType,
  type ProgramFeeRow,
} from './types';

type FormValues = {
  audience: FeeAudience;
  fee_type: FeeType;
  amount_major: string;
  currency: string;
  per_period: FeePeriod;
  is_estimated: boolean;
  effective_from: string;
  notes: string;
};

const empty = (): FormValues => ({
  audience: 'INTERNATIONAL',
  fee_type: 'TUITION',
  amount_major: '',
  currency: 'GBP',
  per_period: 'YEAR',
  is_estimated: false,
  effective_from: '',
  notes: '',
});

// Backend stores amount in minor units (cents/pence). We accept a major-unit
// decimal string and convert using the currency's minor_unit scale (defaulting
// to 2 — most ISO-4217 currencies). For zero-decimal currencies like JPY the
// minor_unit lookup returns 0, so 1000 JPY stays 1000.
function toMinorUnits(major: string, minorUnit = 2): string {
  const n = Number(major);
  if (!Number.isFinite(n) || n < 0) return '0';
  const scale = 10 ** minorUnit;
  return Math.round(n * scale).toString();
}

export type FeeListDialogProps = {
  open: boolean;
  intakeId: string;
  intakeLabel: string;
  isAdmin: boolean;
  onClose: () => void;
};

export default function FeeListDialog({
  open,
  intakeId,
  intakeLabel,
  isAdmin,
  onClose,
}: FeeListDialogProps) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [submitting, setSubmitting] = useState(false);
  const [pendingDeleteFeeId, setPendingDeleteFeeId] = useState<string | null>(null);
  const currenciesQ = useCurrencies();

  // Map "GBP" → 2, "JPY" → 0, etc. Falls back to 2 for unknown codes.
  function minorUnitFor(code: string): number {
    const c = (currenciesQ.data ?? []).find(
      (x) => x.code.toUpperCase() === code.toUpperCase(),
    );
    return c?.minor_unit ?? 2;
  }

  const feesQ = useQuery({
    queryKey: ['programs', 'intakes', intakeId, 'fees'],
    enabled: open,
    queryFn: async () => {
      const res = await api.get<{ data: ProgramFeeRow[] }>(
        `/programs/intakes/${intakeId}/fees`,
      );
      return res.data.data;
    },
  });

  const {
    register,
    handleSubmit,
    control,
    reset,
    setError,
    formState: { errors },
  } = useForm<FormValues>({ defaultValues: empty() });

  // SVT-WAVE28-DEFAULTS-2026-05 — seed currency from tenant.default_currency
  // when the dialog opens. Only seeds on mount-open so we don't trample
  // mid-edit values when the user toggles other fields.
  const tenantQ = useTenant(open);
  useEffect(() => {
    if (open && tenantQ.data?.default_currency) {
      reset({ ...empty(), currency: tenantQ.data.default_currency });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tenantQ.data?.default_currency]);

  const createMut = useMutation({
    mutationFn: async (payload: Record<string, unknown>) => {
      const res = await api.post(`/programs/intakes/${intakeId}/fees`, payload);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Fee added.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['programs', 'intakes', intakeId, 'fees'] });
      reset(empty());
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        enqueueSnackbar(err.detail || err.title || 'Failed.', { variant: 'error' });
      } else {
        enqueueSnackbar('Network error.', { variant: 'error' });
      }
    },
  });

  const deleteMut = useMutation({
    mutationFn: async (feeId: string) => {
      await api.delete(`/programs/fees/${feeId}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Fee removed.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['programs', 'intakes', intakeId, 'fees'] });
      setPendingDeleteFeeId(null);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        enqueueSnackbar(err.detail || err.title || 'Failed.', { variant: 'error' });
      } else {
        enqueueSnackbar('Network error.', { variant: 'error' });
      }
    },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      const currencyCode = values.currency.trim().toUpperCase();
      const payload: Record<string, unknown> = {
        audience: values.audience,
        fee_type: values.fee_type,
        amount_minor: toMinorUnits(values.amount_major, minorUnitFor(currencyCode)),
        currency: currencyCode,
        per_period: values.per_period,
        is_estimated: values.is_estimated,
      };
      if (values.effective_from.trim()) payload['effective_from'] = values.effective_from;
      if (values.notes.trim()) payload['notes'] = values.notes.trim();

      const parsed = CreateProgramFeeRequest.safeParse(payload);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const path = issue.path[0]?.toString();
          if (path === 'amount_minor') {
            setError('amount_major', { type: 'validate', message: issue.message });
          } else if (path && path in (empty() as object)) {
            setError(path as keyof FormValues, {
              type: 'validate',
              message: issue.message,
            });
          }
        }
        return;
      }
      await createMut.mutateAsync(payload);
    } finally {
      setSubmitting(false);
    }
  });

  const fees = feesQ.data ?? [];

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>
        Manage fees
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {intakeLabel}
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={3}>
          {fees.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              No fees recorded yet.
            </Typography>
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Audience</TableCell>
                    <TableCell>Type</TableCell>
                    <TableCell align="right">Amount</TableCell>
                    <TableCell>Period</TableCell>
                    <TableCell>Effective</TableCell>
                    {isAdmin ? <TableCell align="right" /> : null}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {fees.map((f) => (
                    <TableRow key={f.id}>
                      <TableCell>
                        <Chip size="small" label={f.audience} variant="outlined" />
                      </TableCell>
                      <TableCell>{f.fee_type}</TableCell>
                      <TableCell align="right">
                        {formatMoney(f.amount_minor, f.currency)}
                        {f.is_estimated ? ' (est.)' : ''}
                      </TableCell>
                      <TableCell>{f.per_period}</TableCell>
                      <TableCell>
                        {f.effective_from ? f.effective_from.slice(0, 10) : '—'}
                      </TableCell>
                      {isAdmin ? (
                        <TableCell align="right">
                          <IconButton
                            size="small"
                            onClick={() => setPendingDeleteFeeId(f.id)}
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      ) : null}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}

          {isAdmin ? (
            <Box>
              <Typography variant="subtitle2" sx={{ mb: 1.5, fontWeight: 600 }}>
                Add a fee
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
                <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
                Required
              </Typography>
              <Stack
                component="form"
                id="fee-form"
                onSubmit={onSubmit}
                spacing={2}
                noValidate
                sx={{
                  '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
                  '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
                  '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
                  '& .MuiAutocomplete-root .MuiOutlinedInput-root': { paddingTop: '0 !important', paddingBottom: '0 !important' },
                  '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': { padding: '0 6px !important' },
                }}
              >
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <Box sx={{ flex: 1 }}>
                    <LabeledField label="Audience" required htmlFor="fl-audience">
                      <Controller
                        name="audience"
                        control={control}
                        render={({ field }) => (
                          <TextField
                            id="fl-audience"
                            {...field}
                            select
                            fullWidth
                            size="medium"
                            hiddenLabel
                          >
                            {FEE_AUDIENCES.map((o) => (
                              <MenuItem key={o.value} value={o.value}>
                                {o.label}
                              </MenuItem>
                            ))}
                          </TextField>
                        )}
                      />
                    </LabeledField>
                  </Box>
                  <Box sx={{ flex: 1 }}>
                    <LabeledField label="Type" required htmlFor="fl-fee_type">
                      <Controller
                        name="fee_type"
                        control={control}
                        render={({ field }) => (
                          <TextField
                            id="fl-fee_type"
                            {...field}
                            select
                            fullWidth
                            size="medium"
                            hiddenLabel
                          >
                            {FEE_TYPES.map((o) => (
                              <MenuItem key={o.value} value={o.value}>
                                {o.label}
                              </MenuItem>
                            ))}
                          </TextField>
                        )}
                      />
                    </LabeledField>
                  </Box>
                  <Box sx={{ flex: 1 }}>
                    <LabeledField label="Per" required htmlFor="fl-per_period">
                      <Controller
                        name="per_period"
                        control={control}
                        render={({ field }) => (
                          <TextField
                            id="fl-per_period"
                            {...field}
                            select
                            fullWidth
                            size="medium"
                            hiddenLabel
                          >
                            {FEE_PERIODS.map((o) => (
                              <MenuItem key={o.value} value={o.value}>
                                {o.label}
                              </MenuItem>
                            ))}
                          </TextField>
                        )}
                      />
                    </LabeledField>
                  </Box>
                </Stack>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                  <Box sx={{ flex: 1 }}>
                    <LabeledField
                      label="Amount"
                      required
                      htmlFor="fl-amount"
                      error={Boolean(errors.amount_major)}
                      helperText={errors.amount_major?.message ?? 'Enter major units, e.g. 24500.00'}
                    >
                      <TextField
                        id="fl-amount"
                        type="number"
                        fullWidth
                        size="medium"
                        hiddenLabel
                        placeholder="e.g. 24500.00"
                        inputProps={{ step: '0.01' }}
                        error={Boolean(errors.amount_major)}
                        {...register('amount_major', { required: 'Required' })}
                      />
                    </LabeledField>
                  </Box>
                  <Box sx={{ flex: 1 }}>
                    <LabeledField
                      label="Currency"
                      required
                      error={Boolean(errors.currency)}
                      helperText={errors.currency?.message ?? 'ISO 4217 (e.g. GBP, USD, NPR).'}
                    >
                      <Controller
                        name="currency"
                        control={control}
                        rules={{ required: 'Required' }}
                        render={({ field }) => (
                          <CurrencyAutocomplete
                            name="currency"
                            value={field.value ?? ''}
                            onChange={(v) => field.onChange(v.toUpperCase())}
                            required
                            clearable={false}
                            error={Boolean(errors.currency)}
                          />
                        )}
                      />
                    </LabeledField>
                  </Box>
                  <Box sx={{ flex: 1 }}>
                    <LabeledField
                      label="Effective from"
                      htmlFor="fl-effective"
                      error={Boolean(errors.effective_from)}
                      helperText={errors.effective_from?.message ?? 'Optional — when this fee starts to apply.'}
                    >
                      <TextField
                        id="fl-effective"
                        type="date"
                        fullWidth
                        size="medium"
                        hiddenLabel
                        error={Boolean(errors.effective_from)}
                        {...register('effective_from')}
                      />
                    </LabeledField>
                  </Box>
                </Stack>
                <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="flex-start">
                  <Controller
                    name="is_estimated"
                    control={control}
                    render={({ field }) => (
                      <FormControlLabel
                        sx={{ mt: 0.5 }}
                        control={
                          <Switch
                            checked={field.value}
                            onChange={(_, c) => field.onChange(c)}
                          />
                        }
                        label="Estimated"
                      />
                    )}
                  />
                  <Box sx={{ flex: 1 }}>
                    <LabeledField
                      label="Notes"
                      htmlFor="fl-notes"
                      error={Boolean(errors.notes)}
                      helperText={errors.notes?.message ?? 'Optional — internal context.'}
                    >
                      <TextField
                        id="fl-notes"
                        fullWidth
                        size="medium"
                        hiddenLabel
                        placeholder="e.g. Includes mandatory health insurance levy."
                        error={Boolean(errors.notes)}
                        {...register('notes')}
                      />
                    </LabeledField>
                  </Box>
                </Stack>
                <Box>
                  <Button
                    type="submit"
                    variant="contained"
                    disabled={submitting}
                    startIcon={
                      submitting ? <CircularProgress size={16} color="inherit" /> : null
                    }
                  >
                    {submitting ? 'Adding…' : 'Add fee'}
                  </Button>
                </Box>
              </Stack>
            </Box>
          ) : null}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
      <ConfirmDialog
        open={Boolean(pendingDeleteFeeId)}
        title="Delete fee?"
        description="This fee will be removed from the intake. This cannot be undone."
        confirmLabel={null}
        confirmText="Delete"
        onConfirm={async () => {
          if (!pendingDeleteFeeId) return;
          await deleteMut.mutateAsync(pendingDeleteFeeId);
        }}
        onClose={() => setPendingDeleteFeeId(null)}
        loading={deleteMut.isPending}
        errorText={
          deleteMut.error instanceof ApiError
            ? deleteMut.error.detail || deleteMut.error.title || null
            : deleteMut.error
              ? 'Network error.'
              : null
        }
      />
    </Dialog>
  );
}
