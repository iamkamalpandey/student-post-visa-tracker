// Refactored to SVT form-pattern
// Lifted from app/(app)/expiries/Client.tsx — page-level header dropped;
// all filters, kind chips, query keys (`['expiries', { withinDays }]`) and
// columns preserved verbatim so the existing TanStack cache + tests keep
// working through the consolidation.
//
// Filter toolbar inputs are wrapped in <LabeledField srOnly htmlFor> so the
// visually-hidden label stays in the AT tree while the inputs keep their
// compact `size="small"` look.

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import {
  Box,
  Chip,
  CircularProgress,
  IconButton,
  InputAdornment,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import EventBusyOutlinedIcon from '@mui/icons-material/EventBusyOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import ClearOutlinedIcon from '@mui/icons-material/ClearOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';

import DataTable, { type DataTableColumn } from '@/components/DataTable';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import ErrorState from '@/components/ErrorState';
import EmptyState from '@/components/EmptyState';
import LabeledField from '@/components/LabeledField';
import { api, ApiError } from '@/lib/api';
import { useFormat } from '@/lib/format';

type ExpiryKind = 'visa' | 'passport' | 'insurance' | 'document' | 'regulator_id';
type Severity = 'overdue' | 'critical' | 'warning' | 'ok';

type ExpiryRow = {
  id: string;
  kind: ExpiryKind;
  student_id: string;
  student_name: string;
  expires_on: string;
  days_remaining: number;
  severity: Severity;
  source_table: string;
};

type ExpiryListResponse = { data: ExpiryRow[] };

const KIND_OPTIONS: { value: ExpiryKind; label: string }[] = [
  { value: 'visa', label: 'Visa' },
  { value: 'passport', label: 'Passport' },
  { value: 'insurance', label: 'Insurance' },
  { value: 'document', label: 'Document' },
  { value: 'regulator_id', label: 'Regulator ID' },
];

const WITHIN_OPTIONS = [15, 30, 60, 90] as const;

const SEVERITY_COLOURS: Record<Severity, { bg: string; fg: string; label: string }> = {
  overdue: { bg: '#FFEBEE', fg: '#B71C1C', label: 'Overdue' },
  critical: { bg: '#FFE0B2', fg: '#B65000', label: 'Critical' },
  warning: { bg: '#FFF8E1', fg: '#8D6E00', label: 'Warning' },
  ok: { bg: '#E8F5E9', fg: '#2E7D32', label: 'OK' },
};

const KIND_COLOURS: Record<ExpiryKind, { bg: string; fg: string }> = {
  visa: { bg: '#E3F2FD', fg: '#0D47A1' },
  passport: { bg: '#EDE7F6', fg: '#4527A0' },
  insurance: { bg: '#FFF3E0', fg: '#E65100' },
  document: { bg: '#F1F8E9', fg: '#33691E' },
  regulator_id: { bg: '#FCE4EC', fg: '#AD1457' },
};

function useDebounced<T>(value: T, delay = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}

function KindChip({ kind }: { kind: ExpiryKind }) {
  const c = KIND_COLOURS[kind];
  const opt = KIND_OPTIONS.find((o) => o.value === kind);
  return (
    <Chip
      size="small"
      label={opt?.label ?? kind}
      sx={{ bgcolor: c.bg, color: c.fg, fontWeight: 600, border: 'none' }}
    />
  );
}

function DaysBadge({ days, severity }: { days: number; severity: Severity }) {
  const c = SEVERITY_COLOURS[severity];
  const label =
    days === 0
      ? 'Today'
      : days < 0
        ? `${Math.abs(days)}d overdue`
        : `${days}d left`;
  return (
    <Chip
      size="small"
      label={label}
      sx={{ bgcolor: c.bg, color: c.fg, fontWeight: 600, border: 'none' }}
    />
  );
}

export default function ExpiriesTab() {
  const t = useTranslations('expiries');
  const tCommon = useTranslations('common');
  const fmt = useFormat();

  const [q, setQ] = useState('');
  const [withinDays, setWithinDays] = useState<number>(60);
  const [kinds, setKinds] = useState<ExpiryKind[]>([]);
  const debouncedQ = useDebounced(q, 250);

  const listQuery = useQuery<ExpiryListResponse>({
    queryKey: ['expiries', { withinDays }],
    queryFn: async () => {
      const res = await api.get('/expiries', { params: { within_days: withinDays } });
      return res.data as ExpiryListResponse;
    },
    placeholderData: (prev) => prev,
  });

  const allRows = listQuery.data?.data ?? [];

  const rows = useMemo(() => {
    let out = allRows;
    if (kinds.length > 0) {
      out = out.filter((r) => kinds.includes(r.kind));
    }
    if (debouncedQ) {
      const needle = debouncedQ.toLowerCase();
      out = out.filter((r) => r.student_name.toLowerCase().includes(needle));
    }
    return out;
  }, [allRows, kinds, debouncedQ]);

  const hasFilter = kinds.length > 0 || debouncedQ.length > 0 || withinDays !== 60;

  function resetFilters() {
    setQ('');
    setKinds([]);
    setWithinDays(60);
  }

  function toggleKind(k: ExpiryKind) {
    setKinds((cur) =>
      cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k],
    );
  }

  const filters = (
    <Stack
      direction={{ xs: 'column', md: 'row' }}
      spacing={1.5}
      alignItems={{ xs: 'stretch', md: 'center' }}
      flexWrap="wrap"
      useFlexGap
    >
      <LabeledField label={t('searchPlaceholder')} srOnly htmlFor="expiries-filter-search">
        <TextField
          id="expiries-filter-search"
          size="small"
          hiddenLabel
          placeholder={t('searchPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          sx={{ flexGrow: 1, minWidth: 220, width: '100%' }}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchOutlinedIcon fontSize="small" />
              </InputAdornment>
            ),
            endAdornment: q ? (
              <InputAdornment position="end">
                <IconButton
                  size="small"
                  aria-label={tCommon('clear')}
                  onClick={() => setQ('')}
                >
                  <ClearOutlinedIcon fontSize="small" />
                </IconButton>
              </InputAdornment>
            ) : undefined,
          }}
        />
      </LabeledField>
      <LabeledField label={t('withinLabel')} srOnly htmlFor="expiries-filter-within">
        <TextField
          id="expiries-filter-within"
          size="small"
          select
          hiddenLabel
          value={withinDays}
          onChange={(e) => setWithinDays(Number(e.target.value))}
          sx={{ minWidth: 140 }}
        >
          {WITHIN_OPTIONS.map((d) => (
            <MenuItem key={d} value={d}>
              {t('withinOption', { days: d })}
            </MenuItem>
          ))}
        </TextField>
      </LabeledField>
      {/* Multi-select kind chips — group is exposed as a labelled toolbar
          region so AT users hear "Kinds, toolbar" when they tab into it. */}
      <Box
        role="group"
        aria-label={t('columns.kind')}
        sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}
      >
        {KIND_OPTIONS.map((o) => {
          const active = kinds.includes(o.value);
          const c = KIND_COLOURS[o.value];
          return (
            <Chip
              key={o.value}
              size="small"
              label={o.label}
              clickable
              aria-pressed={active}
              onClick={() => toggleKind(o.value)}
              sx={{
                bgcolor: active ? c.bg : 'transparent',
                color: active ? c.fg : 'text.secondary',
                fontWeight: 600,
                border: (theme) => `1px solid ${active ? c.fg : theme.palette.divider}`,
              }}
            />
          );
        })}
      </Box>
      {hasFilter ? (
        <IconButton size="small" aria-label={tCommon('reset')} onClick={resetFilters}>
          <ClearOutlinedIcon fontSize="small" />
        </IconButton>
      ) : null}
      <Tooltip title={tCommon('refresh')}>
        <span>
          <IconButton
            size="small"
            aria-label={tCommon('refresh')}
            onClick={() => listQuery.refetch()}
            disabled={listQuery.isFetching}
          >
            {listQuery.isFetching ? (
              <CircularProgress size={18} />
            ) : (
              <RefreshOutlinedIcon fontSize="small" />
            )}
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  );

  const columns: DataTableColumn<ExpiryRow>[] = [
    {
      key: 'student',
      label: t('columns.student'),
      render: (r) => (
        <Link
          href={`/students/${r.student_id}`}
          style={{ color: 'inherit', textDecoration: 'none' }}
        >
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {r.student_name || '—'}
          </Typography>
        </Link>
      ),
    },
    {
      key: 'kind',
      label: t('columns.kind'),
      width: 140,
      render: (r) => <KindChip kind={r.kind} />,
    },
    {
      key: 'expires_on',
      label: t('columns.expiresOn'),
      width: 160,
      render: (r) => (
        <Typography variant="body2">{fmt.date(r.expires_on)}</Typography>
      ),
    },
    {
      key: 'days',
      label: t('columns.daysRemaining'),
      width: 140,
      render: (r) => <DaysBadge days={r.days_remaining} severity={r.severity} />,
    },
    {
      key: 'source',
      label: t('columns.source'),
      width: 220,
      hideOnMobile: true,
      render: (r) => (
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
          {r.source_table}
        </Typography>
      ),
    },
  ];

  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ px: 2, py: 1.5 }}>
        {filters}
      </Paper>

      {listQuery.isLoading ? (
        <LoadingSkeleton variant="list" rows={6} />
      ) : listQuery.isError ? (
        <ErrorState
          title={t('couldNotLoad')}
          description={
            listQuery.error instanceof ApiError
              ? listQuery.error.detail || listQuery.error.title
              : undefined
          }
          onRetry={() => listQuery.refetch()}
          requestId={
            listQuery.error instanceof ApiError ? listQuery.error.requestId : undefined
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<EventBusyOutlinedIcon fontSize="medium" />}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      ) : (
        <Paper variant="outlined">
          <DataTable<ExpiryRow>
            columns={columns}
            rows={rows}
            rowCount={rows.length}
            getRowId={(r) => `${r.kind}:${r.id}`}
            ariaLabel="Expiries"
          />
        </Paper>
      )}
    </Stack>
  );
}
