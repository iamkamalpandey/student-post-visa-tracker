'use client';

// Refactored to SVT form-pattern per design pass.
import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import {
  Autocomplete,
  Box,
  Button,
  Card,
  CardContent,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  ListItemIcon,
  Menu,
  MenuItem,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import PaidOutlinedIcon from '@mui/icons-material/PaidOutlined';
import GavelOutlinedIcon from '@mui/icons-material/GavelOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import BlockOutlinedIcon from '@mui/icons-material/BlockOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import ReplayOutlinedIcon from '@mui/icons-material/ReplayOutlined';
import RequestQuoteOutlinedIcon from '@mui/icons-material/RequestQuoteOutlined';

import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { isAdmin as roleIsAdmin } from '@/lib/auth-helpers';
import { formatDate, formatMoney } from '@/lib/format';
import AppDialog from '@/components/AppDialog';
import ConfirmDialog from '@/components/ConfirmDialog';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import ListPageShell from '@/components/ListPageShell';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import StatusChip from '@/components/StatusChip';
import LabeledField from '@/components/LabeledField';

import InvoiceDialog from '@/features/commissions/InvoiceDialog';
import MarkPaidDialog from '@/features/commissions/MarkPaidDialog';
import DisputeDialog from '@/features/commissions/DisputeDialog';
import ResolveDisputeDialog from '@/features/commissions/ResolveDisputeDialog';
import EditCommissionDialog from '@/features/commissions/EditCommissionDialog';
import {
  COMMISSION_STATUS_COLOR,
  COMMISSION_TABS,
  type CommissionFilters,
  type CommissionListResponse,
  type CommissionRow,
  type CommissionSummaryResponse,
} from '@/features/commissions/types';

// ---------------------------------------------------------------------------
// Lookup mini-types — we only consume the fields we actually need here, so the
// types stay loose enough to survive backend additions without churn.
// ---------------------------------------------------------------------------

type InstitutionLookup = {
  id: string;
  display_name?: string;
  legal_name?: string;
  short_name?: string | null;
  country_code?: string;
};

type StudentLookup = {
  id: string;
  given_name: string;
  family_name: string;
  student_code: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function unwrapList<T>(payload: unknown): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    const inner = (payload as { data: unknown }).data;
    if (Array.isArray(inner)) return inner as T[];
  }
  return [];
}

function ForbiddenState() {
  const t = useTranslations('commissions.list');
  return (
    <Stack spacing={3}>
      <Stack spacing={0.75}>
        <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
          {t('title')}
        </Typography>
      </Stack>
      <EmptyState
        icon={<LockOutlinedIcon fontSize="medium" />}
        title={t('forbiddenTitle')}
        description={t('forbiddenDescription')}
      />
    </Stack>
  );
}

function useDebounced<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Receipt modal (PAID only — read-only).
// ---------------------------------------------------------------------------

function ReceiptDialog({
  open,
  claim,
  onClose,
}: {
  open: boolean;
  claim: CommissionRow | null;
  onClose: () => void;
}) {
  const t = useTranslations('commissions.list');
  const tR = useTranslations('commissions.list.receipt');
  const tCommon = useTranslations('common');
  return (
    <AppDialog
      open={open}
      onClose={onClose}
      title={t('receiptTitle')}
      subtitle={claim ? t('receiptSubtitle', { institution: claim.institution.display_name }) : undefined}
      primaryAction={{ label: tCommon('close'), onClick: onClose }}
      secondaryAction={{ label: tCommon('done'), onClick: onClose }}
    >
      {claim ? (
        <Stack spacing={1.5}>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">{tR('status')}</Typography>
            <StatusChip status={claim.status} color={COMMISSION_STATUS_COLOR[claim.status]} />
          </Stack>
          <Divider />
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">{tR('amount')}</Typography>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {formatMoney(toBigIntSafe(claim.amount_minor), claim.currency)}
            </Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">{tR('commissionPct')}</Typography>
            <Typography variant="body2">{claim.commission_pct}%</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">{tR('tuitionBasis')}</Typography>
            <Typography variant="body2">
              {formatMoney(toBigIntSafe(claim.basis_minor), claim.currency)}
            </Typography>
          </Stack>
          <Divider />
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">{tR('claimedOn')}</Typography>
            <Typography variant="body2">{claim.claimed_on ? formatDate(claim.claimed_on) : '—'}</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">{tR('invoiceNo')}</Typography>
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
              {claim.invoice_no ?? '—'}
            </Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">{tR('invoicedOn')}</Typography>
            <Typography variant="body2">{claim.invoiced_on ? formatDate(claim.invoiced_on) : '—'}</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">{tR('paidOn')}</Typography>
            <Typography variant="body2">{claim.paid_on ? formatDate(claim.paid_on) : '—'}</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">{tR('paymentReference')}</Typography>
            <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
              {claim.payment_reference ?? '—'}
            </Typography>
          </Stack>
          <Divider />
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">{tR('created')}</Typography>
            <Typography variant="body2">{formatDate(claim.created_at)}</Typography>
          </Stack>
          <Stack direction="row" justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">{tR('updated')}</Typography>
            <Typography variant="body2">{formatDate(claim.updated_at)}</Typography>
          </Stack>
        </Stack>
      ) : null}
    </AppDialog>
  );
}

