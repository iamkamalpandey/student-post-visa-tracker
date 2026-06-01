// SVT-WAVE-BILLING-2026-05 — FeePlanWizardDialog.
// 3-step wizard: (1) params, (2) preview (mirrors backend generateInstallmentLines),
// (3) confirm + submit via useCreateFeePlan. CUSTOM cadence renders an editable
// lines table on step 1 and skips the preview step. 422/409 responses are
// surfaced inline via ApiError#fieldErrors(); other errors fall through to
// AppDialog's errorText. No new deps — MUI only.

'use client';

import { useMemo, useState, type ChangeEvent } from 'react';
import {
  Alert, Box, Button, IconButton, MenuItem, Stack, Step, StepLabel, Stepper,
  Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AppDialog from '../../components/AppDialog';
import LabeledField from '../../components/LabeledField';
import CurrencyAutocomplete from '../../components/CurrencyAutocomplete';
import { ApiError } from '../../lib/api';
import { useCreateFeePlan, type BillingCadence } from './queries';

export type FeePlanWizardDialogProps = {
  open: boolean;
  enrollmentId: string;
  defaultCurrency?: string;
  onClose: () => void;
  onCreated?: (planId: string) => void;
};

type LineDraft = { label: string; due_on: string; gross_minor: string };

const CRON_CADENCES: Exclude<BillingCadence, 'CUSTOM'>[] = [
  'MONTHLY', 'QUARTERLY', 'TRIMESTER', 'SEMESTER', 'TERM', 'ANNUAL',
];
const MONTHS_PER_STRIDE: Record<Exclude<BillingCadence, 'CUSTOM'>, number> = {
  MONTHLY: 1, QUARTERLY: 3, TRIMESTER: 4, SEMESTER: 6, TERM: 3, ANNUAL: 12,
};

// Mirrors apps/backend/src/modules/billing/pricing.ts:generateInstallmentLines.
// Uses BigInt so remainder lands on the last installment exactly like server.
function generateInstallmentLinesClient(opts: {
  cadence: Exclude<BillingCadence, 'CUSTOM'>;
  total_minor: bigint;
  installment_count: number;
  starts_on: string;
}): LineDraft[] {
  const { cadence, total_minor, installment_count, starts_on } = opts;
  if (installment_count <= 0) return [];
  const start = new Date(`${starts_on}T00:00:00.000Z`);
  if (Number.isNaN(start.getTime())) return [];
  const stride = MONTHS_PER_STRIDE[cadence];
  const per = total_minor / BigInt(installment_count);
  const rem = total_minor - per * BigInt(installment_count);
  const day = start.getUTCDate();
  const out: LineDraft[] = [];
  for (let i = 0; i < installment_count; i += 1) {
    const due = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + stride * i, 1));
    const lastDay = new Date(Date.UTC(due.getUTCFullYear(), due.getUTCMonth() + 1, 0)).getUTCDate();
    due.setUTCDate(Math.min(day, lastDay));
    const isLast = i === installment_count - 1;
    out.push({
      label: `Installment ${i + 1} of ${installment_count}`,
      due_on: due.toISOString().slice(0, 10),
      gross_minor: (isLast ? per + rem : per).toString(),
    });
  }
  return out;
}

const toBigIntSafe = (v: string): bigint => { try { return v ? BigInt(v) : 0n; } catch { return 0n; } };
const sumMinor = (rows: LineDraft[]): bigint => rows.reduce((a, l) => a + toBigIntSafe(l.gross_minor), 0n);

function formatMinor(minor: string, currency: string): string {
  const n = Number(minor || '0') / 100;
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(n); }
  catch { return `${currency} ${n.toFixed(2)}`; }
}

