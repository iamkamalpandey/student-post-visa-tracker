'use client';

import { Fragment, useId, useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Collapse,
  IconButton,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';
import PolicyOutlinedIcon from '@mui/icons-material/PolicyOutlined';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import KeyboardArrowRightIcon from '@mui/icons-material/KeyboardArrowRight';
import LinkOffOutlinedIcon from '@mui/icons-material/LinkOffOutlined';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import { useSnackbar } from 'notistack';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import ListPageShell from '@/components/ListPageShell';

// SVT-WAVE60-AUDIT-FE-2026-05 — full tenant-admin audit-log surface.
// Backend: GET /api/v1/audit-logs (cursor seek, filters), /audit-logs/verify
// (per-tenant hash-chain recompute). before_enc / after_enc stay envelope-
// encrypted in the DB and are NOT exposed by the read API, so the per-row
// expander only shows metadata + the hash trio that proves chain integrity.

type AuditRow = {
  id: string;
  tenant_id: string | null;
  actor_id: string | null;
  actor_email_hash: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  entity_version: number | null;
  ip_hash: string | null;
  ua_hash: string | null;
  request_id: string | null;
  prev_hash: string | null;
  entry_hash: string;
  created_at: string;
};

type ListResponse = {
  data: AuditRow[];
  page: { next_cursor: string | null; total?: number };
};

type VerifyResult = { tenant_id: string; broken_count: number; broken_ids: string[] };

// SVT-WAVE59-AUDIT-PREFIX-2026-05 — common action prefixes admins want to
// triage by. 'all' means no filter; the rest map to backend `action=<x>*`
// wildcards which `service.list` translates to a `startsWith` predicate.
const ACTION_FAMILIES: Array<{ label: string; value: string }> = [
  { label: 'All actions', value: 'all' },
  { label: 'Auth (auth.*)', value: 'auth.*' },
  { label: 'Student (student.*)', value: 'student.*' },
  { label: 'Stage (stage.*)', value: 'stage.*' },
  { label: 'Comms (comms.*)', value: 'comms.*' },
  { label: 'Commission (commission.*)', value: 'commission.*' },
  { label: 'Payment (payment.*)', value: 'payment.*' },
  { label: 'Reminder (reminder.*)', value: 'reminder.*' },
  { label: 'Breach (breach.*)', value: 'breach.*' },
  { label: 'DSAR (dsar.*)', value: 'dsar.*' },
  { label: 'Consent (consent.*)', value: 'consent.*' },
  { label: 'Tenant (tenant.*)', value: 'tenant.*' },
  { label: 'Custom prefix…', value: '__custom__' },
];

const PAGE_SIZE = 25;

const VERIFY_SQL = `-- Run as DB superuser inside psql to verify the audit chain for a tenant:
SELECT * FROM audit_logs_verify('00000000-0000-0000-0000-000000000000'::uuid);
-- Returns one row per gap or hash mismatch; an empty result set means the chain is intact.`;

// UUID v4-ish loose pattern — accepts any 8-4-4-4-12 hex string. We don't
// reject lower/upper case; the backend canonicalises.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shortHash(h: string | null | undefined, n = 12): string {
  if (!h) return '—';
  return h.length > n ? `${h.slice(0, n)}…` : h;
}

function shortId(id: string | null | undefined, n = 8): string {
  if (!id) return '—';
  return id.length > n ? `${id.slice(0, n)}…` : id;
}

// Filter state ---------------------------------------------------------------

type Filters = {
  actorId: string;
  entityType: string;
  actionFamily: string; // value from ACTION_FAMILIES or '__custom__'
  actionCustom: string; // free-text prefix (with optional trailing *)
  requestId: string;
  from: string; // datetime-local string
  to: string; // datetime-local string
};

const EMPTY_FILTERS: Filters = {
  actorId: '',
  entityType: '',
  actionFamily: 'all',
  actionCustom: '',
  requestId: '',
  from: '',
  to: '',
};

