// SVT-WAVE-BILLING-2026-05 — PlanSummaryCard.
//
// Renders the FeePlan header + outstanding balance for a single enrollment.
// Used in the StudentDetailClient billing tab and standalone billing pages.
//
// Behaviour:
//   - useBillingEnabled() gates the whole card. When billing is off, returns
//     null so the parent doesn't reserve space.
//   - useFeePlans({ enrollment_id }) fetches the active plan; useOutstanding
//     pulls the per-enrollment outstanding aggregate.
//   - Empty state ("No fee plan yet") with admin-only "Create plan" CTA hook.
//   - Loading + error states use the shared primitives.
//
// Currency formatting goes through useFormat() so the displayed amount
// respects the caller's locale + currency.
//
// SVT-FIN-2026-08 — money() / formatMoney() takes MINOR units and performs the
// major-unit conversion itself (lib/format.ts). This file used to divide by 100
// first and then hand the result to money(), which divided by 100 again: a
// £12,000.00 plan total rendered as £120.00 on every card, and the same double
// conversion hit Outstanding and each per-status chip. Pass the minor-unit
// value straight through — never pre-convert.

'use client';

import { useState } from 'react';
import { Card, CardContent, Stack, Typography, Chip, Box, Skeleton, Alert, Button } from '@mui/material';
import DownloadIcon from '@mui/icons-material/Download';
import { useFormat } from '../../lib/format';
import { downloadAuthed } from '../../lib/download';
import StatusChip from '../../components/StatusChip';
import {
  useBillingEnabled,
  useFeePlans,
  useOutstanding,
  type FeePlan,
  type FeePlanStatus,
} from './queries';

export type PlanSummaryCardProps = {
  enrollmentId: string;
  /** Compact mode hides the "no plan yet" affordance — used inside lists. */
  compact?: boolean;
  /** Called when the admin clicks "Create fee plan" (when no plan exists). */
  onCreatePlan?: () => void;
};

const PLAN_STATUS_COLORS: Record<FeePlanStatus, 'success' | 'warning' | 'info' | 'default' | 'error'> = {
  ACTIVE: 'success',
  PAUSED: 'warning',
  DRAFT: 'info',
  COMPLETED: 'default',
  CANCELLED: 'error',
};

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

