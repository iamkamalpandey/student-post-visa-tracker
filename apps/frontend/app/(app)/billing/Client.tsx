'use client';

// SVT-WAVE-BILLING-ADMIN-2026-05 — tenant-wide /billing admin console.
//
// Three tabs (Aged debt / Today's receipts / Refund queue) plus a KPI strip
// fed by /dashboard/finance-summary. Hard-gated on:
//   1. billing_enabled (tenant flag) — empty state + link to /settings when off
//   2. ADMIN role — generic "Access restricted" pane otherwise
//
// Per-student detail lives on the student page's BillingTab; this screen is
// the cross-tenant view counsellors land on when triaging collections.

import { useEffect, useState } from 'react';
import NextLink from 'next/link';
import { useSnackbar } from 'notistack';
import dayjs from 'dayjs';
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AccountBalanceWalletOutlinedIcon from '@mui/icons-material/AccountBalanceWalletOutlined';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import WarningAmberOutlinedIcon from '@mui/icons-material/WarningAmberOutlined';
import TrendingUpOutlinedIcon from '@mui/icons-material/TrendingUpOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import RequestQuoteOutlinedIcon from '@mui/icons-material/RequestQuoteOutlined';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { ApiError } from '@/lib/api';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import KpiTile from '@/components/KpiTile';
import ListPageShell from '@/components/ListPageShell';
import StatusChip from '@/components/StatusChip';
import {
  useAdminPayments,
  useAgedDebt,
  useBillingEnabled,
  useCompleteRefund,
  useFailRefund,
  useFinanceSummary,
  usePaymentDetail,
  type AgedDebtRow,
  type Payment,
} from '@/features/billing/queries';
import RefundPaymentDialog from '@/features/billing/RefundPaymentDialog';
import VoidPaymentDialog from '@/features/billing/VoidPaymentDialog';
import { MfaStepUpField, mfaStatusFromError, type MfaStepUpStatus } from '@/features/billing/MfaStepUpField';

// Today in YYYY-MM-DD — used as both `from` and `to` for the "today's receipts"
// query. We deliberately use local-clock midnight (not UTC) so a 23:00
// receipt entered in Asia/Kathmandu still lands on the operator's "today".
function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const BUCKET_LABEL: Record<AgedDebtRow['bucket'], string> = {
  CURRENT: 'Current',
  '1_30': '1–30 days',
  '31_60': '31–60 days',
  '61_90': '61–90 days',
  '90_PLUS': '90+ days',
};

const BUCKET_INTENT: Record<AgedDebtRow['bucket'], 'default' | 'warning' | 'error'> = {
  CURRENT: 'default',
  '1_30': 'default',
  '31_60': 'warning',
  '61_90': 'warning',
  '90_PLUS': 'error',
};

