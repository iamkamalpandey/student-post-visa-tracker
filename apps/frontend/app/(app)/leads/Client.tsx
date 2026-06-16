'use client';

import { useMemo, useState } from 'react';
import {
  Box, Button, Chip, FormControlLabel, MenuItem, Paper, Stack, Switch, TextField, Typography,
} from '@mui/material';
import SyncOutlinedIcon from '@mui/icons-material/SyncOutlined';
import AccountBalanceOutlinedIcon from '@mui/icons-material/AccountBalanceOutlined';
import NextLink from 'next/link';
import { useSnackbar } from 'notistack';

import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ErrorState from '@/components/ErrorState';
import StatusChip from '@/components/StatusChip';
import { useAuth } from '@/lib/auth';
import { isAdmin } from '@/lib/auth-helpers';
import { useFormat } from '@/lib/format';
import {
  useApplications, useSyncLeads, useUsersLite, useLeadsFinanceSummary, useJobRuns,
  type CrmApplicationRow, type CurrencyAmount, type JobRunDto,
} from '@/lib/queries';
import { ApiError } from '@/lib/api';

const PAGE_SIZE_DEFAULT = 25;

function SyncStatusLine({ runs, pending }: { runs?: JobRunDto[]; pending: boolean }) {
  const fmt = useFormat();
  if (pending) return <Typography variant="caption" color="text.secondary">Syncing from V2…</Typography>;
  const last = runs?.[0];
  if (!last) return <Typography variant="caption" color="text.secondary">Never synced</Typography>;
  const when = last.finished_at ?? last.started_at;
  const color =
    last.status === 'SUCCEEDED' ? 'success.main'
    : last.status === 'PARTIAL' ? 'warning.main'
    : last.status === 'FAILED' ? 'error.main'
    : 'text.secondary';
  const label =
    last.status === 'SUCCEEDED' ? 'Synced'
    : last.status === 'PARTIAL' ? 'Synced (partial)'
    : last.status === 'FAILED' ? 'Sync failed'
    : last.status === 'RUNNING' ? 'Sync running'
    : last.status === 'SKIPPED_LOCKED' ? 'Sync already running'
    : last.status;
  return (
    <Typography variant="caption" sx={{ color }}>
      {label} {fmt.dateTime(when)}
      {last.status === 'SUCCEEDED' || last.status === 'PARTIAL' ? ` · ${last.rows_processed} rows` : ''}
    </Typography>
  );
}

function NextFeeChip({ row }: { row: CrmApplicationRow }) {
  const fmt = useFormat();
  const fee = row.next_fee_due;
  if (!fee) return <Typography variant="body2" color="text.secondary">—</Typography>;
  const color = fee.status === 'OVERDUE' ? 'error' : fee.status === 'DUE' ? 'warning' : 'default';
  return (
    <Chip size="small" color={color} variant={color === 'default' ? 'outlined' : 'filled'}
      label={`${fmt.date(fee.due_on)} · ${fmt.money(fee.amount_minor, fee.currency)}`} sx={{ fontWeight: 600 }} />
  );
}