function toBigIntSafe(v: bigint | string | number): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  try {
    return BigInt(v);
  } catch {
    return 0n;
  }
}

// ---------------------------------------------------------------------------
// Summary strip — headline buckets, ONE ROW PER CURRENCY.
//
// SVT-FIN-2026-08 — two problems fixed here.
//
// 1. The strip was permanently blank. It read `summary.totals` and
//    `row.buckets`, neither of which the API sends; every card rendered "—".
//
// 2. The fallback it fell through to summed `bucket.total_minor` across ALL
//    currencies into one number and then labelled that number with whichever
//    currency code appeared on the most rows. That is the same
//    "one total, rows[0].currency" pattern that already shipped once in the
//    outstanding aggregate. A comment claimed it avoided "silently mixing
//    currencies"; it did exactly that. USD 10,000 + GBP 5,000 would have
//    displayed as "$15,000.00".
//
// Money is only ever aggregated within a single ISO code, so the strip now
// renders a row of cards per currency and names the currency when there is
// more than one.
// ---------------------------------------------------------------------------

type StripBucket = { status: 'PENDING' | 'CLAIMED' | 'INVOICED' | 'PAID'; total: bigint };
type StripRow = { currency: string; buckets: StripBucket[] };

function deriveStrip(summary: CommissionSummaryResponse | undefined): StripRow[] {
  const byCurrency = new Map<string, Record<StripBucket['status'], bigint>>();
  for (const row of summary?.data ?? []) {
    const cur = row.currency || '';
    if (!cur) continue;
    const slot = byCurrency.get(cur) ?? { PENDING: 0n, CLAIMED: 0n, INVOICED: 0n, PAID: 0n };
    slot.PENDING += toBigIntSafe(row.pending_total_minor);
    slot.CLAIMED += toBigIntSafe(row.claimed_total_minor);
    slot.INVOICED += toBigIntSafe(row.invoiced_total_minor);
    slot.PAID += toBigIntSafe(row.paid_total_minor);
    byCurrency.set(cur, slot);
  }
  return [...byCurrency.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([currency, totals]) => ({
      currency,
      buckets: [
        { status: 'PENDING' as const, total: totals.PENDING },
        { status: 'CLAIMED' as const, total: totals.CLAIMED },
        { status: 'INVOICED' as const, total: totals.INVOICED },
        { status: 'PAID' as const, total: totals.PAID },
      ],
    }));
}

function SummaryStrip({ summary, loading }: { summary: CommissionSummaryResponse | undefined; loading: boolean }) {
  const t = useTranslations('commissions.list.summary');
  if (loading) return <LoadingSkeleton variant="stat-grid" />;
  const rows = deriveStrip(summary);
  if (rows.length === 0) return null;
  const showCurrencyLabel = rows.length > 1;
  return (
    <Stack spacing={2}>
      {rows.map((row) => (
        <Box key={row.currency}>
          {showCurrencyLabel ? (
            <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
              {row.currency}
            </Typography>
          ) : null}
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', lg: 'repeat(4, 1fr)' },
            }}
          >
            {row.buckets.map((b) => (
              <Card key={`${row.currency}-${b.status}`} variant="outlined">
                <CardContent>
                  <Typography variant="overline" color="text.secondary" sx={{ letterSpacing: 0.6 }}>
                    {b.status}
                  </Typography>
                  <Typography variant="h5" sx={{ fontWeight: 700, mt: 0.5 }}>
                    {formatMoney(b.total, row.currency)}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {t('totalCaption', { label: b.status.toLowerCase() })}
                  </Typography>
                </CardContent>
              </Card>
            ))}
          </Box>
        </Box>
      ))}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// Filter URL <-> state helpers
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 25;