export default function BillingAdminClient() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const enabledQuery = useBillingEnabled();
  const billingEnabled = enabledQuery.data === true;

  // Only fetch downstream data when both gates are satisfied. `useBillingEnabled`
  // reads tenant.billing_enabled from /tenants/me, so this gate is settled by
  // the time the AppShell renders.
  const canFetch = isAdmin && billingEnabled;
  const summary = useFinanceSummary(canFetch);
  const agedDebt = useAgedDebt(canFetch);
  const today = todayIso();
  const todayReceipts = useAdminPayments(
    { from: today, to: today, limit: 100 },
    canFetch,
  );
  // The backend's PaymentListQuery only accepts a single status enum value, so
  // we can't ask for "PARTIALLY_REFUNDED OR REFUNDED" in one shot. There's also
  // no GET /billing/refunds index. The pragmatic surface for v5: list payments
  // that have *any* refund activity (PARTIALLY_REFUNDED) — those are the rows
  // an operator needs to chase on the refund queue. Fully REFUNDED rows are
  // archival and surfaced via the search filter on the student page.
  const refundQueue = useAdminPayments(
    { status: 'PARTIALLY_REFUNDED', limit: 100 },
    canFetch,
  );

  const [tab, setTab] = useState<'aged' | 'today' | 'refunds'>('aged');
  const fmt = useFormat();

  // SVT-WAVE-BILLING-2026-05 — Per-row action dialog state. Mirrors the
  // RecordPaymentDialog pattern in StudentDetailClient.tsx (single dialog
  // instance services every row via lifted state).
  const [refundPayment, setRefundPayment] = useState<Payment | null>(null);
  const [voidPaymentState, setVoidPaymentState] = useState<Payment | null>(null);
  const [completeRefundPayment, setCompleteRefundPayment] = useState<Payment | null>(null);
  const [failRefundPayment, setFailRefundPayment] = useState<Payment | null>(null);

  const refreshAll = () => {
    void summary.refetch();
    if (tab === 'aged') void agedDebt.refetch();
    if (tab === 'today') void todayReceipts.refetch();
    if (tab === 'refunds') void refundQueue.refetch();
  };

  // ----- Gates ------------------------------------------------------------
  if (enabledQuery.isLoading) {
    return (
      <ListPageShell title="Billing" description="Tenant-wide collections, receipts and refunds.">
        <Box sx={{ p: 4 }}>
          <Typography variant="body2" color="text.secondary">
            Loading billing module…
          </Typography>
        </Box>
      </ListPageShell>
    );
  }
  if (!billingEnabled) {
    return (
      <ListPageShell title="Billing" description="Tenant-wide collections, receipts and refunds." bareContent>
        <EmptyState
          title="Billing module is disabled"
          description="An admin can turn the billing module on from the workspace settings. Once enabled, this page will surface aged debt, today's receipts and the refund queue."
          icon={<AccountBalanceWalletOutlinedIcon fontSize="medium" />}
          actions={
            <Button component={NextLink} href="/settings" variant="contained">
              Open settings
            </Button>
          }
        />
      </ListPageShell>
    );
  }
  if (!isAdmin) {
    return (
      <ListPageShell title="Billing" description="Tenant-wide collections, receipts and refunds." bareContent>
        <EmptyState
          title="Access restricted"
          description="The billing console is admin-only. Ask a workspace admin to grant access, or view billing for a single student from their profile page."
          icon={<LockOutlinedIcon fontSize="medium" />}
        />
      </ListPageShell>
    );
  }

  // ----- KPI tiles --------------------------------------------------------
  // SVT-FIN-2026-06: money KPIs are per-currency (never netted). Render the
  // money tiles once per currency present; counts stay global. When >1
  // currency is present the tile labels carry the currency code.
  const fin = summary.data;
  const curRows = fin?.by_currency ?? [];
  const multiCurrency = curRows.length > 1;
  const moneyTiles =
    curRows.length > 0
      ? curRows.flatMap((row) => [
          <KpiTile
            key={`out-${row.currency}`}
            icon={<AccountBalanceWalletOutlinedIcon />}
            label={multiCurrency ? `Outstanding (${row.currency})` : 'Outstanding'}
            value={fmt.money(row.total_outstanding_minor, row.currency)}
            hint={summary.isFetching ? 'refreshing…' : undefined}
          />,
          <KpiTile
            key={`col-${row.currency}`}
            icon={<TrendingUpOutlinedIcon />}
            label={multiCurrency ? `Collections 30d (${row.currency})` : 'Collections (30d)'}
            value={fmt.money(row.collections_30d_minor, row.currency)}
          />,
          <KpiTile
            key={`rr-${row.currency}`}
            icon={<RequestQuoteOutlinedIcon />}
            label={multiCurrency ? `Refund rate 30d (${row.currency})` : 'Refund rate (30d)'}
            // refund_rate_30d is a 0-1 fraction with 4 decimals; render as percent.
            value={fmt.percent(row.refund_rate_30d * 100, 1)}
            intent={row.refund_rate_30d > 0.05 ? 'warning' : 'default'}
          />,
        ])
      : [
          <KpiTile key="out" icon={<AccountBalanceWalletOutlinedIcon />} label="Outstanding" value="—" />,
          <KpiTile key="col" icon={<TrendingUpOutlinedIcon />} label="Collections (30d)" value="—" />,
          <KpiTile key="rr" icon={<RequestQuoteOutlinedIcon />} label="Refund rate (30d)" value="—" />,
        ];
  const kpis = (
    <Box
      sx={{
        display: 'grid',
        gap: 2,
        gridTemplateColumns: { xs: '1fr', sm: 'repeat(2, 1fr)', lg: 'repeat(4, 1fr)' },
      }}
    >
      <KpiTile
        icon={<WarningAmberOutlinedIcon />}
        label="Overdue installments"
        value={fin?.overdue_count ?? '—'}
        intent={fin && fin.overdue_count > 0 ? 'warning' : 'default'}
      />
      {moneyTiles}
    </Box>
  );

  return (
    <ListPageShell
      title="Billing"
      description="Tenant-wide collections, receipts and refunds."
      action={
        <Tooltip title="Refresh">
          <span>
            <IconButton
              aria-label="Refresh billing"
              onClick={refreshAll}
              disabled={summary.isFetching || agedDebt.isFetching || todayReceipts.isFetching || refundQueue.isFetching}
            >
              <RefreshOutlinedIcon />
            </IconButton>
          </span>
        </Tooltip>
      }
      bareContent
    >
      <Stack spacing={3}>
        {summary.isError ? (
          <ErrorState
            title="Could not load finance summary"
            description={
              summary.error instanceof ApiError
                ? summary.error.detail || summary.error.title
                : 'Unexpected error'
            }
            onRetry={() => summary.refetch()}
            requestId={summary.error instanceof ApiError ? summary.error.requestId : undefined}
          />
        ) : (
          kpis
        )}

        <Box>
          <Tabs
            value={tab}
            onChange={(_, v: 'aged' | 'today' | 'refunds') => setTab(v)}
            aria-label="Billing sections"
            sx={{ borderBottom: 1, borderColor: 'divider', mb: 2 }}
          >
            <Tab value="aged" label="Aged debt" />
            <Tab value="today" label="Today's receipts" />
            <Tab value="refunds" label="Refund queue" />
          </Tabs>

          {tab === 'aged' ? (
            <AgedDebtTable
              isLoading={agedDebt.isLoading}
              isError={agedDebt.isError}
              error={agedDebt.error}
              rows={agedDebt.data?.rows ?? []}
              onRetry={() => agedDebt.refetch()}
              moneyFmt={fmt.money}
            />
          ) : null}

          {tab === 'today' ? (
            <PaymentsTable
              isLoading={todayReceipts.isLoading}
              isError={todayReceipts.isError}
              error={todayReceipts.error}
              rows={todayReceipts.data?.data ?? []}
              onRetry={() => todayReceipts.refetch()}
              moneyFmt={fmt.money}
              dateFmt={fmt.date}
              emptyTitle="No receipts logged today"
              emptyDescription="When counsellors record payments, they'll show up here in real time."
              rowActions={(p) => (
                p.status === 'RECEIVED' ? (
                  <Stack direction="row" spacing={1} justifyContent="flex-end">
                    <Button size="small" variant="outlined" onClick={() => setRefundPayment(p)}>
                      Refund
                    </Button>
                    <Button size="small" variant="outlined" color="error" onClick={() => setVoidPaymentState(p)}>
                      Void
                    </Button>
                  </Stack>
                ) : null
              )}
            />
          ) : null}

          {tab === 'refunds' ? (
            <PaymentsTable
              isLoading={refundQueue.isLoading}
              isError={refundQueue.isError}
              error={refundQueue.error}
              rows={refundQueue.data?.data ?? []}
              onRetry={() => refundQueue.refetch()}
              moneyFmt={fmt.money}
              dateFmt={fmt.date}
              emptyTitle="No partial refunds in flight"
              emptyDescription="Payments with pending refund activity (PARTIALLY_REFUNDED) appear here. Fully refunded receipts are archived on the student's billing tab."
              rowActions={(p) => (
                <Stack direction="row" spacing={1} justifyContent="flex-end">
                  <Button size="small" variant="contained" onClick={() => setCompleteRefundPayment(p)}>
                    Complete refund
                  </Button>
                  <Button
                    size="small"
                    variant="outlined"
                    color="error"
                    onClick={() => setFailRefundPayment(p)}
                  >
                    Mark failed
                  </Button>
                </Stack>
              )}
            />
          ) : null}
        </Box>
      </Stack>

      {refundPayment && (
        <RefundPaymentDialog
          open={!!refundPayment}
          onClose={() => setRefundPayment(null)}
          payment={refundPayment}
        />
      )}
      {voidPaymentState && (
        <VoidPaymentDialog
          open={!!voidPaymentState}
          onClose={() => setVoidPaymentState(null)}
          payment={voidPaymentState}
        />
      )}
      {completeRefundPayment && (
        <CompleteRefundDialog
          open={!!completeRefundPayment}
          payment={completeRefundPayment}
          onClose={() => setCompleteRefundPayment(null)}
        />
      )}
      {failRefundPayment && (
        <FailRefundDialog
          open={!!failRefundPayment}
          payment={failRefundPayment}
          onClose={() => setFailRefundPayment(null)}
        />
      )}
    </ListPageShell>
  );
}

