'use client';

// Refactored to SVT form-pattern per design pass.
// Rewritten 2026-05-16 — card-grid layout, KPI strip, modern hero header.

import { useId, useMemo, useState } from 'react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import {
  Alert,
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
  Switch,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import SchoolOutlinedIcon from '@mui/icons-material/SchoolOutlined';
import SearchOutlinedIcon from '@mui/icons-material/SearchOutlined';
import RefreshOutlinedIcon from '@mui/icons-material/RefreshOutlined';
import LanguageOutlinedIcon from '@mui/icons-material/LanguageOutlined';
import HandshakeOutlinedIcon from '@mui/icons-material/HandshakeOutlined';
import LibraryBooksOutlinedIcon from '@mui/icons-material/LibraryBooksOutlined';
import LocationCityOutlinedIcon from '@mui/icons-material/LocationCityOutlined';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';
import ClearIcon from '@mui/icons-material/Clear';

import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useCountries } from '@/lib/queries';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import LabeledField from '@/components/LabeledField';
import KpiTile from '@/components/KpiTile';
import CreateInstitutionDialog from '@/features/institutions/CreateInstitutionDialog';
import { type InstitutionRow, type CountryRow } from '@/features/institutions/types';

type ListResponse = {
  data: InstitutionRow[];
  page?: { total?: number; nextCursor?: string | null; hasMore?: boolean };
};

const TYPE_LABELS: Record<string, string> = {
  UNIVERSITY: 'University',
  COLLEGE: 'College',
  COMMUNITY_COLLEGE: 'Community college',
  POLYTECHNIC: 'Polytechnic',
  LANGUAGE_SCHOOL: 'Language school',
  PATHWAY_PROVIDER: 'Pathway provider',
  VOCATIONAL: 'Vocational',
  HIGH_SCHOOL: 'High school',
  OTHER: 'Other',
};

function typeLabel(t: string): string {
  return TYPE_LABELS[t] ?? t;
}

// KpiTile moved to @/components/KpiTile — see SVT-WAVE5-2026-05.

function InstitutionCard({ row, onOpen }: { row: InstitutionRow; onOpen: () => void }) {
  const programs = row._count?.programs ?? 0;
  const campuses = row._count?.campuses ?? 0;
  const schools = row._count?.schools ?? 0;
  // SVT-SUPERAGENTS-2026-05: chip surfaces multi-channel reach.
  const superAgents = row._count?.super_agent_links ?? 0;

  return (
    <Card variant="outlined" sx={{ height: '100%' }}>
      <CardActionArea onClick={onOpen} sx={{ height: '100%' }}>
        <CardContent>
          <Stack spacing={1.5}>
            {/* Header row: avatar tile + name + type chip */}
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
                  fontSize: 16,
                }}
              >
                {row.short_name?.slice(0, 3).toUpperCase() ??
                  row.display_name.slice(0, 2).toUpperCase()}
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
                  title={row.legal_name}
                >
                  {row.display_name}
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  {typeLabel(row.type)} · {row.country_code}
                </Typography>
              </Stack>
            </Stack>

            {/* Tags row */}
            <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
              {row.is_partner && (
                <Chip
                  size="small"
                  label="Partner"
                  color="success"
                  variant="outlined"
                  icon={<HandshakeOutlinedIcon sx={{ fontSize: 14 }} />}
                />
              )}
              {row.established_year && (
                <Chip
                  size="small"
                  label={`Est. ${row.established_year}`}
                  variant="outlined"
                />
              )}
              {row.ranking_global && (
                <Chip
                  size="small"
                  label={`#${row.ranking_global} global`}
                  variant="outlined"
                />
              )}
              {superAgents > 0 && (
                <Chip
                  size="small"
                  label={`via ${superAgents} super-agent${superAgents === 1 ? '' : 's'}`}
                  color="info"
                  variant="outlined"
                />
              )}
            </Stack>

            {/* Stats row */}
            <Stack direction="row" spacing={2} sx={{ pt: 0.5 }}>
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <LibraryBooksOutlinedIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                <Typography variant="caption" color="text.secondary">
                  {programs} program{programs === 1 ? '' : 's'}
                </Typography>
              </Stack>
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <LocationCityOutlinedIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                <Typography variant="caption" color="text.secondary">
                  {campuses} campus{campuses === 1 ? '' : 'es'}
                </Typography>
              </Stack>
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <SchoolOutlinedIcon sx={{ fontSize: 14, color: 'text.secondary' }} />
                <Typography variant="caption" color="text.secondary">
                  {schools} school{schools === 1 ? '' : 's'}
                </Typography>
              </Stack>
            </Stack>

            {row.website && (
              <Typography
                variant="caption"
                color="text.secondary"
                sx={{
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 0.5,
                }}
              >
                <OpenInNewOutlinedIcon sx={{ fontSize: 12 }} />
                {row.website.replace(/^https?:\/\//, '')}
              </Typography>
            )}
          </Stack>
        </CardContent>
      </CardActionArea>
    </Card>
  );
}