function parseFiltersFromSearch(sp: URLSearchParams): CommissionFilters {
  const status = (sp.get('status') ?? 'ALL').toUpperCase();
  const validStatuses: CommissionFilters['status'][] = ['ALL', 'PENDING', 'CLAIMED', 'INVOICED', 'PAID', 'DISPUTED'];
  return {
    status: (validStatuses.includes(status as CommissionFilters['status'])
      ? (status as CommissionFilters['status'])
      : 'ALL'),
    institution_id: sp.get('institution_id') || undefined,
    student_id: sp.get('student_id') || undefined,
    enrollment_id: sp.get('enrollment_id') || undefined,
    claimed_from: sp.get('claimed_from') || undefined,
    claimed_to: sp.get('claimed_to') || undefined,
    paid_from: sp.get('paid_from') || undefined,
    paid_to: sp.get('paid_to') || undefined,
    page: Math.max(0, Number(sp.get('page') ?? '0')),
    limit: Math.max(1, Number(sp.get('limit') ?? String(DEFAULT_LIMIT))),
  };
}

function filtersToSearch(f: CommissionFilters): string {
  const qs = new URLSearchParams();
  if (f.status !== 'ALL') qs.set('status', f.status);
  if (f.institution_id) qs.set('institution_id', f.institution_id);
  if (f.student_id) qs.set('student_id', f.student_id);
  if (f.enrollment_id) qs.set('enrollment_id', f.enrollment_id);
  if (f.claimed_from) qs.set('claimed_from', f.claimed_from);
  if (f.claimed_to) qs.set('claimed_to', f.claimed_to);
  if (f.paid_from) qs.set('paid_from', f.paid_from);
  if (f.paid_to) qs.set('paid_to', f.paid_to);
  if (f.page > 0) qs.set('page', String(f.page));
  if (f.limit !== DEFAULT_LIMIT) qs.set('limit', String(f.limit));
  return qs.toString();
}

function filtersToApiParams(f: CommissionFilters): Record<string, string | number> {
  const p: Record<string, string | number> = { page: f.page + 1, limit: f.limit };
  if (f.status !== 'ALL') p.status = f.status;
  if (f.institution_id) p.institution_id = f.institution_id;
  if (f.student_id) p.student_id = f.student_id;
  if (f.claimed_from) p.claimed_from = f.claimed_from;
  if (f.claimed_to) p.claimed_to = f.claimed_to;
  if (f.paid_from) p.paid_from = f.paid_from;
  if (f.paid_to) p.paid_to = f.paid_to;
  return p;
}

// ---------------------------------------------------------------------------
// Main client component
// ---------------------------------------------------------------------------