// ---------------------------------------------------------------------------
// Subviews
// ---------------------------------------------------------------------------

function AgedDebtTable(props: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  rows: AgedDebtRow[];
  onRetry: () => void;
  moneyFmt: (amount: bigint | number | string | null | undefined, currency: string) => string;
}) {
  if (props.isError) {
    return (
      <ErrorState
        title="Could not load aged debt"
        description={
          props.error instanceof ApiError
            ? props.error.detail || props.error.title
            : 'Unexpected error'
        }
        onRetry={props.onRetry}
        requestId={props.error instanceof ApiError ? props.error.requestId : undefined}
      />
    );
  }
  const columns: DataTableColumn<AgedDebtRow>[] = [
    {
      key: 'bucket',
      label: 'Age bucket',
      render: (r) => (
        <Chip
          size="small"
          label={BUCKET_LABEL[r.bucket]}
          color={
            BUCKET_INTENT[r.bucket] === 'error'
              ? 'error'
              : BUCKET_INTENT[r.bucket] === 'warning'
                ? 'warning'
                : 'default'
          }
          variant="outlined"
        />
      ),
      width: 160,
    },
    {
      key: 'currency',
      label: 'Currency',
      render: (r) => (
        <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
          {r.currency}
        </Typography>
      ),
      width: 100,
    },
    {
      key: 'count',
      label: 'Installments',
      align: 'right',
      render: (r) => <span>{r.installment_count}</span>,
      width: 140,
    },
    {
      key: 'outstanding',
      label: 'Outstanding',
      align: 'right',
      render: (r) => (
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {props.moneyFmt(r.outstanding_minor, r.currency)}
        </Typography>
      ),
    },
  ];
  return (
    <DataTable<AgedDebtRow>
      columns={columns}
      rows={props.rows}
      loading={props.isLoading}
      getRowId={(r) => `${r.currency}:${r.bucket}`}
      emptyTitle="No outstanding balances"
      emptyDescription="Every issued installment is either paid, waived, cancelled or refunded."
      ariaLabel="Aged debt by bucket"
    />
  );
}

