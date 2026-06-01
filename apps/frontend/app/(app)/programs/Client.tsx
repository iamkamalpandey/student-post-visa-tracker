// Refactored to SVT form-pattern
'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import NextLink from 'next/link';
import {
  Autocomplete,
  Box,
  Button,
  Card,
  Chip,
  IconButton,
  InputAdornment,
  Link as MuiLink,
  MenuItem,
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
import AddIcon from '@mui/icons-material/Add';
import SearchIcon from '@mui/icons-material/Search';
import ClearIcon from '@mui/icons-material/Clear';
import EventAvailableOutlinedIcon from '@mui/icons-material/EventAvailableOutlined';
import ClassOutlinedIcon from '@mui/icons-material/ClassOutlined';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { isAdmin as roleIsAdmin } from '@/lib/auth-helpers';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LabeledField from '@/components/LabeledField';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import CreateProgramDialog from '@/features/programs/CreateProgramDialog';
import IntakeDialog from '@/features/programs/IntakeDialog';
import {
  ACADEMIC_LEVELS,
  DURATION_PATTERNS,
  type AcademicLevel,
  type ProgramRow,
} from '@/features/programs/types';
import type { CountryRow } from '@/features/institutions/types';

type InstitutionOption = { id: string; display_name: string; country_code: string };

type ListResponse = {
  data: ProgramRow[];
  page: { nextCursor: string | null; hasMore: boolean; total: number };
};

// Common languages of instruction surfaced in the filter. The backend stores
// `language_of_instruction` as a free-text BCP-47 tag on each program row, so
// we filter client-side against `r.language_of_instruction` rather than
// pushing a new query param to `GET /programs` (which uses a strict zod
// schema — see packages/zod-schemas/src/programs.ts:ProgramListQuery).
const LANGUAGE_OPTIONS: { value: string; label: string }[] = [
  { value: 'en', label: 'English' },
  { value: 'fr', label: 'French' },
  { value: 'de', label: 'German' },
  { value: 'es', label: 'Spanish' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'zh', label: 'Chinese' },
  { value: 'ko', label: 'Korean' },
  { value: 'ne', label: 'Nepali' },
  { value: 'hi', label: 'Hindi' },
];

export default function ProgramsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user } = useAuth();
  // Admin-only gate for write actions on this page (create program, quick
  // intake add). Mirrors the SVT form-pattern naming convention.
  const canWrite = roleIsAdmin(user?.role);

  const [search, setSearch] = useState('');
  const [institution, setInstitution] = useState<InstitutionOption | null>(null);
  const [level, setLevel] = useState<AcademicLevel | ''>('');
  const [country, setCountry] = useState<CountryRow | null>(null);
  const [iscedCode, setIscedCode] = useState('');
  const [language, setLanguage] = useState<string>('');
  const [createOpen, setCreateOpen] = useState(false);
  // Holds the program id whose IntakeDialog should be opened. Used by the
  // per-row "Add intake" quick action.
  const [quickIntakeFor, setQuickIntakeFor] = useState<string | null>(null);

  // Pre-select institution from query string (used when navigating from an
  // institution detail page).
  const presetInstitutionId = searchParams?.get('institution_id') ?? null;

  const institutionsQ = useQuery({
    queryKey: ['institutions', 'list', { limit: '100' }],
    queryFn: async () => {
      const res = await api.get<{ data: InstitutionOption[] }>('/institutions', {
        params: { limit: 100 },
      });
      return res.data.data;
    },
    staleTime: 60_000,
  });

  const countriesQ = useQuery({
    queryKey: ['lookups', 'countries'],
    queryFn: async () => {
      const res = await api.get<{ data: CountryRow[] }>('/lookups/countries');
      return res.data.data;
    },
    staleTime: 5 * 60_000,
  });

  useEffect(() => {
    if (presetInstitutionId && !institution && institutionsQ.data) {
      const i = institutionsQ.data.find((x) => x.id === presetInstitutionId);
      if (i) setInstitution(i);
    }
  }, [presetInstitutionId, institution, institutionsQ.data]);

  const params = useMemo(() => {
    const p: Record<string, string> = { limit: '100' };
    if (search.trim()) p['q'] = search.trim();
    if (institution) p['institution_id'] = institution.id;
    if (level) p['level'] = level;
    if (country) p['country_code'] = country.code_alpha2;
    // ISCED-F is enforced server-side as a 4-digit code; only forward when
    // the user has typed a complete value so a half-typed code doesn't 400.
    if (/^\d{4}$/.test(iscedCode.trim())) p['isced_code'] = iscedCode.trim();
    return p;
  }, [search, institution, level, country, iscedCode]);

  const listQ = useQuery({
    queryKey: ['programs', 'list', params],
    queryFn: async () => {
      const res = await api.get<ListResponse>('/programs', { params });
      return res.data;
    },
  });

  const rawRows = listQ.data?.data ?? [];
  // Apply the language-of-instruction filter client-side because the backend
  // list endpoint does not (yet) accept it as a query param. Match on the
  // primary subtag so "en-GB" still matches the "English" filter.
  const rows = useMemo(() => {
    if (!language) return rawRows;
    return rawRows.filter((r) => {
      const tag = (r.language_of_instruction ?? '').toLowerCase().split('-')[0];
      return tag === language;
    });
  }, [rawRows, language]);

  const filtersApplied = Boolean(
    search.trim() || institution || level || country || iscedCode.trim() || language,
  );

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: 'column', md: 'row' }}
        spacing={2}
        alignItems={{ xs: 'flex-start', md: 'center' }}
        justifyContent="space-between"
      >
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 600, letterSpacing: -0.2 }}>
            Courses
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Programs offered by partner institutions, including intakes, fees, and entry
            requirements.
          </Typography>
        </Box>
        {canWrite ? (
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={() => setCreateOpen(true)}
          >
            New course
          </Button>
        ) : null}
      </Stack>

      {/*
       * Intake-status quick-filter chips ("Open / Closing soon / Closed") were
       * removed in an earlier wave because the program list endpoint only
       * returns `_count.intakes` and not per-intake status fields, so the
       * chips would have been purely cosmetic. Confirmed cleanly removed —
       * restore once the backend exposes an `intake_status` query param on
       * `GET /programs` — see TODO(svt-programs-intake-status-filter).
       */}

      <Card variant="outlined" sx={{ p: 2 }}>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          alignItems={{ md: 'flex-start' }}
          flexWrap="wrap"
        >
          <LabeledField label="Search courses" srOnly htmlFor="programs-filter-search">
            <TextField
              id="programs-filter-search"
              placeholder="Search by name, short name, code…"
              size="small"
              sx={{ flex: 1, minWidth: 220 }}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon fontSize="small" />
                  </InputAdornment>
                ),
                endAdornment: search ? (
                  <InputAdornment position="end">
                    <IconButton size="small" onClick={() => setSearch('')} aria-label="Clear">
                      <ClearIcon fontSize="small" />
                    </IconButton>
                  </InputAdornment>
                ) : null,
              }}
            />
          </LabeledField>
          <LabeledField label="Level" srOnly htmlFor="programs-filter-level">
            <TextField
              id="programs-filter-level"
              select
              size="small"
              label="Level"
              value={level}
              onChange={(e) => setLevel((e.target.value as AcademicLevel | '') || '')}
              sx={{ minWidth: 160 }}
            >
              <MenuItem value="">Any</MenuItem>
              {ACADEMIC_LEVELS.map((l) => (
                <MenuItem key={l.value} value={l.value}>
                  {l.label}
                </MenuItem>
              ))}
            </TextField>
          </LabeledField>
          <LabeledField label="Country" srOnly htmlFor="programs-filter-country">
            <Autocomplete<CountryRow>
              options={countriesQ.data ?? []}
              loading={countriesQ.isLoading}
              value={country}
              onChange={(_, v) => setCountry(v)}
              getOptionLabel={(o) => `${o.name} (${o.code_alpha2})`}
              isOptionEqualToValue={(a, b) => a.code_alpha2 === b.code_alpha2}
              sx={{ minWidth: 200 }}
              renderInput={(p) => (
                <TextField
                  {...p}
                  id="programs-filter-country"
                  size="small"
                  label="Country"
                  placeholder="Any"
                />
              )}
            />
          </LabeledField>
          <LabeledField label="ISCED code" srOnly htmlFor="programs-filter-isced">
            <TextField
              id="programs-filter-isced"
              size="small"
              label="ISCED"
              placeholder="0410"
              value={iscedCode}
              onChange={(e) => setIscedCode(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
              inputProps={{ inputMode: 'numeric', maxLength: 4, pattern: '\\d{4}' }}
              helperText={
                iscedCode && !/^\d{4}$/.test(iscedCode) ? 'Enter 4 digits' : undefined
              }
              error={Boolean(iscedCode) && !/^\d{4}$/.test(iscedCode)}
              sx={{ minWidth: 140 }}
            />
          </LabeledField>
          <LabeledField label="Language of instruction" srOnly htmlFor="programs-filter-language">
            <TextField
              id="programs-filter-language"
              select
              size="small"
              label="Language"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              sx={{ minWidth: 160 }}
            >
              <MenuItem value="">Any</MenuItem>
              {LANGUAGE_OPTIONS.map((l) => (
                <MenuItem key={l.value} value={l.value}>
                  {l.label}
                </MenuItem>
              ))}
            </TextField>
          </LabeledField>
          <LabeledField label="Institution" srOnly htmlFor="programs-filter-institution">
            <Autocomplete<InstitutionOption>
              options={institutionsQ.data ?? []}
              loading={institutionsQ.isLoading}
              value={institution}
              onChange={(_, v) => setInstitution(v)}
              getOptionLabel={(o) => `${o.display_name} (${o.country_code})`}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              sx={{ minWidth: 240 }}
              renderInput={(p) => (
                <TextField
                  {...p}
                  id="programs-filter-institution"
                  size="small"
                  label="Institution"
                  placeholder="Any"
                />
              )}
            />
          </LabeledField>
        </Stack>
      </Card>

      {listQ.isLoading ? (
        <LoadingSkeleton rows={6} />
      ) : listQ.isError ? (
        <ErrorState onRetry={() => void listQ.refetch()} />
      ) : rows.length === 0 ? (
        filtersApplied ? (
          <EmptyState
            icon={<ClassOutlinedIcon fontSize="medium" />}
            title="No matches"
            description="Try clearing the filters to widen the search."
            actions={
              <Button
                onClick={() => {
                  setSearch('');
                  setInstitution(null);
                  setLevel('');
                  setCountry(null);
                  setIscedCode('');
                  setLanguage('');
                }}
              >
                Clear filters
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={<ClassOutlinedIcon fontSize="medium" />}
            title="No courses yet"
            description={
              canWrite
                ? 'Create a course against an institution so students can be enrolled into it.'
                : 'No courses have been published yet.'
            }
            actions={
              canWrite ? (
                <Button
                  variant="contained"
                  startIcon={<AddIcon />}
                  onClick={() => setCreateOpen(true)}
                >
                  New course
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <Card variant="outlined">
          <TableContainer>
            <Table size="small" aria-label="Courses">
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 600 }}>Code</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Name</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Level</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Institution</TableCell>
                  <TableCell sx={{ fontWeight: 600 }} align="right">
                    Intakes
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }} align="right">
                    Duration
                  </TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Cadence</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Mode</TableCell>
                  <TableCell sx={{ fontWeight: 600 }}>Active</TableCell>
                  {canWrite ? (
                    <TableCell sx={{ fontWeight: 600 }} align="right">
                      Quick add
                    </TableCell>
                  ) : null}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((r) => (
                  <TableRow
                    key={r.id}
                    hover
                    sx={{ cursor: 'pointer' }}
                    onClick={() => router.push(`/programs/${r.id}`)}
                  >
                    <TableCell>
                      <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
                        {r.code ?? '—'}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Stack spacing={0.25}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {r.name}
                        </Typography>
                        {r.short_name ? (
                          <Typography variant="caption" color="text.secondary">
                            {r.short_name}
                          </Typography>
                        ) : null}
                      </Stack>
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={r.level} variant="outlined" />
                    </TableCell>
                    <TableCell>
                      <Stack spacing={0.25}>
                        {r.institution ? (
                          <MuiLink
                            component={NextLink}
                            href={`/institutions/${r.institution.id}`}
                            onClick={(e) => e.stopPropagation()}
                            underline="hover"
                            variant="body2"
                            sx={{ fontWeight: 500, color: 'text.primary' }}
                          >
                            {r.institution.display_name}
                          </MuiLink>
                        ) : (
                          <Typography variant="body2">—</Typography>
                        )}
                        {r.institution?.country_code ? (
                          <Typography variant="caption" color="text.secondary">
                            {r.institution.country_code}
                          </Typography>
                        ) : null}
                      </Stack>
                    </TableCell>
                    <TableCell align="right">
                      <Chip
                        size="small"
                        icon={<EventAvailableOutlinedIcon sx={{ fontSize: 14 }} />}
                        label={r._count?.intakes ?? 0}
                        variant="outlined"
                      />
                    </TableCell>
                    <TableCell align="right">{r.duration_months}m</TableCell>
                    <TableCell>
                      {r.duration_pattern ? (
                        <Typography variant="body2">
                          {DURATION_PATTERNS.find((p) => p.value === r.duration_pattern)
                            ?.label ?? r.duration_pattern}
                        </Typography>
                      ) : (
                        <Typography variant="body2" color="text.secondary">
                          —
                        </Typography>
                      )}
                    </TableCell>
                    <TableCell>
                      <Chip size="small" label={r.delivery_mode} variant="outlined" />
                    </TableCell>
                    <TableCell>
                      <Chip
                        size="small"
                        label={r.is_active ? 'Active' : 'Inactive'}
                        color={r.is_active ? 'success' : 'default'}
                        variant={r.is_active ? 'filled' : 'outlined'}
                      />
                    </TableCell>
                    {canWrite ? (
                      <TableCell align="right">
                        <Tooltip title="Add intake">
                          <IconButton
                            size="small"
                            color="primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              setQuickIntakeFor(r.id);
                            }}
                            aria-label={`Add intake to ${r.name}`}
                          >
                            <AddIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <Box sx={{ px: 2, py: 1.25, borderTop: (t) => `1px solid ${t.palette.divider}` }}>
            <Typography variant="caption" color="text.secondary">
              Showing {rows.length}
              {listQ.data?.page.total ? ` of ${listQ.data.page.total}` : ''}
              {listQ.data?.page.hasMore ? ' (more available)' : ''}
            </Typography>
          </Box>
        </Card>
      )}

      <CreateProgramDialog
        open={createOpen}
        defaultInstitutionId={institution?.id}
        onClose={() => setCreateOpen(false)}
      />
      {quickIntakeFor ? (
        <IntakeDialog
          open
          programId={quickIntakeFor}
          intake={null}
          onClose={() => setQuickIntakeFor(null)}
        />
      ) : null}
    </Stack>
  );
}