export default function CommissionsClient() {
  const { user } = useAuth();
  const isAdminUser = roleIsAdmin(user?.role);
  const router = useRouter();
  const search = useSearchParams();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const t = useTranslations('commissions.list');
  const tToast = useTranslations('commissions.list.toasts');
  const tFilters = useTranslations('commissions.list.filters');
  const tCommon = useTranslations('common');

  const filters = useMemo(
    () => parseFiltersFromSearch(new URLSearchParams(search?.toString() ?? '')),
    [search],
  );

  // Update URL — preserves shareable / back-navigable filter state.
  const setFilters = (next: Partial<CommissionFilters>) => {
    const merged: CommissionFilters = { ...filters, ...next };
    // Reset page to 0 whenever filters (other than page itself) change.
    if (
      next.status !== undefined ||
      next.institution_id !== undefined ||
      next.student_id !== undefined ||
      next.enrollment_id !== undefined ||
      next.claimed_from !== undefined ||
      next.claimed_to !== undefined ||
      next.paid_from !== undefined ||
      next.paid_to !== undefined ||
      next.limit !== undefined
    ) {
      merged.page = 0;
    }
    const qs = filtersToSearch(merged);
    router.replace(qs ? `/commissions?${qs}` : '/commissions');
  };

  // -------------------------------------------------------------------------
  // Lookups — institution + student autocompletes (debounced search).
  // -------------------------------------------------------------------------

  const [instInput, setInstInput] = useState('');
  const debInstInput = useDebounced(instInput, 250);
  const institutionsQuery = useQuery({
    queryKey: ['institutions', 'lookup', debInstInput],
    enabled: isAdminUser,
    queryFn: async () => {
      const res = await api.get('/institutions', {
        params: { limit: 25, ...(debInstInput ? { q: debInstInput } : {}) },
      });
      return unwrapList<InstitutionLookup>(res.data);
    },
  });

  const [studentInput, setStudentInput] = useState('');
  const debStudentInput = useDebounced(studentInput, 250);
  const studentsQuery = useQuery({
    queryKey: ['students', 'lookup', debStudentInput],
    enabled: isAdminUser,
    queryFn: async () => {
      const res = await api.get('/students', {
        params: { limit: 25, ...(debStudentInput ? { search: debStudentInput } : {}) },
      });
      return unwrapList<StudentLookup>(res.data);
    },
  });

  // Resolve currently-selected lookups so the Autocomplete shows a label
  // even when the user lands here via a deep-link before search results load.
  const selectedInstitution = useMemo(() => {
    if (!filters.institution_id) return null;
    return (
      (institutionsQuery.data ?? []).find((i) => i.id === filters.institution_id) ?? {
        id: filters.institution_id,
        display_name: filters.institution_id,
      }
    );
  }, [filters.institution_id, institutionsQuery.data]);

  const selectedStudent = useMemo(() => {
    if (!filters.student_id) return null;
    return (
      (studentsQuery.data ?? []).find((s) => s.id === filters.student_id) ?? {
        id: filters.student_id,
        given_name: '',
        family_name: filters.student_id,
        student_code: '',
      }
    );
  }, [filters.student_id, studentsQuery.data]);

  // -------------------------------------------------------------------------
  // List + summary queries
  // -------------------------------------------------------------------------

  const listQuery = useQuery<CommissionListResponse>({
    queryKey: ['commissions', filters],
    enabled: isAdminUser,
    queryFn: async () => {
      const res = await api.get<CommissionListResponse>('/commissions', {
        params: filtersToApiParams(filters),
      });
      return res.data;
    },
    placeholderData: (prev) => prev,
  });

  const summaryQuery = useQuery<CommissionSummaryResponse>({
    queryKey: ['commissions', 'summary'],
    enabled: isAdminUser,
    queryFn: async () => {
      const res = await api.get<CommissionSummaryResponse>('/commissions/summary');
      return res.data;
    },
    staleTime: 30_000,
  });

  // -------------------------------------------------------------------------
  // Row action menu + dialog state
  // -------------------------------------------------------------------------

  const [rowMenu, setRowMenu] = useState<{ anchor: HTMLElement; row: CommissionRow } | null>(null);
  const [invoiceTarget, setInvoiceTarget] = useState<CommissionRow | null>(null);
  const [paidTarget, setPaidTarget] = useState<CommissionRow | null>(null);
  const [disputeTarget, setDisputeTarget] = useState<CommissionRow | null>(null);
  const [editTarget, setEditTarget] = useState<CommissionRow | null>(null);
  const [waiveTarget, setWaiveTarget] = useState<CommissionRow | null>(null);
  const [resolveTarget, setResolveTarget] = useState<CommissionRow | null>(null);
  const [receiptTarget, setReceiptTarget] = useState<CommissionRow | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const closeMenu = () => setRowMenu(null);

  // Single-row claim mutation (used by both row action and bulk action).
  const claimMutation = useMutation<unknown, ApiError, string>({
    mutationFn: async (id) => {
      const res = await api.post(`/commissions/${id}/claim`);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(tToast('claimed'), { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['commissions'] });
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title || tToast('claimError'), { variant: 'error' }),
  });

  const waiveMutation = useMutation<unknown, ApiError, string>({
    mutationFn: async (id) => {
      const res = await api.post(`/commissions/${id}/waive`);
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar(tToast('waived'), { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['commissions'] });
      setWaiveTarget(null);
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title || tToast('waiveError'), { variant: 'error' }),
  });

  // Resolve dispute → POST /commissions/:id/resolve-dispute (DISPUTED → INVOICED).
  // The dedicated endpoint is the only safe path: the previous PATCH-notes
  // approach left status stuck on DISPUTED while showing a success toast.
  // The form lives in `ResolveDisputeDialog` so the user can attach an
  // optional resolution note. See features/commissions/ResolveDisputeDialog.

  // -------------------------------------------------------------------------
  // Bulk action — claim every selected PENDING row.
  // -------------------------------------------------------------------------

  const [bulkBusy, setBulkBusy] = useState(false);

  async function bulkClaim() {
    const rows = (listQuery.data?.data ?? []).filter(
      (r) => selected.has(r.id) && r.status === 'PENDING',
    );
    if (rows.length === 0) {
      enqueueSnackbar(t('noPendingSelection'), { variant: 'info' });
      return;
    }
    setBulkBusy(true);
    const results = await Promise.allSettled(
      rows.map((r) => api.post(`/commissions/${r.id}/claim`)),
    );
    setBulkBusy(false);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    const failed = results.length - ok;
    enqueueSnackbar(
      failed === 0
        ? t('claimedSummary', { count: ok })
        : t('claimedFailed', { ok, failed }),
      { variant: failed === 0 ? 'success' : 'warning' },
    );
    setSelected(new Set());
    qc.invalidateQueries({ queryKey: ['commissions'] });
  }

  // -------------------------------------------------------------------------
  // Selection helpers — only PENDING rows are selectable for the bulk claim.
  // -------------------------------------------------------------------------

  const rows = listQuery.data?.data ?? [];
  const selectablePendingIds = useMemo(
    () => rows.filter((r) => r.status === 'PENDING').map((r) => r.id),
    [rows],
  );
  const allPendingSelected =
    selectablePendingIds.length > 0 &&
    selectablePendingIds.every((id) => selected.has(id));
  const somePendingSelected =
    selectablePendingIds.some((id) => selected.has(id)) && !allPendingSelected;

  function toggleAllPending() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPendingSelected) {
        for (const id of selectablePendingIds) next.delete(id);
      } else {
        for (const id of selectablePendingIds) next.add(id);
      }
      return next;
    });
  }

  function toggleRow(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  // -------------------------------------------------------------------------
  // Columns
  // -------------------------------------------------------------------------

  const columns: DataTableColumn<CommissionRow>[] = [
    {
      key: 'select',
      label: (
        <Checkbox
          size="small"
          indeterminate={somePendingSelected}
          checked={allPendingSelected}
          onChange={toggleAllPending}
          disabled={selectablePendingIds.length === 0}
          inputProps={{ 'aria-label': t('selectAllPending') }}
        />
      ),
      width: 48,
      render: (r) => (
        <Checkbox
          size="small"
          checked={selected.has(r.id)}
          disabled={r.status !== 'PENDING'}
          onClick={(e) => e.stopPropagation()}
          onChange={() => toggleRow(r.id)}
          inputProps={{ 'aria-label': t('selectCommission', { id: r.id }) }}
        />
      ),
    },
    {
      key: 'student',
      label: t('columns.student'),
      render: (r) => (
        <Stack spacing={0.25}>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {`${r.student.given_name} ${r.student.family_name}`.trim() || r.student.student_code}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {r.student.student_code}
          </Typography>
        </Stack>
      ),
    },
    {
      key: 'institution',
      label: t('columns.institution'),
      render: (r) => (
        <Stack spacing={0.25}>
          <Typography variant="body2">{r.institution.display_name}</Typography>
          <Typography variant="caption" color="text.secondary">
            {r.institution.country_code}
          </Typography>
        </Stack>
      ),
    },
    {
      key: 'course',
      label: t('columns.course'),
      hideOnMobile: true,
      render: (r) => r.enrollment.program?.name ?? '—',
    },
    {
      key: 'intake',
      label: t('columns.intake'),
      hideOnMobile: true,
      render: (r) => r.enrollment.program_intake?.intake_label ?? '—',
    },
    {
      key: 'basis',
      label: t('columns.tuitionBasis'),
      align: 'right',
      hideOnMobile: true,
      render: (r) => formatMoney(toBigIntSafe(r.basis_minor), r.currency),
    },
    {
      key: 'pct',
      label: t('columns.pct'),
      align: 'right',
      width: 64,
      render: (r) => `${r.commission_pct}%`,
    },
    {
      key: 'amount',
      label: t('columns.amount'),
      align: 'right',
      render: (r) => (
        <Typography variant="body2" sx={{ fontWeight: 600 }}>
          {formatMoney(toBigIntSafe(r.amount_minor), r.currency)}
        </Typography>
      ),
    },
    {
      // SVT-FIN-2026-08 — the claimed-vs-received variance, finally visible.
      // received_minor has been stored since migration …235993 and displayed
      // nowhere, so a university remitting 18,400 against a 20,000 claim looked
      // settled in full and the 1,600 shortfall was invisible on every screen.
      // Only meaningful once PAID; null on legacy rows, which mean "in full".
      key: 'received',
      label: 'Received',
      align: 'right',
      render: (r) => {
        if (r.status !== 'PAID') return <Typography variant="body2" color="text.disabled">—</Typography>;
        const claimed = toBigIntSafe(r.amount_minor);
        const received = r.received_minor == null ? claimed : toBigIntSafe(r.received_minor);
        const variance = claimed - received;
        return (
          <Stack spacing={0.25} alignItems="flex-end">
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {formatMoney(received, r.currency)}
            </Typography>
            {variance !== 0n ? (
              <Typography
                variant="caption"
                color={variance > 0n ? 'error.main' : 'warning.main'}
                sx={{ fontWeight: 600 }}
              >
                {variance > 0n ? 'short ' : 'over '}
                {formatMoney(variance > 0n ? variance : -variance, r.currency)}
              </Typography>
            ) : null}
          </Stack>
        );
      },
    },
    {
      key: 'status',
      label: t('columns.status'),
      render: (r) => <StatusChip status={r.status} color={COMMISSION_STATUS_COLOR[r.status]} />,
    },
    {
      key: 'claimed',
      label: t('columns.claimed'),
      hideOnMobile: true,
      render: (r) => (r.claimed_on ? formatDate(r.claimed_on) : '—'),
    },
    {
      key: 'invoice_no',
      label: t('columns.invoiceNo'),
      hideOnMobile: true,
      render: (r) => (
        <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
          {r.invoice_no ?? '—'}
        </Typography>
      ),
    },
    {
      key: 'paid',
      label: t('columns.paidOn'),
      hideOnMobile: true,
      render: (r) => (r.paid_on ? formatDate(r.paid_on) : '—'),
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      width: 48,
      render: (r) => (
        <IconButton
          size="small"
          aria-label={t('actionsForCommission', { id: r.id })}
          onClick={(e) => {
            e.stopPropagation();
            setRowMenu({ anchor: e.currentTarget, row: r });
          }}
        >
          <MoreVertOutlinedIcon fontSize="small" />
        </IconButton>
      ),
    },
  ];

  if (!isAdminUser) return <ForbiddenState />;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const total = listQuery.data?.page?.total ?? rows.length;
  const filtersApplied = Boolean(
    filters.institution_id ||
      filters.student_id ||
      filters.claimed_from ||
      filters.claimed_to ||
      filters.paid_from ||
      filters.paid_to ||
      filters.status !== 'ALL',
  );

  const pendingSelectedCount = Array.from(selected).filter((id) =>
    rows.some((r) => r.id === id && r.status === 'PENDING'),
  ).length;

  return (
    <>
      <ListPageShell
        title={t('title')}
        description={t('description')}
        action={
          pendingSelectedCount > 0 ? (
            <Button
              variant="contained"
              startIcon={bulkBusy ? <CircularProgress size={14} color="inherit" /> : <CheckCircleOutlineIcon />}
              onClick={bulkClaim}
              disabled={bulkBusy}
            >
              {t('claimSelected', { count: pendingSelectedCount })}
            </Button>
          ) : undefined
        }
        bareContent
      >
        <Stack spacing={3}>
          <SummaryStrip summary={summaryQuery.data} loading={summaryQuery.isLoading} />

          {/* Status tabs */}
          <Tabs
            value={filters.status}
            onChange={(_, value: CommissionFilters['status']) => setFilters({ status: value })}
            variant="scrollable"
            scrollButtons="auto"
            sx={{ borderBottom: (t) => `1px solid ${t.palette.divider}` }}
          >
            {COMMISSION_TABS.map((t) => (
              <Tab key={t.value} value={t.value} label={t.label} />
            ))}
          </Tabs>

          {/* Filter bar */}
          <Card variant="outlined" sx={{ p: 2 }}>
            <Stack
              direction={{ xs: 'column', md: 'row' }}
              spacing={1.5}
              alignItems={{ md: 'center' }}
              flexWrap="wrap"
            >
              {/* Filter toolbar: keep size="small" — wrap inputs in LabeledField
                  srOnly so AT users still hear the label, sighted users keep the
                  compact look. */}
              <LabeledField label={tFilters('institution')} srOnly htmlFor="commissions-filter-institution">
                <Autocomplete<InstitutionLookup>
                  id="commissions-filter-institution"
                  options={institutionsQuery.data ?? []}
                  loading={institutionsQuery.isLoading}
                  value={selectedInstitution}
                  onChange={(_, v) => setFilters({ institution_id: v?.id })}
                  onInputChange={(_, v) => setInstInput(v)}
                  getOptionLabel={(o) => o.display_name ?? o.legal_name ?? o.id}
                  isOptionEqualToValue={(a, b) => a.id === b.id}
                  size="small"
                  sx={{ minWidth: 240, flex: 1 }}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      hiddenLabel
                      placeholder={tFilters('institution')}
                      inputProps={{ ...params.inputProps, 'aria-label': tFilters('institution') }}
                    />
                  )}
                />
              </LabeledField>
              <LabeledField label={tFilters('student')} srOnly htmlFor="commissions-filter-student">
                <Autocomplete<StudentLookup>
                  id="commissions-filter-student"
                  options={studentsQuery.data ?? []}
                  loading={studentsQuery.isLoading}
                  value={selectedStudent}
                  onChange={(_, v) => setFilters({ student_id: v?.id })}
                  onInputChange={(_, v) => setStudentInput(v)}
                  getOptionLabel={(o) =>
                    `${o.given_name} ${o.family_name}`.trim() || o.student_code || o.id
                  }
                  isOptionEqualToValue={(a, b) => a.id === b.id}
                  size="small"
                  sx={{ minWidth: 240, flex: 1 }}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      hiddenLabel
                      placeholder={tFilters('student')}
                      inputProps={{ ...params.inputProps, 'aria-label': tFilters('student') }}
                    />
                  )}
                />
              </LabeledField>
              <LabeledField label={tFilters('claimedFrom')} srOnly htmlFor="commissions-filter-claimed-from">
                <TextField
                  id="commissions-filter-claimed-from"
                  hiddenLabel
                  type="date"
                  size="small"
                  value={filters.claimed_from ?? ''}
                  onChange={(e) => setFilters({ claimed_from: e.target.value || undefined })}
                  inputProps={{ 'aria-label': tFilters('claimedFrom') }}
                  sx={{ minWidth: 160 }}
                />
              </LabeledField>
              <LabeledField label={tFilters('claimedTo')} srOnly htmlFor="commissions-filter-claimed-to">
                <TextField
                  id="commissions-filter-claimed-to"
                  hiddenLabel
                  type="date"
                  size="small"
                  value={filters.claimed_to ?? ''}
                  onChange={(e) => setFilters({ claimed_to: e.target.value || undefined })}
                  inputProps={{ 'aria-label': tFilters('claimedTo') }}
                  sx={{ minWidth: 160 }}
                />
              </LabeledField>
              <LabeledField label={tFilters('paidFrom')} srOnly htmlFor="commissions-filter-paid-from">
                <TextField
                  id="commissions-filter-paid-from"
                  hiddenLabel
                  type="date"
                  size="small"
                  value={filters.paid_from ?? ''}
                  onChange={(e) => setFilters({ paid_from: e.target.value || undefined })}
                  inputProps={{ 'aria-label': tFilters('paidFrom') }}
                  sx={{ minWidth: 160 }}
                />
              </LabeledField>
              <LabeledField label={tFilters('paidTo')} srOnly htmlFor="commissions-filter-paid-to">
                <TextField
                  id="commissions-filter-paid-to"
                  hiddenLabel
                  type="date"
                  size="small"
                  value={filters.paid_to ?? ''}
                  onChange={(e) => setFilters({ paid_to: e.target.value || undefined })}
                  inputProps={{ 'aria-label': tFilters('paidTo') }}
                  sx={{ minWidth: 160 }}
                />
              </LabeledField>
              {filtersApplied ? (
                <Button
                  variant="outlined"
                  size="small"
                  onClick={() =>
                    setFilters({
                      status: 'ALL',
                      institution_id: undefined,
                      student_id: undefined,
                      enrollment_id: undefined,
                      claimed_from: undefined,
                      claimed_to: undefined,
                      paid_from: undefined,
                      paid_to: undefined,
                    })
                  }
                >
                  {tFilters('clear')}
                </Button>
              ) : null}
            </Stack>
            {filters.enrollment_id ? (
              <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                <Chip
                  size="small"
                  label={tFilters('enrolmentChip', { id: filters.enrollment_id.slice(0, 8) })}
                  onDelete={() => setFilters({ enrollment_id: undefined })}
                />
              </Stack>
            ) : null}
          </Card>

          {/* Table */}
          {listQuery.isError ? (
            <ErrorState
              title={t('couldNotLoad')}
              description={
                listQuery.error instanceof ApiError
                  ? listQuery.error.detail || listQuery.error.title
                  : t('tryAgain')
              }
              onRetry={() => listQuery.refetch()}
            />
          ) : (
            <DataTable<CommissionRow>
              columns={columns}
              rows={rows}
              loading={listQuery.isLoading}
              getRowId={(r) => r.id}
              rowCount={total}
              page={filters.page}
              pageSize={filters.limit}
              onPageChange={(p) => setFilters({ page: p })}
              onPageSizeChange={(size) => setFilters({ limit: size })}
              emptyTitle={filtersApplied ? t('noMatchesTitle') : t('noCommissionsTitle')}
              emptyDescription={
                filtersApplied
                  ? t('noMatchesDescription')
                  : t('noCommissionsDescription')
              }
            />
          )}
        </Stack>
      </ListPageShell>

      {/* Row action menu */}
      <Menu
        anchorEl={rowMenu?.anchor ?? null}
        open={Boolean(rowMenu)}
        onClose={closeMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {rowMenu?.row.status === 'PENDING' && (
          <MenuItem
            onClick={() => {
              if (rowMenu) claimMutation.mutate(rowMenu.row.id);
              closeMenu();
            }}
          >
            <ListItemIcon><CheckCircleOutlineIcon fontSize="small" /></ListItemIcon>
            {t('actions.claim')}
          </MenuItem>
        )}
        {rowMenu?.row.status === 'PENDING' && (
          <MenuItem
            onClick={() => {
              if (rowMenu) setEditTarget(rowMenu.row);
              closeMenu();
            }}
          >
            <ListItemIcon><EditOutlinedIcon fontSize="small" /></ListItemIcon>
            {t('actions.editManual')}
          </MenuItem>
        )}
        {rowMenu?.row.status === 'PENDING' && (
          <MenuItem
            onClick={() => {
              if (rowMenu) setWaiveTarget(rowMenu.row);
              closeMenu();
            }}
          >
            <ListItemIcon><BlockOutlinedIcon fontSize="small" /></ListItemIcon>
            {t('actions.waive')}
          </MenuItem>
        )}
        {rowMenu?.row.status === 'CLAIMED' && (
          <MenuItem
            onClick={() => {
              if (rowMenu) setInvoiceTarget(rowMenu.row);
              closeMenu();
            }}
          >
            <ListItemIcon><RequestQuoteOutlinedIcon fontSize="small" /></ListItemIcon>
            {t('actions.generateInvoice')}
          </MenuItem>
        )}
        {rowMenu?.row.status === 'INVOICED' && (
          <MenuItem
            onClick={() => {
              if (rowMenu) setPaidTarget(rowMenu.row);
              closeMenu();
            }}
          >
            <ListItemIcon><PaidOutlinedIcon fontSize="small" /></ListItemIcon>
            {t('actions.markPaid')}
          </MenuItem>
        )}
        {rowMenu?.row.status === 'INVOICED' && (
          <MenuItem
            onClick={() => {
              if (rowMenu) setDisputeTarget(rowMenu.row);
              closeMenu();
            }}
          >
            <ListItemIcon><GavelOutlinedIcon fontSize="small" /></ListItemIcon>
            {t('actions.raiseDispute')}
          </MenuItem>
        )}
        {rowMenu?.row.status === 'PAID' && (
          <MenuItem
            onClick={() => {
              if (rowMenu) setReceiptTarget(rowMenu.row);
              closeMenu();
            }}
          >
            <ListItemIcon><ReceiptLongOutlinedIcon fontSize="small" /></ListItemIcon>
            {t('actions.viewReceipt')}
          </MenuItem>
        )}
        {rowMenu?.row.status === 'DISPUTED' && (
          <MenuItem
            onClick={() => {
              if (rowMenu) setResolveTarget(rowMenu.row);
              closeMenu();
            }}
          >
            <ListItemIcon><ReplayOutlinedIcon fontSize="small" /></ListItemIcon>
            {t('actions.resolveBack')}
          </MenuItem>
        )}
        {rowMenu?.row.status === 'DISPUTED' && (
          <MenuItem
            onClick={() => {
              if (rowMenu) setWaiveTarget(rowMenu.row);
              closeMenu();
            }}
          >
            <ListItemIcon><BlockOutlinedIcon fontSize="small" /></ListItemIcon>
            {t('actions.waive')}
          </MenuItem>
        )}
        {/* Always-on view (read-only) */}
        <MenuItem
          onClick={() => {
            if (rowMenu) setReceiptTarget(rowMenu.row);
            closeMenu();
          }}
        >
          <ListItemIcon><VisibilityOutlinedIcon fontSize="small" /></ListItemIcon>
          {t('actions.viewDetails')}
        </MenuItem>
      </Menu>

      {/* Dialogs */}
      <InvoiceDialog
        open={Boolean(invoiceTarget)}
        claim={invoiceTarget}
        onClose={() => setInvoiceTarget(null)}
      />
      <MarkPaidDialog
        open={Boolean(paidTarget)}
        claim={paidTarget}
        onClose={() => setPaidTarget(null)}
      />
      <DisputeDialog
        open={Boolean(disputeTarget)}
        claim={disputeTarget}
        onClose={() => setDisputeTarget(null)}
      />
      <EditCommissionDialog
        open={Boolean(editTarget)}
        claim={editTarget}
        onClose={() => setEditTarget(null)}
      />
      <ReceiptDialog
        open={Boolean(receiptTarget)}
        claim={receiptTarget}
        onClose={() => setReceiptTarget(null)}
      />
      <ConfirmDialog
        open={Boolean(waiveTarget)}
        title={t('waiveTitle')}
        description={
          waiveTarget ? (
            <>
              {t('waiveDescription')}{' '}
              <strong>
                {formatMoney(toBigIntSafe(waiveTarget.amount_minor), waiveTarget.currency)}
              </strong>
              {' — '}
              {waiveTarget.institution.display_name}.
            </>
          ) : null
        }
        confirmText={t('waiveConfirm')}
        loading={waiveMutation.isPending}
        errorText={waiveMutation.error?.detail ?? null}
        onClose={() => setWaiveTarget(null)}
        onConfirm={() => {
          if (waiveTarget) waiveMutation.mutate(waiveTarget.id);
        }}
      />
      <ResolveDisputeDialog
        open={Boolean(resolveTarget)}
        claim={resolveTarget}
        onClose={() => setResolveTarget(null)}
      />
    </>
  );
}