function PaymentsTable(props: {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  rows: Payment[];
  onRetry: () => void;
  moneyFmt: (amount: bigint | number | string | null | undefined, currency: string) => string;
  dateFmt: (iso: string) => string;
  emptyTitle: string;
  emptyDescription: string;
  /** Optional per-row trailing actions cell (e.g. Refund/Void buttons). */
  rowActions?: (p: Payment) => React.ReactNode;
}) {
  if (props.isError) {
    return (
      <ErrorState
        title="Could not load payments"
        description={
          props.error instanceof ApiError
            ? props.error.detail || props.error.title
            : 'Unexpected error'
        }
        onRetry={props.onRetry}
        requestId={props.error instanceof ApiError ? props.error.requestId : undefined}
      />
    );
  }
  const columns: DataTableColumn<Payment>[] = [
    {
      key: 'receipt',
      label: 'Receipt',
      render: (p) => (
        <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
          {p.receipt_no}
        </Typography>
      ),
      width: 160,
    },
    {
      key: 'received_on',
      label: 'Received',
      render: (p) => props.dateFmt(p.received_on),
      width: 140,
      hideOnMobile: true,
    },
    {
      key: 'method',
      label: 'Method',
      render: (p) => <StatusChip status={p.method} />,
      width: 140,
      hideOnMobile: true,
    },
    {
      key: 'amount',
      label: 'Amount',
      align: 'right',
      render: (p) => (
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {props.moneyFmt(p.gross_minor, p.currency)}
        </Typography>
      ),
      width: 160,
    },
    {
      key: 'status',
      label: 'Status',
      render: (p) => <StatusChip status={p.status} />,
      width: 180,
    },
    {
      key: 'reference',
      label: 'Reference',
      render: (p) => (
        <Typography variant="body2" color="text.secondary" noWrap>
          {p.reference || '—'}
        </Typography>
      ),
      hideOnMobile: true,
    },
  ];
  if (props.rowActions) {
    columns.push({
      key: 'actions',
      label: '',
      align: 'right',
      render: (p) => <>{props.rowActions!(p)}</>,
      width: 220,
    });
  }
  return (
    <DataTable<Payment>
      columns={columns}
      rows={props.rows}
      loading={props.isLoading}
      getRowId={(p) => p.id}
      emptyTitle={props.emptyTitle}
      emptyDescription={props.emptyDescription}
      ariaLabel="Payments table"
    />
  );
}

