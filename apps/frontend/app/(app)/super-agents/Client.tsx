'use client';

// Super-agents card-grid landing page. Mirrors the /institutions design:
// hero header + KPI strip + filter bar + responsive card grid.

import { useId, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Autocomplete,
  Box,
  Button,
  Card,
  CardActionArea,
  CardContent,
  Chip,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import ClearIcon from '@mui/icons-material/Clear';

import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCountries } from '@/lib/queries';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import LabeledField from '@/components/LabeledField';
import KpiTile from '@/components/KpiTile';
import type { CountryRow } from '@/features/institutions/types';
import SuperAgentEditDialog from '@/features/super-agents/SuperAgentEditDialog';

type SuperAgentRow = {
  id: string;
  name: string;
  short_name: string | null;
  country_code: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'TERMINATED';
  is_active: boolean;
  default_commission_pct: string | number | null;
  type?: { id: string; key: string; label: string } | null;
};

type ListResponse = { data: SuperAgentRow[] };

// KpiTile moved to @/components/KpiTile — see SVT-WAVE5-2026-05.

function statusColor(s: SuperAgentRow['status']): 'success' | 'warning' | 'default' {
  if (s === 'ACTIVE') return 'success';
  if (s === 'PAUSED') return 'warning';
  return 'default';
}