export default function PlanSummaryCard({ enrollmentId, compact, onCreatePlan }: PlanSummaryCardProps) {
  const billingEnabled = useBillingEnabled();
  const plansQuery = useFeePlans({ enrollment_id: enrollmentId, limit: 5 });
  const outstandingQuery = useOutstanding({ enrollment_id: enrollmentId });
  const { money, date } = useFormat();
  // Invoice download — independent loading state so the rest of the card
  // doesn't flicker while the PDF blob streams in.
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const handleDownloadInvoice = async (planId: string): Promise<void> => {
    setDownloadError(null);
    setDownloading(true);
    try {
      await downloadAuthed(`/billing/plans/${planId}/invoice.pdf`, `invoice-${planId}.pdf`);
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : 'Failed to download invoice');
    } finally {
      setDownloading(false);
    }
  };

  if (billingEnabled.data === false) {
    return null;
  }

  if (plansQuery.isLoading || billingEnabled.isLoading) {
    return (
      <Card variant="outlined" sx={{ borderRadius: 2 }}>
        <CardContent>
          <Skeleton width="40%" />
          <Skeleton width="60%" sx={{ mt: 1 }} />
          <Skeleton variant="rectangular" height={42} sx={{ mt: 2 }} />
        </CardContent>
      </Card>
    );
  }

  if (plansQuery.isError) {
    return (
      <Card variant="outlined" sx={{ borderRadius: 2 }}>
        <CardContent>
          <Alert severity="error" variant="outlined">
            Could not load billing plan. Try refreshing.
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const plans = plansQuery.data?.data ?? [];
  // Active or paused or draft plans are "current". Completed/cancelled are
  // historical — surface only when no current plan exists.
  const current: FeePlan | undefined =
    plans.find((p) => p.status === 'ACTIVE') ??
    plans.find((p) => p.status === 'PAUSED') ??
    plans.find((p) => p.status === 'DRAFT') ??
    plans[0];

  if (!current) {
    if (compact) return null;
    return (
      <Card variant="outlined" sx={{ borderRadius: 2 }}>
        <CardContent>
          <Stack spacing={1.5}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Billing
            </Typography>
            <Typography variant="body2" color="text.secondary">
              No fee plan yet for this enrolment.
            </Typography>
            {onCreatePlan ? (
              <Box>
                <button
                  type="button"
                  onClick={onCreatePlan}
                  style={{
                    background: 'transparent',
                    border: '1px solid currentColor',
                    borderRadius: 6,
                    padding: '6px 12px',
                    cursor: 'pointer',
                  }}
                >
                  Create fee plan
                </button>
              </Box>
            ) : null}
          </Stack>
        </CardContent>
      </Card>
    );
  }

  const outstanding = outstandingQuery.data;
  const installmentCount = current.installments?.length ?? null;
  const totalAmount = current.total_minor; // minor units — money() converts
  // SVT-QA-2026-08 — response is now per-currency. This card is scoped to a
  // single enrollment so we pick the bucket matching the plan's currency;
  // absent → treat as zero outstanding.
  const outstandingBucket = outstanding?.by_currency.find(
    (b) => b.currency === current.currency,
  ) ?? null;
  const outstandingAmount = outstandingBucket
    ? outstandingBucket.total_minor // minor units — money() converts
    : null;

  return (
    <Card variant="outlined" sx={{ borderRadius: 2 }}>
      <CardContent>
        <Stack spacing={2}>
          <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Billing
            </Typography>
            <StatusChip
              status={current.status}
              color={PLAN_STATUS_COLORS[current.status]}
            />
          </Stack>

          <Stack direction="row" spacing={3} flexWrap="wrap">
            <Stack spacing={0.25}>
              <Typography variant="caption" color="text.secondary">Plan total</Typography>
              <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {money(totalAmount, current.currency)}
              </Typography>
              {installmentCount != null && (
                <Typography variant="caption" color="text.secondary">
                  {installmentCount} {plural(installmentCount, 'installment', 'installments')} · {current.cadence.toLowerCase()}
                </Typography>
              )}
            </Stack>

            <Stack spacing={0.25}>
              <Typography variant="caption" color="text.secondary">Outstanding</Typography>
              <Typography variant="h6" sx={{ fontVariantNumeric: 'tabular-nums' }} color={outstandingAmount != null && Number(outstandingAmount) > 0 ? 'warning.main' : 'success.main'}>
                {outstandingAmount != null && outstandingBucket
                  ? money(outstandingAmount, outstandingBucket.currency)
                  : '—'}
              </Typography>
              {outstandingBucket?.oldest_due_on ? (
                <Typography variant="caption" color="text.secondary">
                  Oldest due {date(outstandingBucket.oldest_due_on)}
                </Typography>
              ) : (
                <Typography variant="caption" color="text.secondary">
                  Nothing due
                </Typography>
              )}
            </Stack>

            {current.starts_on ? (
              <Stack spacing={0.25}>
                <Typography variant="caption" color="text.secondary">Starts</Typography>
                <Typography variant="body2">{date(current.starts_on)}</Typography>
              </Stack>
            ) : null}
          </Stack>

          {current.status === 'PAUSED' && current.paused_reason ? (
            <Alert severity="warning" variant="outlined" sx={{ '& .MuiAlert-message': { fontSize: 13 } }}>
              Plan paused: {current.paused_reason}
            </Alert>
          ) : null}

          {/* Invoice download — uses authenticated blob fetch so the Bearer
              token is attached. Falls back to in-card error text on failure
              rather than an unconditional snackbar so a user with a stale
              session sees the actual problem in context. */}
          <Box>
            <Button
              size="small"
              variant="outlined"
              color="primary"
              startIcon={<DownloadIcon />}
              disabled={downloading}
              onClick={() => { void handleDownloadInvoice(current.id); }}
            >
              {downloading ? 'Preparing PDF…' : 'Download invoice'}
            </Button>
            {downloadError ? (
              <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 0.5 }}>
                {downloadError}
              </Typography>
            ) : null}
          </Box>

          {outstandingBucket?.by_status ? (
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {Object.entries(outstandingBucket.by_status).map(([status, minor]) => {
                const v = minor; // minor units — money() converts
                if (Number(v) <= 0) return null;
                return (
                  <Chip
                    key={status}
                    size="small"
                    variant="outlined"
                    label={`${status}: ${money(v, outstandingBucket.currency)}`}
                  />
                );
              })}
            </Stack>
          ) : null}
        </Stack>
      </CardContent>
    </Card>
  );
}