// ---------------------------------------------------------------------------
// CompleteRefundDialog — ConfirmDialog-ish modal for the Refund queue row's
// "Complete refund" action. The list endpoint doesn't embed refunds[] on each
// payment, so we lazy-fetch the payment detail to find the most recent PENDING
// refund and pass that id to useCompleteRefund.
// ---------------------------------------------------------------------------

function CompleteRefundDialog({
  open,
  payment,
  onClose,
}: {
  open: boolean;
  payment: Payment;
  onClose: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const detail = usePaymentDetail(open ? payment.id : null);
  const completeRefund = useCompleteRefund();

  const [refundedOn, setRefundedOn] = useState(() => dayjs().format('YYYY-MM-DD'));
  const [reference, setReference] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  // SVT-SEC-MFA-STEPUP-2026-05 — inline TOTP prompt when backend returns 401
  // { code: 'mfa_required' } for /billing/refunds/:id/complete.
  const [mfaStatus, setMfaStatus] = useState<MfaStepUpStatus>('idle');
  const [mfaCode, setMfaCode] = useState('');

  useEffect(() => {
    if (open) {
      setRefundedOn(dayjs().format('YYYY-MM-DD'));
      setReference('');
      setErrorText(null);
      setMfaStatus('idle');
      setMfaCode('');
    }
  }, [open]);

  // Newest-first PENDING refund — that's the one an operator most likely wants
  // to settle next. If none, render the empty-state.
  const pendingRefund = (detail.data?.refunds ?? [])
    .filter((r) => r.status === 'PENDING')
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0];

  async function handleConfirm() {
    if (!pendingRefund) return;
    setErrorText(null);
    try {
      await completeRefund.mutateAsync({
        id: pendingRefund.id,
        refunded_on: refundedOn,
        reference: reference.trim() || undefined,
        ...(mfaCode ? { mfa_code: mfaCode } : {}),
      });
      enqueueSnackbar('Refund completed.', { variant: 'success' });
      onClose();
    } catch (e) {
      // SVT-SEC-MFA-STEPUP-2026-05 — branch on step-up codes before falling
      // through to the generic error path so the inline prompt opens and
      // the user can retry with the X-MFA-Code header attached.
      const mfa = mfaStatusFromError(e);
      if (mfa) {
        setMfaStatus(mfa);
        if (mfa !== 'required') setMfaCode('');
        setErrorText(null);
        return;
      }
      const msg = (e as { message?: string })?.message ?? 'Could not complete refund.';
      setErrorText(msg);
      enqueueSnackbar(msg, { variant: 'error' });
    }
  }

  const loading = completeRefund.isPending;
  const canSubmit = !!pendingRefund && /^\d{4}-\d{2}-\d{2}$/.test(refundedOn) && !loading;

  return (
    <Dialog open={open} onClose={loading ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>Complete refund</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Receipt <strong>{payment.receipt_no}</strong>
          </Typography>

          {detail.isLoading ? (
            <Typography variant="body2" color="text.secondary">Loading refund detail…</Typography>
          ) : detail.isError ? (
            <Alert severity="error">Could not load payment detail.</Alert>
          ) : !pendingRefund ? (
            <Alert severity="info">
              No PENDING refund found on this payment. It may have already been completed or failed.
            </Alert>
          ) : (
            <>
              <Alert severity="info" variant="outlined">
                Marks the refund as settled and (optionally) carries any unmatched
                surplus forward as student credit.
              </Alert>

              <Stack spacing={0.5}>
                <Typography variant="caption" color="text.secondary">Refunded on</Typography>
                <TextField
                  type="date"
                  size="small"
                  value={refundedOn}
                  onChange={(e) => setRefundedOn(e.target.value)}
                  inputProps={{ 'aria-label': 'Refunded on' }}
                />
              </Stack>

              <Stack spacing={0.5}>
                <Typography variant="caption" color="text.secondary">Reference (optional)</Typography>
                <TextField
                  size="small"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Bank / txn reference"
                  inputProps={{ maxLength: 200, 'aria-label': 'Reference' }}
                />
              </Stack>
            </>
          )}

          {errorText ? <Alert severity="error">{errorText}</Alert> : null}

          <MfaStepUpField
            status={mfaStatus}
            value={mfaCode}
            onChange={setMfaCode}
            id="complete-refund-mfa-code"
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} disabled={loading} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={() => void handleConfirm()}
          disabled={!canSubmit}
          variant="contained"
        >
          {loading ? 'Completing…' : 'Complete refund'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// FailRefundDialog — sibling of CompleteRefundDialog for the FAILED transition
// (provider/bank rejected the refund). Requires a short operator-supplied
// reason; optional provider_error captures the upstream code for forensics.
// Same PENDING-refund lookup pattern as CompleteRefundDialog.
// ---------------------------------------------------------------------------

function FailRefundDialog({
  open,
  payment,
  onClose,
}: {
  open: boolean;
  payment: Payment;
  onClose: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const detail = usePaymentDetail(open ? payment.id : null);
  const failRefund = useFailRefund();

  const [reason, setReason] = useState('');
  const [providerError, setProviderError] = useState('');
  const [errorText, setErrorText] = useState<string | null>(null);
  const [mfaStatus, setMfaStatus] = useState<MfaStepUpStatus>('idle');
  const [mfaCode, setMfaCode] = useState('');

  useEffect(() => {
    if (open) {
      setReason('');
      setProviderError('');
      setErrorText(null);
      setMfaStatus('idle');
      setMfaCode('');
    }
  }, [open]);

  const pendingRefund = (detail.data?.refunds ?? [])
    .filter((r) => r.status === 'PENDING')
    .sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''))[0];

  async function handleConfirm() {
    if (!pendingRefund) return;
    setErrorText(null);
    try {
      await failRefund.mutateAsync({
        id: pendingRefund.id,
        reason: reason.trim(),
        ...(providerError.trim() ? { provider_error: providerError.trim() } : {}),
        ...(mfaCode ? { mfa_code: mfaCode } : {}),
      });
      enqueueSnackbar('Refund marked as failed.', { variant: 'success' });
      onClose();
    } catch (e) {
      const mfa = mfaStatusFromError(e);
      if (mfa) {
        setMfaStatus(mfa);
        if (mfa !== 'required') setMfaCode('');
        setErrorText(null);
        return;
      }
      const msg = (e as { message?: string })?.message ?? 'Could not mark refund failed.';
      setErrorText(msg);
      enqueueSnackbar(msg, { variant: 'error' });
    }
  }

  const loading = failRefund.isPending;
  // FailRefundRequest schema requires reason >= 3 chars.
  const canSubmit = !!pendingRefund && reason.trim().length >= 3 && !loading;

  return (
    <Dialog open={open} onClose={loading ? undefined : onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 700 }}>Mark refund failed</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Typography variant="body2" color="text.secondary">
            Receipt <strong>{payment.receipt_no}</strong>
          </Typography>

          {detail.isLoading ? (
            <Typography variant="body2" color="text.secondary">Loading refund detail…</Typography>
          ) : detail.isError ? (
            <Alert severity="error">Could not load payment detail.</Alert>
          ) : !pendingRefund ? (
            <Alert severity="info">
              No PENDING refund found on this payment. It may have already been completed or failed.
            </Alert>
          ) : (
            <>
              <Alert severity="warning" variant="outlined">
                Flags the refund as failed (provider/bank rejected). The student
                stays owed the original amount; create a new refund to retry.
              </Alert>

              <Stack spacing={0.5}>
                <Typography variant="caption" color="text.secondary">
                  Reason (visible in audit log)
                </Typography>
                <TextField
                  size="small"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. bank declined, account closed"
                  inputProps={{ maxLength: 500, 'aria-label': 'Reason' }}
                  multiline
                  minRows={2}
                />
              </Stack>

              <Stack spacing={0.5}>
                <Typography variant="caption" color="text.secondary">
                  Provider error (optional)
                </Typography>
                <TextField
                  size="small"
                  value={providerError}
                  onChange={(e) => setProviderError(e.target.value)}
                  placeholder="Upstream code / message"
                  inputProps={{ maxLength: 2000, 'aria-label': 'Provider error' }}
                />
              </Stack>
            </>
          )}

          {errorText ? <Alert severity="error">{errorText}</Alert> : null}

          <MfaStepUpField
            status={mfaStatus}
            value={mfaCode}
            onChange={setMfaCode}
            id="fail-refund-mfa-code"
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} disabled={loading} color="inherit">
          Cancel
        </Button>
        <Button
          onClick={() => void handleConfirm()}
          disabled={!canSubmit}
          variant="contained"
          color="error"
        >
          {loading ? 'Marking…' : 'Mark failed'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