export default function Client() {
  const { user } = useAuth();
  const fmt = useFormat();
  const { enqueueSnackbar } = useSnackbar();
  const admin = isAdmin(user?.role);

  const [search, setSearch] = useState('');
  const [intakeKey, setIntakeKey] = useState('');
  const [hasUpcomingFee, setHasUpcomingFee] = useState(false);
  const [assignedTo, setAssignedTo] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT);

  const usersQuery = useUsersLite(admin);

  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      intake_key: intakeKey.trim() || undefined,
      has_upcoming_fee: hasUpcomingFee || undefined,
      assigned_to_id: assignedTo || undefined,
      limit: pageSize,
      offset: page * pageSize,
    }),
    [search, intakeKey, hasUpcomingFee, assignedTo, page, pageSize],
  );

  const { data, isLoading, isError, refetch } = useApplications(filters);
  const financeQuery = useLeadsFinanceSummary();
  const syncMutation = useSyncLeads();
  const lastSyncQuery = useJobRuns('v2.ingest', {
    limit: 1,
    enabled: admin,
    refetchMs: syncMutation.isPending ? 3000 : false,
  });

  const rows = data?.data ?? [];
  const total = data?.page.total ?? 0;

  function runSync() {
    syncMutation.mutate(undefined, {
      onSuccess: (res) => {
        if (res.status === 'FAILED') enqueueSnackbar('Sync failed — check the V2 connection.', { variant: 'error' });
        else if (res.status === 'ALREADY_RUNNING') enqueueSnackbar('A sync is already running.', { variant: 'info' });
        else enqueueSnackbar(`Synced ${res.rows_processed} record(s).`, { variant: 'success' });
      },
      onError: (err) => enqueueSnackbar(err instanceof ApiError ? err.detail || err.title : 'Sync request failed', { variant: 'error' }),
      onSettled: () => void lastSyncQuery.refetch(),
    });
  }

  const columns: DataTableColumn<CrmApplicationRow>[] = [
    { key: 'applicant', label: 'Applicant', render: (r) => <Typography variant="body2" sx={{ fontWeight: 600 }}>{r.applicant_name}</Typography> },
    { key: 'course', label: 'Course', render: (r) => <Box sx={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.course_name ?? ''}>{r.course_name ?? '—'}</Box> },
    { key: 'institution', label: 'Institution', hideOnMobile: true, render: (r) => <Box sx={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.institution_name ?? ''}>{r.institution_name ?? '—'}</Box> },
    { key: 'country', label: 'Country', hideOnMobile: true, render: (r) => r.country_name ?? '—' },
    { key: 'intake', label: 'Intake', hideOnMobile: true, render: (r) => r.intake_key },
    // Stage column dropped: every row in this visa-accepted-only list is "Visa
    // Accepted" → redundant. Space reclaimed for Next-fee + Status.
    { key: 'nextFee', label: 'Next fee due', render: (r) => <NextFeeChip row={r} /> },
    { key: 'status', label: 'Status', hideOnMobile: true, render: (r) => <StatusChip status={r.spv_status} /> },
  ];

  return (
    <Stack spacing={2.5}>
      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ xs: 'flex-start', sm: 'center' }} spacing={1.5}>
        <Box>
          <Typography variant="h5" sx={{ fontWeight: 700 }}>Applications</Typography>
          <Typography variant="body2" color="text.secondary">
            Visa-accepted applications — your post-visa work queue. One row per application; click to open the applicant.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1.5} alignItems="flex-start">
          <Button variant="outlined" component={NextLink} href="/leads/institutions" startIcon={<AccountBalanceOutlinedIcon />}>
            CRM catalog
          </Button>
          {admin ? (
            <Stack spacing={0.5} alignItems="flex-end">
              <Button variant="contained" startIcon={<SyncOutlinedIcon />} onClick={runSync} disabled={syncMutation.isPending}>
                {syncMutation.isPending ? 'Syncing…' : 'Sync from V2'}
              </Button>
              <SyncStatusLine runs={lastSyncQuery.data} pending={syncMutation.isPending} />
            </Stack>
          ) : null}
        </Stack>
      </Stack>

      {(() => {
        const s = financeQuery.data;
        if (!s) return null;
        const group = (label: string, items: CurrencyAmount[], color: 'warning' | 'success' | 'default') => (
          <Stack spacing={0.5} sx={{ minWidth: 180 }}>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</Typography>
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {items.length === 0
                ? <Typography variant="body2" color="text.secondary">—</Typography>
                : items.map((c) => <Chip key={c.currency} size="small" color={color} variant={color === 'default' ? 'outlined' : 'filled'} label={fmt.money(c.amount_minor, c.currency)} sx={{ fontWeight: 700 }} />)}
            </Stack>
          </Stack>
        );
        return (
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={3} flexWrap="wrap" useFlexGap>
              {group('Outstanding fees', s.outstanding, 'warning')}
              {group('Collected (fees paid)', s.collected, 'success')}
              {group('Payments — V2 historical', s.payments, 'default')}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
              Per currency, never combined. Outstanding/Collected are SPVT fees; payments are V2&apos;s record (not netted). {s.lead_count} lead(s).
            </Typography>
          </Paper>
        );
      })()}

      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
          <TextField size="small" label="Search" placeholder="Applicant, phone, email" value={search} onChange={(e) => { setPage(0); setSearch(e.target.value); }} sx={{ minWidth: 200 }} />
          <TextField size="small" label="Intake" placeholder="e.g. 2026" value={intakeKey} onChange={(e) => { setPage(0); setIntakeKey(e.target.value); }} sx={{ minWidth: 130 }} />
          {admin ? (
            <TextField size="small" select label="Assigned to" value={assignedTo} onChange={(e) => { setPage(0); setAssignedTo(e.target.value); }} sx={{ minWidth: 160 }}>
              <MenuItem value="">Anyone</MenuItem>
              {(usersQuery.data ?? []).map((u) => <MenuItem key={u.id} value={u.id}>{u.display_name || `${u.given_name} ${u.family_name}`.trim() || u.id}</MenuItem>)}
            </TextField>
          ) : null}
          <FormControlLabel control={<Switch checked={hasUpcomingFee} onChange={(e) => { setPage(0); setHasUpcomingFee(e.target.checked); }} />} label="Has upcoming fee" />
        </Stack>
      </Paper>

      {isError ? (
        <ErrorState onRetry={() => void refetch()} />
      ) : (
        <>
          <DataTable<CrmApplicationRow>
            columns={columns}
            rows={rows}
            rowCount={total}
            loading={isLoading}
            getRowId={(r) => r.id}
            onRowClick={(r) => `/leads/${r.lead_id}`}
            page={page}
            pageSize={pageSize}
            onPageChange={setPage}
            onPageSizeChange={(s) => { setPageSize(s); setPage(0); }}
            emptyTitle="No applications"
            emptyDescription="Run “Sync from V2” to mirror visa-accepted leads + their applications."
            ariaLabel="Applications pipeline"
          />
        </>
      )}
    </Stack>
  );
}