function SuperAgentCard({ row, onOpen }: { row: SuperAgentRow; onOpen: () => void }) {
  const initials = (row.short_name ?? row.name).slice(0, 3).toUpperCase();
  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardActionArea onClick={onOpen} sx={{ height: '100%' }}>
        <CardContent>
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={1.5} alignItems="flex-start">
              <Box
                sx={{
                  width: 44,
                  height: 44,
                  borderRadius: 1,
                  bgcolor: 'primary.main',
                  color: 'primary.contrastText',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                {initials}
              </Box>
              <Stack sx={{ flex: 1, minWidth: 0 }}>
                <Typography
                  variant="subtitle1"
                  sx={{
                    fontWeight: 700,
                    lineHeight: 1.2,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row.name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {row.type?.label ?? '—'}
                  {row.country_code ? ` · ${row.country_code}` : ''}
                </Typography>
              </Stack>
            </Stack>

            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              <Chip size="small" label={row.status} color={statusColor(row.status)} variant="outlined" />
              {row.default_commission_pct != null && (
                <Chip
                  size="small"
                  label={`${row.default_commission_pct}% default`}
                  variant="outlined"
                />
              )}
            </Stack>
          </Stack>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default function SuperAgentsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const [search, setSearch] = useState('');
  const [country, setCountry] = useState<CountryRow | null>(null);
  const [status, setStatus] = useState<'ALL' | 'ACTIVE' | 'PAUSED' | 'TERMINATED'>('ALL');
  // /super-agents/new route doesn't exist — opening the dialog with row=null
  // (create mode) is the supported path. Mirrors the institutions pattern.
  const [createOpen, setCreateOpen] = useState(false);

  const searchId = useId();
  const countryId = useId();

  const countriesQ = useCountries();

  const params = useMemo(() => {
    const p: Record<string, string> = {};
    if (country) p['country_code'] = country.code_alpha2;
    if (status !== 'ALL') p['status'] = status;
    return p;
  }, [country, status]);

  const listQ = useQuery({
    queryKey: ['super-agents', 'list', params],
    queryFn: async () => {
      const res = await api.get<ListResponse>('/super-agents', { params });
      return res.data;
    },
  });

  const allRows: SuperAgentRow[] = Array.isArray(listQ.data?.data) ? listQ.data!.data : [];
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return allRows;
    return allRows.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        (r.short_name ?? '').toLowerCase().includes(q),
    );
  }, [allRows, search]);

  const total = allRows.length;
  const activeCount = allRows.filter((r) => r.status === 'ACTIVE').length;
  const countriesCount = new Set(allRows.map((r) => r.country_code).filter(Boolean)).size;
  const filtersApplied = Boolean(search.trim() || country || status !== 'ALL');

  const listErr = listQ.error instanceof ApiError ? listQ.error : null;

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        justifyContent="space-between"
        alignItems={{ md: 'flex-end' }}
      >
        <Stack spacing={0.5}>
          <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: -0.3 }}>
            Super-agents
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Aggregator and intermediary platforms (Adventus, Edvoy, IDP, ApplyBoard) the consultancy uses to access institutions.
          </Typography>
        </Stack>
        {isAdmin && (
          <Button
            variant="contained"
            startIcon={<AddOutlinedIcon />}
            onClick={() => setCreateOpen(true)}
            sx={{ alignSelf: { xs: 'stretch', md: 'flex-end' } }}
          >
            New super-agent
          </Button>
        )}
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <KpiTile icon={<HubOutlinedIcon />} label="Total" value={total} hint={listQ.isFetching ? 'refreshing…' : undefined} />
        <KpiTile icon={<HubOutlinedIcon />} label="Active" value={activeCount} />
        <KpiTile icon={<LanguageOutlinedIcon />} label="Countries" value={countriesCount} />
      </Stack>

      <Card variant="outlined">
        <CardContent>
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
            <Box sx={{ flex: 2, minWidth: 0 }}>
              <LabeledField label="Search super-agents" srOnly htmlFor={searchId}>
                <TextField
                  id={searchId}
                  size="small"
                  hiddenLabel
                  fullWidth
                  placeholder="Search by name or short name…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  InputProps={{
                    startAdornment: (
                      <InputAdornment position="start">
                        <SearchOutlinedIcon fontSize="small" />
                      </InputAdornment>
                    ),
                    endAdornment: search ? (
                      <InputAdornment position="end">
                        <IconButton size="small" aria-label="Clear search" onClick={() => setSearch('')}>
                          <ClearIcon fontSize="small" />
                        </IconButton>
                      </InputAdornment>
                    ) : undefined,
                  }}
                />
              </LabeledField>
            </Box>
            <Box sx={{ flex: 1, minWidth: 220 }}>
              <LabeledField label="Filter by country" srOnly htmlFor={countryId}>
                <Autocomplete<CountryRow>
                  options={countriesQ.data ?? []}
                  loading={countriesQ.isLoading}
                  value={country}
                  onChange={(_, v) => setCountry(v)}
                  getOptionLabel={(o) => `${o.code_alpha2} — ${o.name}`}
                  isOptionEqualToValue={(a, b) => a.code_alpha2 === b.code_alpha2}
                  size="small"
                  renderInput={(p) => (
                    <TextField {...p} id={countryId} hiddenLabel placeholder="Any country" />
                  )}
                />
              </LabeledField>
            </Box>
            <TextField
              select
              SelectProps={{ native: true }}
              size="small"
              value={status}
              onChange={(e) => setStatus(e.target.value as typeof status)}
              sx={{ minWidth: 140 }}
            >
              <option value="ALL">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="PAUSED">Paused</option>
              <option value="TERMINATED">Terminated</option>
            </TextField>
            <Tooltip title="Refresh list">
              <span>
                <IconButton
                  aria-label="Refresh super-agents"
                  onClick={() => void listQ.refetch()}
                  disabled={listQ.isFetching}
                >
                  <RefreshOutlinedIcon />
                </IconButton>
              </span>
            </Tooltip>
            {filtersApplied && (
              <Button
                size="small"
                variant="text"
                onClick={() => {
                  setSearch('');
                  setCountry(null);
                  setStatus('ALL');
                }}
              >
                Reset
              </Button>
            )}
          </Stack>
        </CardContent>
      </Card>

      {listQ.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : listQ.isError ? (
        <ErrorState
          title="Couldn’t load super-agents"
          description={listErr?.detail ?? listErr?.title ?? 'The list failed to load.'}
          requestId={listErr?.requestId}
          onRetry={() => void listQ.refetch()}
        />
      ) : rows.length === 0 ? (
        filtersApplied ? (
          <EmptyState
            icon={<HubOutlinedIcon fontSize="medium" />}
            title="No matches"
            description="Try clearing the filters."
            actions={
              <Button
                onClick={() => {
                  setSearch('');
                  setCountry(null);
                  setStatus('ALL');
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<HubOutlinedIcon fontSize="medium" />}
            title="No super-agents yet"
            description="Register the aggregator or intermediary platforms you use to access institutions."
            actions={
              isAdmin ? (
                <Button
                  variant="contained"
                  startIcon={<AddOutlinedIcon />}
                  onClick={() => setCreateOpen(true)}
                >
                  New super-agent
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: {
              xs: '1fr',
              sm: 'repeat(2, 1fr)',
              lg: 'repeat(3, 1fr)',
              xl: 'repeat(4, 1fr)',
            },
            gap: 2,
          }}
        >
          {rows.map((r) => (
            <SuperAgentCard key={r.id} row={r} onOpen={() => router.push(`/super-agents/${r.id}`)} />
          ))}
        </Box>
      )}
      <SuperAgentEditDialog open={createOpen} row={null} onClose={() => setCreateOpen(false)} />
    </Stack>
  );
}