export default function FeePlanWizardDialog({
  open, enrollmentId, defaultCurrency = 'GBP', onClose, onCreated,
}: FeePlanWizardDialogProps) {
  const today = new Date().toISOString().slice(0, 10);
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [cadence, setCadence] = useState<BillingCadence>('MONTHLY');
  const [totalMinor, setTotalMinor] = useState('');
  const [currency, setCurrency] = useState(defaultCurrency);
  const [installmentCount, setInstallmentCount] = useState(12);
  const [startsOn, setStartsOn] = useState(today);
  const [customLines, setCustomLines] = useState<LineDraft[]>([
    { label: 'Installment 1', due_on: today, gross_minor: '' },
  ]);
  const [notes, setNotes] = useState('');
  const [serverError, setServerError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Map<string, string>>(new Map());

  const create = useCreateFeePlan();
  const isCustom = cadence === 'CUSTOM';

  const previewLines = useMemo<LineDraft[]>(() => {
    if (isCustom) return customLines;
    return generateInstallmentLinesClient({
      cadence: cadence as Exclude<BillingCadence, 'CUSTOM'>,
      total_minor: toBigIntSafe(totalMinor),
      installment_count: installmentCount,
      starts_on: startsOn,
    });
  }, [isCustom, cadence, totalMinor, installmentCount, startsOn, customLines]);

  const customSum = useMemo(() => sumMinor(customLines), [customLines]);

  // Step-1 validation — disables Next until we'd pass server checks.
  const step1Error: string | null = useMemo(() => {
    if (!currency) return 'Pick a currency.';
    if (!startsOn) return 'Start date is required.';
    if (isCustom) {
      if (customLines.length === 0) return 'Add at least one installment.';
      for (const [i, l] of customLines.entries()) {
        if (!l.label.trim()) return `Line ${i + 1}: label is required.`;
        if (!l.due_on) return `Line ${i + 1}: due date is required.`;
        if (toBigIntSafe(l.gross_minor) < 0n) return `Line ${i + 1}: amount must be >= 0.`;
      }
      if (customSum <= 0n) return 'Total of custom lines must be > 0.';
      return null;
    }
    if (toBigIntSafe(totalMinor) <= 0n) return 'Total amount must be > 0.';
    if (installmentCount <= 0 || installmentCount > 240) return 'Installments must be 1–240.';
    return null;
  }, [currency, startsOn, isCustom, customLines, customSum, totalMinor, installmentCount]);

  const resetAll = (): void => {
    setStep(0); setCadence('MONTHLY'); setTotalMinor(''); setCurrency(defaultCurrency);
    setInstallmentCount(12); setStartsOn(today);
    setCustomLines([{ label: 'Installment 1', due_on: today, gross_minor: '' }]);
    setNotes(''); setServerError(null); setFieldErrors(new Map());
  };
  const handleClose = (): void => { if (!create.isPending) { resetAll(); onClose(); } };

  const updateLine = (idx: number, patch: Partial<LineDraft>): void =>
    setCustomLines((rows) => rows.map((r, i) => (i === idx ? { ...r, ...patch } : r)));

  const handleSubmit = async (): Promise<void> => {
    setServerError(null); setFieldErrors(new Map());
    try {
      const payload = isCustom
        ? {
            enrollment_id: enrollmentId, cadence, starts_on: startsOn, currency,
            lines: customLines.map((l) => ({
              label: l.label.trim(), due_on: l.due_on,
              gross_minor: toBigIntSafe(l.gross_minor).toString(),
            })),
            notes: notes.trim() || undefined,
          }
        : {
            enrollment_id: enrollmentId, cadence, starts_on: startsOn, currency,
            total_minor: toBigIntSafe(totalMinor).toString(),
            installment_count: installmentCount,
            notes: notes.trim() || undefined,
          };
      const plan = await create.mutateAsync(payload);
      onCreated?.(plan.id);
      resetAll(); onClose();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 422 || err.status === 409)) {
        const fe = err.fieldErrors();
        setFieldErrors(fe);
        setServerError(
          err.status === 409
            ? err.detail || err.title || 'Conflict — plan may already exist or enrollment state blocks creation.'
            : fe.size > 0 ? null : err.detail || 'Please fix the highlighted fields.',
        );
      } else {
        setServerError(err instanceof Error ? err.message : 'Failed to create fee plan.');
      }
    }
  };

  const fe = (path: string): string | undefined => fieldErrors.get(path);

  const renderStep1 = (): JSX.Element => (
    <Stack spacing={2}>
      <LabeledField label="Cadence" required htmlFor="cadence">
        <TextField select id="cadence" hiddenLabel size="small" fullWidth value={cadence}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setCadence(e.target.value as BillingCadence)}
          error={!!fe('cadence')} helperText={fe('cadence')}>
          {[...CRON_CADENCES, 'CUSTOM' as const].map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>)}
        </TextField>
      </LabeledField>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        {!isCustom && (
          <LabeledField label="Total (minor units)" required htmlFor="total"
            helperText={fe('total_minor') ?? 'Pence/cents. e.g. 1200000 = £12,000.00'} error={!!fe('total_minor')}>
            <TextField id="total" hiddenLabel size="small" fullWidth value={totalMinor} inputMode="numeric"
              onChange={(e) => setTotalMinor(e.target.value.replace(/[^0-9]/g, ''))} error={!!fe('total_minor')} />
          </LabeledField>
        )}
        <Box sx={{ flex: 1 }}>
          <LabeledField label="Currency" required>
            <CurrencyAutocomplete value={currency} onChange={setCurrency} size="small"
              error={!!fe('currency')} helperText={fe('currency')} />
          </LabeledField>
        </Box>
      </Stack>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        {!isCustom && (
          <LabeledField label="Installments" required htmlFor="count" error={!!fe('installment_count')}
            helperText={fe('installment_count')}>
            <TextField id="count" hiddenLabel size="small" fullWidth type="number" value={installmentCount}
              inputProps={{ min: 1, max: 240 }} error={!!fe('installment_count')}
              onChange={(e) => setInstallmentCount(Math.max(1, Math.min(240, Number(e.target.value) || 1)))} />
          </LabeledField>
        )}
        <Box sx={{ flex: 1 }}>
          <LabeledField label="Starts on" required htmlFor="starts" error={!!fe('starts_on')} helperText={fe('starts_on')}>
            <TextField id="starts" hiddenLabel size="small" fullWidth type="date" value={startsOn}
              onChange={(e) => setStartsOn(e.target.value)} error={!!fe('starts_on')} />
          </LabeledField>
        </Box>
      </Stack>
      {isCustom && (
        <Box>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle2">Custom installments</Typography>
            <Button size="small" startIcon={<AddIcon />} onClick={() => setCustomLines((rows) => [
              ...rows, { label: `Installment ${rows.length + 1}`, due_on: startsOn, gross_minor: '' },
            ])}>Add line</Button>
          </Stack>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Label</TableCell><TableCell>Due on</TableCell>
                <TableCell align="right">Amount (minor)</TableCell><TableCell width={48} />
              </TableRow>
            </TableHead>
            <TableBody>
              {customLines.map((line, idx) => (
                <TableRow key={idx}>
                  <TableCell><TextField hiddenLabel size="small" fullWidth value={line.label}
                    onChange={(e) => updateLine(idx, { label: e.target.value })} /></TableCell>
                  <TableCell><TextField hiddenLabel size="small" type="date" value={line.due_on}
                    onChange={(e) => updateLine(idx, { due_on: e.target.value })} /></TableCell>
                  <TableCell align="right"><TextField hiddenLabel size="small" value={line.gross_minor}
                    inputMode="numeric" sx={{ '& input': { textAlign: 'right' } }}
                    onChange={(e) => updateLine(idx, { gross_minor: e.target.value.replace(/[^0-9]/g, '') })} /></TableCell>
                  <TableCell><IconButton size="small" disabled={customLines.length === 1}
                    onClick={() => setCustomLines((rows) => rows.filter((_, i) => i !== idx))}
                    aria-label={`Remove line ${idx + 1}`}><DeleteOutlineIcon fontSize="small" /></IconButton></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Total: {formatMinor(customSum.toString(), currency)}
          </Typography>
        </Box>
      )}
      <LabeledField label="Notes" helperText="Optional — visible on the plan summary.">
        <TextField hiddenLabel size="small" fullWidth multiline minRows={2} value={notes}
          onChange={(e) => setNotes(e.target.value)} />
      </LabeledField>
      {step1Error && <Alert severity="warning" variant="outlined">{step1Error}</Alert>}
    </Stack>
  );

  const renderPreview = (): JSX.Element => (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        {previewLines.length} installment{previewLines.length === 1 ? '' : 's'} totalling{' '}
        {formatMinor(sumMinor(previewLines).toString(), currency)}.
      </Typography>
      <Table size="small">
        <TableHead><TableRow>
          <TableCell>#</TableCell><TableCell>Label</TableCell>
          <TableCell>Due on</TableCell><TableCell align="right">Amount</TableCell>
        </TableRow></TableHead>
        <TableBody>
          {previewLines.map((l, i) => (
            <TableRow key={i}>
              <TableCell>{i + 1}</TableCell><TableCell>{l.label}</TableCell>
              <TableCell>{l.due_on}</TableCell>
              <TableCell align="right">{formatMinor(l.gross_minor, currency)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Stack>
  );

  const renderConfirm = (): JSX.Element => {
    const rows: Array<[string, string]> = [
      ['Cadence', cadence], ['Starts on', startsOn], ['Currency', currency],
      ['Installments', String(previewLines.length)],
      ['Total', formatMinor((isCustom ? customSum : toBigIntSafe(totalMinor)).toString(), currency)],
    ];
    if (notes.trim()) rows.push(['Notes', notes.trim()]);
    return (
      <Stack spacing={1.5}>
        <Typography variant="body2">Ready to create this fee plan?</Typography>
        <Box sx={{ p: 1.5, borderRadius: 1, bgcolor: 'action.hover' }}>
          <Stack spacing={0.5}>
            {rows.map(([k, v]) => (
              <Typography key={k} variant="body2"><strong>{k}:</strong> {v}</Typography>
            ))}
          </Stack>
        </Box>
      </Stack>
    );
  };

  // CUSTOM skips the preview step (lines already shown in step 1).
  const stepLabels = isCustom ? ['Parameters', 'Confirm'] : ['Parameters', 'Preview', 'Confirm'];
  const onConfirmStep = step === 2;
  const onNext = (): void => {
    if (step === 0 && step1Error) return;
    if (step === 0 && isCustom) { setStep(2); return; }
    setStep((s) => Math.min(s + 1, 2) as 0 | 1 | 2);
  };
  const onBack = (): void => {
    if (step === 2 && isCustom) { setStep(0); return; }
    setStep((s) => Math.max(s - 1, 0) as 0 | 1 | 2);
  };

  return (
    <AppDialog
      open={open}
      title="Create fee plan"
      subtitle="Generate a payment schedule for this enrollment."
      onClose={handleClose}
      maxWidth="md"
      errorText={serverError}
      primaryAction={
        onConfirmStep
          ? { label: 'Create plan', onClick: handleSubmit, loading: create.isPending, loadingLabel: 'Creating' }
          : { label: 'Next', onClick: onNext, disabled: step === 0 && !!step1Error }
      }
      secondaryAction={step === 0
        ? { label: 'Cancel', onClick: handleClose }
        : { label: 'Back', onClick: onBack, disabled: create.isPending }}
    >
      <Stepper activeStep={step === 2 && isCustom ? 1 : step} sx={{ mb: 3 }}>
        {stepLabels.map((label) => (<Step key={label}><StepLabel>{label}</StepLabel></Step>))}
      </Stepper>
      {step === 0 && renderStep1()}
      {step === 1 && !isCustom && renderPreview()}
      {step === 2 && renderConfirm()}
    </AppDialog>
  );
}