export default function InstitutionsPage() {
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';

  const [search, setSearch] = useState('');
  const [country, setCountry] = useState<CountryRow | null>(null);
  const [partnerOnly, setPartnerOnly] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const searchId = useId();
  const countryId = useId();
  const partnerId = useId();

  const countriesQ = useCountries();

  const params = useMemo(() => {
    const p: Record<string, string | boolean> = { limit: '100' };
    if (search.trim()) p['q'] = search.trim();
    if (country) p['country_code'] = country.code_alpha2;
    if (partnerOnly) p['is_partner'] = 'true';
    return p;
  }, [search, country, partnerOnly]);

  const listQ = useQuery({
    queryKey: ['institutions', 'list', params],
    queryFn: async () => {
      const res = await api.get<ListResponse>('/institutions', { params });
      return res.data;
    },
  });

  const rows: InstitutionRow[] = Array.isArray(listQ.data?.data) ? listQ.data!.data : [];
  const total = listQ.data?.page?.total ?? rows.length;
  const partnersCount = rows.filter((r) => r.is_partner).length;
  const countriesCount = new Set(rows.map((r) => r.country_code)).size;
  const filtersApplied = Boolean(search.trim() || country || partnerOnly);

  const listErr = listQ.error instanceof ApiError ? listQ.error : null;

  return (
    <Stack spacing={3}>
      {/* Hero header */}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} justifyContent="space-between" alignItems={{ md: 'flex-end' }}>
        <Stack spacing={0.5}>
          <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: -0.3 }}>
            Institutions
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Universities, colleges, language schools, pathway providers — and their campuses, programs, and accreditations.
          </Typography>
        </Stack>
        {isAdmin && (
          <Button
            variant="contained"
            startIcon={<AddOutlinedIcon />}
            onClick={() => setCreateOpen(true)}
            sx={{ alignSelf: { xs: 'stretch', md: 'flex-end' } }}
          >
            New institution
          </Button>
        )}
      </Stack>

      {/* KPI strip */}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
        <KpiTile
          icon={<SchoolOutlinedIcon />}
          label="Total"
          value={total}
          hint={listQ.isFetching ? 'refreshing…' : undefined}
        />
        <KpiTile icon={<HandshakeOutlinedIcon />} label="Partners" value={partnersCount} />
        <KpiTile icon={<LanguageOutlinedIcon />} label="Countries" value={countriesCount} />
      </Stack>

      {/* Filter bar */}
      <Card variant="outlined">
        <CardContent>
          <Stack
            direction={{ xs: 'column', md: 'row' }}
            spacing={2}
            alignItems={{ md: 'center' }}
          >
            <Box sx={{ flex: 2, minWidth: 0 }}>
              <LabeledField label="Search institutions" srOnly htmlFor={searchId}>
                <TextField
                  id={searchId}
                  size="small"
                  hiddenLabel
                  fullWidth
                  placeholder="Search by name, legal name, short name…"
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
                    <TextField
                      {...p}
                      id={countryId}
                      hiddenLabel
                      placeholder="Any country"
                    />
                  )}
                />
              </LabeledField>
            </Box>
            <LabeledField label="Show partners only" srOnly htmlFor={partnerId}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Switch
                  id={partnerId}
                  size="small"
                  checked={partnerOnly}
                  onChange={(_, c) => setPartnerOnly(c)}
                />
                <Typography variant="body2">Partners only</Typography>
              </Stack>
            </LabeledField>
            <Tooltip title="Refresh list">
              <span>
                <IconButton
                  aria-label="Refresh institutions"
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
                  setPartnerOnly(false);
                }}
              >
                Reset
              </Button>
            )}
          </Stack>
        </CardContent>
      </Card>

      {/* Body: skeleton / error / empty / grid */}
      {listQ.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : listQ.isError ? (
        <ErrorState
          title="Couldn’t load institutions"
          description={listErr?.detail ?? listErr?.title ?? 'The institutions list failed to load.'}
          requestId={listErr?.requestId}
          onRetry={() => void listQ.refetch()}
        />
      ) : rows.length === 0 ? (
        filtersApplied ? (
          <EmptyState
            icon={<SchoolOutlinedIcon fontSize="medium" />}
            title="No matches"
            description="Try clearing the filters to see more institutions."
            actions={
              <Button
                onClick={() => {
                  setSearch('');
                  setCountry(null);
                  setPartnerOnly(false);
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<SchoolOutlinedIcon fontSize="medium" />}
            title="No institutions yet"
            description="Register the universities, colleges, and language schools you work with so they can be linked to programs and enrolments."
            actions={
              isAdmin ? (
                <Button
                  variant="contained"
                  startIcon={<AddOutlinedIcon />}
                  onClick={() => setCreateOpen(true)}
                >
                  New institution
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <Box>
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
              <InstitutionCard
                key={r.id}
                row={r}
                onOpen={() => router.push(`/institutions/${r.id}`)}
              />
            ))}
          </Box>
          {listQ.data?.page?.hasMore && (
            <Alert severity="info" variant="outlined" sx={{ mt: 2 }}>
              Showing first {rows.length} of {total ?? '?'} institutions. Refine filters to narrow.
            </Alert>
          )}
        </Box>
      )}

      <CreateInstitutionDialog open={createOpen} onClose={() => setCreateOpen(false)} />
    </Stack>
  );
}