// datetime-local → ISO. Browser supplies "2026-05-19T09:30" in local TZ;
// new Date(s) parses that as local and toISOString() converts to UTC.
function localToIso(s: string): string | null {
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// Build the params we send to /audit-logs. Drops empties; validates the
// actor UUID locally so we don't waste a round-trip on a 400.
function buildParams(f: Filters, cursor: string | null): Record<string, string | number> {
  const p: Record<string, string | number> = { limit: PAGE_SIZE };
  if (cursor) p['cursor'] = cursor;

  if (f.actorId.trim() && UUID_RE.test(f.actorId.trim())) {
    p['actor_id'] = f.actorId.trim();
  }
  if (f.entityType.trim()) p['entity_type'] = f.entityType.trim();

  // Action: prefer custom prefix when picked; otherwise the family selector.
  const actionRaw =
    f.actionFamily === '__custom__'
      ? f.actionCustom.trim()
      : f.actionFamily === 'all'
        ? ''
        : f.actionFamily;
  if (actionRaw) p['action'] = actionRaw;

  // Request ID: backend doesn't filter on this server-side (no column in the
  // public schema), so we do exact match client-side after fetch. Keep it in
  // filter state so the bar reflects intent; do NOT send to the API.

  const fromIso = localToIso(f.from);
  const toIso = localToIso(f.to);
  if (fromIso) p['from'] = fromIso;
  if (toIso) p['to'] = toIso;

  return p;
}

export default function AuditPage() {
  const { user } = useAuth();
  const fmt = useFormat();
  const { enqueueSnackbar } = useSnackbar();

  const isAdmin = user?.role === 'ADMIN';

  // SVT-WAVE45-AUDIT-VERIFY-2026-05 — GET /api/v1/audit-logs/verify recomputes
  // the per-tenant hash chain via the audit_logs_verify(tenant) SQL function
  // and returns { broken_count, broken_ids }. Loud success/failure toasts so
  // an admin can spot tampering or DB drift immediately.
  const verifyMut = useMutation({
    mutationFn: async () => {
      const res = await api.get<{ data: VerifyResult }>('/audit-logs/verify');
      return res.data.data;
    },
    onSuccess: (data) => {
      if (data.broken_count === 0) {
        enqueueSnackbar('Audit chain intact — no broken rows.', {
          variant: 'success',
          autoHideDuration: 6000,
        });
      } else {
        enqueueSnackbar(
          `Audit chain broken: ${data.broken_count} row${data.broken_count === 1 ? '' : 's'} (${data.broken_ids.slice(0, 3).join(', ')}${data.broken_count > 3 ? '…' : ''}). Escalate immediately.`,
          { variant: 'error', persist: true },
        );
      }
    },
    onError: (err: unknown) => {
      const msg = err instanceof ApiError ? err.detail || err.title : 'Could not verify the chain';
      enqueueSnackbar(msg, { variant: 'error' });
    },
  });
  const handleVerifyChain = () => verifyMut.mutate();

  // Hooks must run unconditionally — the admin gate below is an early return,
  // so this useMemo has to live above it. The conditional bit moves inside the
  // factory: if we're not admin we never render the table, so the value is
  // unused, but we still compute a (cheap) empty set to keep the hook stable.
  const brokenSet = useMemo(
    () => new Set(isAdmin ? verifyMut.data?.broken_ids ?? [] : []),
    [verifyMut.data, isAdmin],
  );

  if (!isAdmin) {
    return (
      <Stack spacing={3}>
        <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
          Audit log
        </Typography>
        <Alert severity="warning">
          You need the ADMIN role to view the audit log.
        </Alert>
      </Stack>
    );
  }

  return (
    <ListPageShell
      title="Audit log"
      description="Append-only history with a SHA-256 hash chain. Every privileged action is recorded under GDPR Art. 5(2) accountability."
      action={
        <Stack direction="row" spacing={1.5} alignItems="center">
          {/* SVT-WAVE55-VERIFY-CHIP-2026-05 — keep the latest result visible
              next to the trigger so an admin doesn't have to chase the
              transient toast to know the chain status. aria-live so screen
              readers announce the outcome; assertive when broken because
              tampering is a Sev1 event by definition. */}
          <Box
            role="status"
            aria-live={
              verifyMut.data && verifyMut.data.broken_count > 0 ? 'assertive' : 'polite'
            }
            sx={{ display: 'inline-flex' }}
          >
            {verifyMut.data ? (
              <Chip
                size="small"
                color={verifyMut.data.broken_count === 0 ? 'success' : 'error'}
                variant="outlined"
                icon={
                  verifyMut.data.broken_count === 0 ? (
                    <LinkOutlinedIcon />
                  ) : (
                    <LinkOffOutlinedIcon />
                  )
                }
                label={
                  verifyMut.data.broken_count === 0
                    ? 'Chain intact'
                    : `${verifyMut.data.broken_count} broken`
                }
              />
            ) : null}
          </Box>
          <Button
            variant="outlined"
            startIcon={
              verifyMut.isPending ? <CircularProgress size={16} /> : <VerifiedUserOutlinedIcon />
            }
            onClick={handleVerifyChain}
            disabled={verifyMut.isPending}
          >
            {verifyMut.isPending ? 'Verifying…' : 'Verify chain'}
          </Button>
        </Stack>
      }
      bareContent
    >
      <Stack spacing={3}>
        <VerifierCard />
        <AuditLogTable brokenSet={brokenSet} fmt={fmt} />
      </Stack>
    </ListPageShell>
  );
}

function VerifierCard() {
  return (
    <Card variant="outlined">
      <CardContent>
        <Stack direction="row" spacing={1.5} alignItems="flex-start">
          <PolicyOutlinedIcon color="primary" />
          <Stack spacing={1}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Verifier
            </Typography>
            <Typography variant="body2" color="text.secondary">
              The audit log is append-only and every row carries a SHA-256 hash of itself
              plus the hash of the previous row. The Verify chain button calls{' '}
              <Box component="code" sx={{ mx: 0.5, fontFamily: 'monospace' }}>
                GET /api/v1/audit-logs/verify
              </Box>
              which runs the per-tenant chain verifier. Any broken rows are highlighted
              red in the table below. The equivalent SQL (run as DB superuser) is:
            </Typography>
            <Paper
              variant="outlined"
              sx={{
                bgcolor: 'action.hover',
                p: 1.5,
                borderRadius: 1,
                fontFamily: 'monospace',
                fontSize: 12,
                whiteSpace: 'pre-wrap',
              }}
            >
              {VERIFY_SQL}
            </Paper>
          </Stack>
        </Stack>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

type BoundFormat = ReturnType<typeof useFormat>;

function AuditLogTable({
  brokenSet,
  fmt,
}: {
  brokenSet: Set<string>;
  fmt: BoundFormat;
}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  // Cursor stack for back-paging: each entry is the cursor that was used to
  // fetch the current page (null = first page). We push the next_cursor on
  // "Next" and pop on "Previous". Resetting filters clears the stack.
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([null]);
  const currentCursor = cursorStack[cursorStack.length - 1] ?? null;

  const actorId = useId();
  const entityType = useId();
  const actionFamily = useId();
  const actionCustom = useId();
  const requestId = useId();
  const fromId = useId();
  const toId = useId();

  // Local-side validation flag so we can colour the actor input red without
  // failing the request.
  const actorTrim = filters.actorId.trim();
  const actorInvalid = actorTrim.length > 0 && !UUID_RE.test(actorTrim);

  const params = useMemo(() => buildParams(filters, currentCursor), [filters, currentCursor]);

  const listQ = useQuery<ListResponse>({
    queryKey: ['audit-logs', params],
    queryFn: async () => {
      const res = await api.get<ListResponse>('/audit-logs', { params });
      return res.data;
    },
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });

  const rawRows = listQ.data?.data ?? [];
  // Request ID filter is applied client-side — backend has no column for it
  // in the public schema today. Cheap enough for one page (PAGE_SIZE=25).
  const requestIdTrim = filters.requestId.trim().toLowerCase();
  const rows = useMemo(() => {
    if (!requestIdTrim) return rawRows;
    return rawRows.filter((r) =>
      (r.request_id ?? '').toLowerCase().includes(requestIdTrim),
    );
  }, [rawRows, requestIdTrim]);

  const total = listQ.data?.page?.total;
  const nextCursor = listQ.data?.page?.next_cursor ?? null;
  const hasNext = Boolean(nextCursor);
  const hasPrev = cursorStack.length > 1;
  const pageIndex = cursorStack.length - 1; // 0-based

  function resetCursor() {
    setCursorStack([null]);
  }

  function updateFilters(patch: Partial<Filters>) {
    setFilters((f) => ({ ...f, ...patch }));
    resetCursor();
  }

  function clearFilters() {
    setFilters(EMPTY_FILTERS);
    resetCursor();
  }

  function goNext() {
    if (nextCursor) setCursorStack((s) => [...s, nextCursor]);
  }

  function goPrev() {
    if (cursorStack.length > 1) setCursorStack((s) => s.slice(0, -1));
  }

  const filtersApplied =
    filters.actorId.trim() !== '' ||
    filters.entityType.trim() !== '' ||
    (filters.actionFamily !== 'all' &&
      (filters.actionFamily !== '__custom__' || filters.actionCustom.trim() !== '')) ||
    filters.requestId.trim() !== '' ||
    filters.from !== '' ||
    filters.to !== '';

  return (
    <Card variant="outlined">
      <CardContent>
        <Stack
          direction={{ xs: 'column', sm: 'row' }}
          justifyContent="space-between"
          alignItems={{ xs: 'flex-start', sm: 'center' }}
          spacing={1.5}
          sx={{ mb: 2 }}
        >
          <Stack spacing={0.5}>
            <Typography variant="h6" sx={{ fontWeight: 600 }}>
              Audit log entries
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Actor email / IP / UA are HMAC-hashed at write time — they cannot be
              reversed from this read. Encrypted before/after bodies stay in the DB.
            </Typography>
          </Stack>
          <Stack direction="row" spacing={1} alignItems="center">
            {typeof total === 'number' ? (
              <Chip
                size="small"
                variant="outlined"
                label={`${total.toLocaleString()} total`}
              />
            ) : null}
            <Tooltip title="Refresh">
              <span>
                <IconButton
                  aria-label="Refresh audit log"
                  onClick={() => void listQ.refetch()}
                  disabled={listQ.isFetching}
                  size="small"
                >
                  <RefreshOutlinedIcon fontSize="small" />
                </IconButton>
              </span>
            </Tooltip>
            {listQ.isFetching ? <CircularProgress size={16} /> : null}
          </Stack>
        </Stack>

        {/* Filter bar */}
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2 }}>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={1.5}
            alignItems={{ md: 'center' }}
            flexWrap="wrap"
            useFlexGap
          >
            <TextField
              id={actorId}
              label="Actor ID (UUID)"
              size="small"
              value={filters.actorId}
              onChange={(e) => updateFilters({ actorId: e.target.value })}
              error={actorInvalid}
              helperText={actorInvalid ? 'Must be a UUID' : ' '}
              sx={{ minWidth: 280, '& .MuiFormHelperText-root': { mx: 0 } }}
            />
            <TextField
              id={entityType}
              label="Entity type"
              size="small"
              placeholder="e.g. student, payment"
              value={filters.entityType}
              onChange={(e) => updateFilters({ entityType: e.target.value })}
              sx={{ minWidth: 200 }}
            />
            <TextField
              id={actionFamily}
              select
              label="Action"
              size="small"
              value={filters.actionFamily}
              onChange={(e) => updateFilters({ actionFamily: e.target.value })}
              sx={{ minWidth: 220 }}
            >
              {ACTION_FAMILIES.map((opt) => (
                <MenuItem key={opt.value} value={opt.value}>
                  {opt.label}
                </MenuItem>
              ))}
            </TextField>
            {filters.actionFamily === '__custom__' ? (
              <TextField
                id={actionCustom}
                label="Action prefix"
                size="small"
                placeholder="e.g. payment.refund or auth.*"
                value={filters.actionCustom}
                onChange={(e) => updateFilters({ actionCustom: e.target.value })}
                sx={{ minWidth: 240 }}
              />
            ) : null}
            <TextField
              id={requestId}
              label="Request ID"
              size="small"
              placeholder="contains…"
              value={filters.requestId}
              onChange={(e) => setFilters((f) => ({ ...f, requestId: e.target.value }))}
              helperText="Filtered on this page only"
              sx={{ minWidth: 220, '& .MuiFormHelperText-root': { mx: 0 } }}
            />
            <TextField
              id={fromId}
              label="From"
              type="datetime-local"
              size="small"
              value={filters.from}
              onChange={(e) => updateFilters({ from: e.target.value })}
              InputLabelProps={{ shrink: true }}
              sx={{ minWidth: 220 }}
            />
            <TextField
              id={toId}
              label="To"
              type="datetime-local"
              size="small"
              value={filters.to}
              onChange={(e) => updateFilters({ to: e.target.value })}
              InputLabelProps={{ shrink: true }}
              sx={{ minWidth: 220 }}
            />
            {filtersApplied ? (
              <Button size="small" variant="text" onClick={clearFilters}>
                Reset
              </Button>
            ) : null}
          </Stack>
        </Paper>

        {listQ.isLoading ? (
          <Box sx={{ display: 'flex', justifyContent: 'center', py: 4 }}>
            <CircularProgress />
          </Box>
        ) : listQ.isError ? (
          <ErrorState
            title="Could not load audit log"
            description={
              listQ.error instanceof ApiError
                ? listQ.error.detail || listQ.error.title
                : 'Unexpected error'
            }
            onRetry={() => listQ.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title={filtersApplied ? 'No matches' : 'No audit entries yet'}
            description={
              filtersApplied
                ? 'Try widening the date range or clearing filters.'
                : 'Actions across the workspace will appear here as they happen.'
            }
            actions={
              filtersApplied ? (
                <Button onClick={clearFilters}>Clear filters</Button>
              ) : undefined
            }
          />
        ) : (
          <>
            <TableContainer component={Paper} variant="outlined">
              <Table size="small" aria-label="Audit log entries">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ width: 36 }} aria-label="Expand" />
                    <TableCell>When</TableCell>
                    <TableCell>Actor</TableCell>
                    <TableCell>Action</TableCell>
                    <TableCell>Entity</TableCell>
                    <TableCell>Request ID</TableCell>
                    <TableCell>IP hash</TableCell>
                    <TableCell>Chain</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((r) => (
                    <AuditRowView
                      key={r.id}
                      row={r}
                      broken={brokenSet.has(r.id)}
                      fmt={fmt}
                    />
                  ))}
                </TableBody>
              </Table>
            </TableContainer>

            <Stack
              direction={{ xs: 'column', sm: 'row' }}
              spacing={1}
              alignItems={{ sm: 'center' }}
              justifyContent="space-between"
              sx={{ mt: 1.5 }}
            >
              <Typography variant="caption" color="text.secondary">
                Page {pageIndex + 1}
                {typeof total === 'number'
                  ? ` of ~${Math.max(1, Math.ceil(total / PAGE_SIZE))}`
                  : ''}{' '}
                · showing {rows.length} row{rows.length === 1 ? '' : 's'}
                {requestIdTrim ? ' (filtered by request ID on this page)' : ''}
              </Typography>
              <Stack direction="row" spacing={1}>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={goPrev}
                  disabled={!hasPrev || listQ.isFetching}
                >
                  Previous
                </Button>
                <Button
                  size="small"
                  variant="outlined"
                  onClick={goNext}
                  disabled={!hasNext || listQ.isFetching}
                >
                  Next
                </Button>
              </Stack>
            </Stack>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Row + expander
// ---------------------------------------------------------------------------

function AuditRowView({
  row,
  broken,
  fmt,
}: {
  row: AuditRow;
  // True when the chain verifier flagged this specific row. The top-of-page
  // chip carries the overall "intact / N broken" verdict; per-row we only
  // show a BROKEN badge so untouched rows stay visually quiet.
  broken: boolean;
  fmt: BoundFormat;
}) {
  const [open, setOpen] = useState(false);
  const chainCell = broken ? (
    <Chip
      size="small"
      color="error"
      variant="filled"
      icon={<LinkOffOutlinedIcon />}
      label="Broken"
      sx={{ fontWeight: 600 }}
    />
  ) : (
    <Typography variant="caption" color="text.secondary">
      —
    </Typography>
  );

  return (
    <Fragment>
      <TableRow
        hover
        sx={{
          '& > *': { borderBottom: 'unset' },
          bgcolor: broken ? 'error.lighter' : undefined,
        }}
      >
        <TableCell>
          <IconButton
            size="small"
            aria-label={open ? 'Collapse row' : 'Expand row'}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? (
              <KeyboardArrowDownIcon fontSize="small" />
            ) : (
              <KeyboardArrowRightIcon fontSize="small" />
            )}
          </IconButton>
        </TableCell>
        <TableCell>
          <Tooltip title={`${fmt.dateTime(row.created_at)} (${row.created_at})`}>
            <Typography component="span" variant="body2">
              {fmt.relative(row.created_at)}
            </Typography>
          </Tooltip>
        </TableCell>
        <TableCell>
          <Stack spacing={0.25}>
            <Typography
              variant="caption"
              sx={{ fontFamily: 'monospace', fontSize: 12 }}
            >
              {row.actor_id ? shortId(row.actor_id) : 'system'}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {row.actor_email_hash
                ? `email#${shortHash(row.actor_email_hash, 8)}`
                : '—'}
            </Typography>
          </Stack>
        </TableCell>
        <TableCell>
          <Chip
            size="small"
            label={row.action}
            variant="outlined"
            sx={{ fontFamily: 'monospace', fontSize: 11 }}
          />
        </TableCell>
        <TableCell>
          <Typography variant="caption" sx={{ fontFamily: 'monospace' }}>
            {row.entity_type}
            {row.entity_id ? ` · ${shortId(row.entity_id)}` : ''}
            {row.entity_version != null ? ` v${row.entity_version}` : ''}
          </Typography>
        </TableCell>
        <TableCell
          sx={{ fontFamily: 'monospace', fontSize: 11, color: 'text.secondary' }}
        >
          {row.request_id ? (
            <Tooltip title={row.request_id}>
              <span>{shortId(row.request_id)}</span>
            </Tooltip>
          ) : (
            '—'
          )}
        </TableCell>
        <TableCell
          sx={{ fontFamily: 'monospace', fontSize: 11, color: 'text.secondary' }}
        >
          {row.ip_hash ? (
            <Tooltip title={row.ip_hash}>
              <span>{shortHash(row.ip_hash, 10)}</span>
            </Tooltip>
          ) : (
            '—'
          )}
        </TableCell>
        <TableCell>{chainCell}</TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={8} sx={{ py: 0, borderBottom: open ? undefined : 'none' }}>
          <Collapse in={open} timeout="auto" unmountOnExit>
            <Box sx={{ py: 2, px: 1 }}>
              <Stack spacing={1.5}>
                <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                  Entry details
                </Typography>
                <Box
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: {
                      xs: '1fr',
                      md: '160px 1fr',
                    },
                    columnGap: 2,
                    rowGap: 0.75,
                    fontSize: 13,
                  }}
                >
                  <KV label="ID" value={row.id} mono />
                  <KV label="Tenant" value={row.tenant_id ?? '—'} mono />
                  <KV
                    label="Created at"
                    value={`${fmt.dateTime(row.created_at)} · ${row.created_at}`}
                  />
                  <KV label="Actor ID" value={row.actor_id ?? 'system'} mono />
                  <KV label="Actor email hash" value={row.actor_email_hash ?? '—'} mono />
                  <KV label="IP hash" value={row.ip_hash ?? '—'} mono />
                  <KV label="UA hash" value={row.ua_hash ?? '—'} mono />
                  <KV label="Request ID" value={row.request_id ?? '—'} mono />
                  <KV label="Action" value={row.action} mono />
                  <KV
                    label="Entity"
                    value={`${row.entity_type}${row.entity_id ? ` · ${row.entity_id}` : ''}${row.entity_version != null ? ` (v${row.entity_version})` : ''}`}
                    mono
                  />
                  <KV label="Prev hash" value={row.prev_hash ?? '—'} mono wrap />
                  <KV label="Entry hash" value={row.entry_hash} mono wrap />
                </Box>
                <Alert
                  severity={broken ? 'error' : 'info'}
                  variant="outlined"
                  icon={broken ? <LinkOffOutlinedIcon /> : <LinkOutlinedIcon />}
                >
                  {broken
                    ? 'This row was flagged by the chain verifier — entry_hash does not match sha256(prev_hash || canonical_payload). Escalate immediately.'
                    : 'before / after bodies are envelope-encrypted in the DB and intentionally not exposed by this endpoint. Use psql with a step-up role to inspect.'}
                </Alert>
              </Stack>
            </Box>
          </Collapse>
        </TableCell>
      </TableRow>
    </Fragment>
  );
}

function KV({
  label,
  value,
  mono = false,
  wrap = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  wrap?: boolean;
}) {
  return (
    <>
      <Typography variant="caption" color="text.secondary" sx={{ pt: 0.25 }}>
        {label}
      </Typography>
      <Typography
        variant="body2"
        sx={{
          fontFamily: mono ? 'monospace' : undefined,
          fontSize: mono ? 12 : undefined,
          wordBreak: wrap ? 'break-all' : undefined,
        }}
      >
        {value}
      </Typography>
    </>
  );
}
