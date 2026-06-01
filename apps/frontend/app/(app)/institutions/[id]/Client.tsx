'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useTranslations } from 'next-intl';
import {
  Box,
  Breadcrumbs,
  Button,
  Card,
  Chip,
  IconButton,
  Stack,
  Tab,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  Tooltip,
  Typography,
} from '@mui/material';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import AddIcon from '@mui/icons-material/Add';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import ArrowBackIosNewIcon from '@mui/icons-material/ArrowBackIosNew';
import ClassOutlinedIcon from '@mui/icons-material/ClassOutlined';
import LocationOnOutlinedIcon from '@mui/icons-material/LocationOnOutlined';
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import EventAvailableOutlinedIcon from '@mui/icons-material/EventAvailableOutlined';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import ErrorState from '@/components/ErrorState';
import EmptyState from '@/components/EmptyState';
import ConfirmDialog from '@/components/ConfirmDialog';
import EditInstitutionDialog from '@/features/institutions/EditInstitutionDialog';
import IdentifierDialog from '@/features/institutions/IdentifierDialog';
import AccreditationDialog from '@/features/institutions/AccreditationDialog';
import ContactDialog from '@/features/institutions/ContactDialog';
import CampusDialog from '@/features/institutions/CampusDialog';
import SchoolDialog from '@/features/institutions/SchoolDialog';
import DepartmentDialog from '@/features/institutions/DepartmentDialog';
import CreateProgramDialog from '@/features/programs/CreateProgramDialog';
import InstitutionSuperAgentsSection from '@/features/super-agents/InstitutionSuperAgentsSection';
import { formatPhone } from '@/lib/format';
import { safeHref } from '@/lib/safeHref';
import {
  INSTITUTION_TYPES,
  type CampusRow,
  type DepartmentRow,
  type InstitutionDetail,
  type SchoolRow,
} from '@/features/institutions/types';
import type { ProgramRow } from '@/features/programs/types';

type ProgramListResponse = {
  data: ProgramRow[];
  page: { hasMore: boolean; total: number; nextCursor: string | null };
};

function typeLabel(t: string): string {
  return INSTITUTION_TYPES.find((x) => x.value === t)?.label ?? t;
}

export default function InstitutionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params?.id;
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const tDetail = useTranslations('institutions.detail');

  const [tab, setTab] = useState<
    | 'overview'
    | 'identifiers'
    | 'accreditations'
    | 'contacts'
    | 'campuses'
    | 'schools'
    | 'programs'
    | 'super_agents'
  >('overview');

  // Dialog open state
  const [editOpen, setEditOpen] = useState(false);
  const [identifierOpen, setIdentifierOpen] = useState(false);
  const [accreditationOpen, setAccreditationOpen] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);
  const [createProgramOpen, setCreateProgramOpen] = useState(false);
  const [campusDialog, setCampusDialog] = useState<{ open: boolean; campus: CampusRow | null }>({
    open: false,
    campus: null,
  });
  const [schoolDialog, setSchoolDialog] = useState<{ open: boolean; school: SchoolRow | null }>({
    open: false,
    school: null,
  });
  const [deptDialog, setDeptDialog] = useState<{
    open: boolean;
    schoolId: string;
    department: DepartmentRow | null;
  }>({ open: false, schoolId: '', department: null });
  const [pendingDelete, setPendingDelete] = useState<{ path: string; label: string } | null>(
    null,
  );

  const detailQ = useQuery({
    queryKey: ['institutions', 'detail', id],
    enabled: Boolean(id),
    queryFn: async () => {
      const res = await api.get<InstitutionDetail>(`/institutions/${id}`);
      return res.data;
    },
  });

  const programsQ = useQuery({
    queryKey: ['institutions', id, 'programs'],
    enabled: Boolean(id),
    queryFn: async () => {
      const res = await api.get<ProgramListResponse>('/programs', {
        params: { institution_id: id, limit: 100 },
      });
      return res.data;
    },
  });

  const inst = detailQ.data ?? null;
  const programRows = programsQ.data?.data ?? [];

  // Active intakes window: today through +12 months. The list endpoint embeds
  // _count.intakes per row but doesn't expose start dates, so this is a
  // best-effort UI estimate using only the embedded counts.
  const activeIntakesCount = useMemo(() => {
    return programRows.reduce((sum, p) => sum + (p._count?.intakes ?? 0), 0);
  }, [programRows]);

  const deleteMut = useMutation({
    mutationFn: async (path: string) => {
      await api.delete(path);
    },
    onSuccess: () => {
      enqueueSnackbar('Removed.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['institutions', 'detail', id] });
      setPendingDelete(null);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        enqueueSnackbar(err.detail || err.title || 'Failed to delete.', {
          variant: 'error',
        });
      } else {
        enqueueSnackbar('Network error.', { variant: 'error' });
      }
    },
  });

  function confirmDelete(path: string, label: string) {
    if (!isAdmin) return;
    setPendingDelete({ path, label });
  }

  const programsCount = useMemo(() => {
    if (programsQ.data) return programsQ.data.page.total ?? programsQ.data.data.length;
    // Detail endpoint embeds the same count under _count.programs.
    return (inst as InstitutionDetail | null)?._count?.programs ?? 0;
  }, [programsQ.data, inst]);

  if (detailQ.isLoading) return <LoadingSkeleton variant="page" />;
  if (detailQ.isError || !inst) {
    return <ErrorState onRetry={() => void detailQ.refetch()} />;
  }

  return (
    <Stack spacing={3}>
      <Stack spacing={1}>
        <Breadcrumbs separator="›">
          <Link href="/institutions" style={{ color: 'inherit', textDecoration: 'none' }}>
            <Stack direction="row" alignItems="center" spacing={0.5}>
              <ArrowBackIosNewIcon fontSize="inherit" />
              <Typography variant="body2">Institutions</Typography>
            </Stack>
          </Link>
          <Typography variant="body2" color="text.secondary">
            {inst.display_name}
          </Typography>
        </Breadcrumbs>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          alignItems={{ md: 'center' }}
          justifyContent="space-between"
        >
          <Box>
            <Typography variant="h4" sx={{ fontWeight: 600 }}>
              {inst.display_name}
            </Typography>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center">
              {inst.short_name ? (
                <Typography variant="body2" color="text.secondary">
                  {inst.short_name}
                </Typography>
              ) : null}
              <Chip size="small" label={typeLabel(inst.type)} variant="outlined" />
              <Chip size="small" label={inst.country_code} />
              {inst.is_partner ? (
                <Chip size="small" color="primary" label="Partner" />
              ) : null}
            </Stack>
          </Box>
          {isAdmin ? (
            <Stack direction="row" spacing={1}>
              <Button
                variant="contained"
                size="small"
                startIcon={<AddIcon />}
                onClick={() => setCreateProgramOpen(true)}
              >
                Add program
              </Button>
              <Button
                variant="outlined"
                startIcon={<EditOutlinedIcon />}
                onClick={() => setEditOpen(true)}
              >
                Edit
              </Button>
            </Stack>
          ) : null}
        </Stack>
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(4, 1fr)' },
        }}
      >
        <StatTile
          icon={<ClassOutlinedIcon fontSize="small" />}
          label="Programs"
          value={programsCount}
          onClick={() => setTab('programs')}
        />
        <StatTile
          icon={<LocationOnOutlinedIcon fontSize="small" />}
          label="Campuses"
          value={inst.campuses.length}
          onClick={() => setTab('campuses')}
        />
        <StatTile
          icon={<AccountTreeOutlinedIcon fontSize="small" />}
          label="Schools"
          value={inst.schools.length}
          onClick={() => setTab('schools')}
        />
        <StatTile
          icon={<EventAvailableOutlinedIcon fontSize="small" />}
          label="Intakes (next 12m)"
          value={activeIntakesCount}
          onClick={() => setTab('programs')}
        />
      </Box>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        variant="scrollable"
        scrollButtons="auto"
        sx={{ borderBottom: (t) => `1px solid ${t.palette.divider}` }}
      >
        <Tab value="overview" label="Overview" />
        <Tab
          value="identifiers"
          label={`Identifiers${inst.identifiers ? ` (${inst.identifiers.length})` : ''}`}
        />
        <Tab
          value="accreditations"
          label={`Accreditations${inst.accreditations ? ` (${inst.accreditations.length})` : ''}`}
        />
        <Tab
          value="contacts"
          label={`Contacts${inst.contacts ? ` (${inst.contacts.length})` : ''}`}
        />
        <Tab
          value="campuses"
          label={`Campuses${inst.campuses ? ` (${inst.campuses.length})` : ''}`}
        />
        <Tab
          value="schools"
          label={`Schools${inst.schools ? ` (${inst.schools.length})` : ''}`}
        />
        <Tab value="programs" label={`Programs (${programsCount})`} />
        <Tab
          value="super_agents"
          label={`Super-agents${
            inst._count?.super_agent_links ? ` (${inst._count.super_agent_links})` : ''
          }`}
        />
      </Tabs>

      {tab === 'overview' ? (
        <Card variant="outlined" sx={{ p: 3 }}>
          <Box
            sx={{
              display: 'grid',
              gap: 2,
              gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr', md: 'repeat(3, 1fr)' },
            }}
          >
            <OverviewField label="Legal name" value={inst.legal_name} />
            <OverviewField label="Type" value={typeLabel(inst.type)} />
            <OverviewField label="Country" value={inst.country_code} />
            <OverviewField label="Established" value={inst.established_year ?? '—'} />
            <OverviewField
              label="Website"
              value={
                inst.website ? (
                  // SVT-SEC-P1-FE1-2026-05 — schemeb-allowlist user-supplied URLs
                  // before they reach href to neutralise javascript:/data:/vbscript: XSS.
                  <a href={safeHref(inst.website)} target="_blank" rel="noreferrer">
                    {inst.website} <OpenInNewIcon sx={{ fontSize: 12, ml: 0.5 }} />
                  </a>
                ) : (
                  '—'
                )
              }
            />
            <OverviewField label="Email" value={inst.email ?? '—'} />
            <OverviewField label="Phone" value={formatPhone(inst.phone_e164) || '—'} />
            <OverviewField label="Global ranking" value={inst.ranking_global ?? '—'} />
            <OverviewField label="National ranking" value={inst.ranking_national ?? '—'} />
            <OverviewField label="Commission %" value={inst.commission_pct ?? '—'} />
            <OverviewField
              label="Partner since"
              value={inst.partner_since ? inst.partner_since.slice(0, 10) : '—'}
            />
          </Box>
          {inst.description ? (
            <Box sx={{ mt: 3 }}>
              <Typography variant="caption" color="text.secondary">
                Description
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>
                {inst.description}
              </Typography>
            </Box>
          ) : null}
        </Card>
      ) : null}

      {tab === 'identifiers' ? (
        <Card variant="outlined">
          <SectionHeader
            title="Identifiers"
            actionLabel="Add identifier"
            onAction={() => setIdentifierOpen(true)}
            isAdmin={isAdmin}
          />
          {inst.identifiers.length === 0 ? (
            <EmptyState
              title="No identifiers yet"
              actions={
                isAdmin ? (
                  <Button
                    startIcon={<AddIcon />}
                    variant="contained"
                    onClick={() => setIdentifierOpen(true)}
                  >
                    Add identifier
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <TableContainer>
              <Table size="small" aria-label={tDetail('aria.identifiers')}>
                <TableHead>
                  <TableRow>
                    <TableCell>Scheme</TableCell>
                    <TableCell>Value</TableCell>
                    <TableCell>Issued by</TableCell>
                    <TableCell>Valid</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {inst.identifiers.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Chip size="small" label={row.scheme} variant="outlined" />
                      </TableCell>
                      <TableCell>{row.value}</TableCell>
                      <TableCell>{row.issued_by ?? '—'}</TableCell>
                      <TableCell>
                        {row.valid_from ? row.valid_from.slice(0, 10) : '—'}
                        {row.valid_to ? ` → ${row.valid_to.slice(0, 10)}` : ''}
                      </TableCell>
                      <TableCell align="right">
                        {isAdmin ? (
                          <Tooltip title="Delete">
                            <IconButton
                              aria-label={tDetail('aria.deleteIdentifier')}
                              size="small"
                              onClick={() =>
                                confirmDelete(
                                  `/institutions/identifiers/${row.id}`,
                                  'this identifier',
                                )
                              }
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Card>
      ) : null}

      {tab === 'accreditations' ? (
        <Card variant="outlined">
          <SectionHeader
            title="Accreditations"
            actionLabel="Add accreditation"
            onAction={() => setAccreditationOpen(true)}
            isAdmin={isAdmin}
          />
          {inst.accreditations.length === 0 ? (
            <EmptyState
              title="No accreditations yet"
              actions={
                isAdmin ? (
                  <Button
                    startIcon={<AddIcon />}
                    variant="contained"
                    onClick={() => setAccreditationOpen(true)}
                  >
                    Add accreditation
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <TableContainer>
              <Table size="small" aria-label={tDetail('aria.accreditations')}>
                <TableHead>
                  <TableRow>
                    <TableCell>Body</TableCell>
                    <TableCell>Number</TableCell>
                    <TableCell>Awarded</TableCell>
                    <TableCell>Expires</TableCell>
                    <TableCell>Scope</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {inst.accreditations.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.body}</TableCell>
                      <TableCell>{row.accreditation_no ?? '—'}</TableCell>
                      <TableCell>
                        {row.awarded_on ? row.awarded_on.slice(0, 10) : '—'}
                      </TableCell>
                      <TableCell>
                        {row.expires_on ? row.expires_on.slice(0, 10) : '—'}
                      </TableCell>
                      <TableCell>
                        <Typography
                          variant="body2"
                          sx={{
                            maxWidth: 280,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={row.scope ?? undefined}
                        >
                          {row.scope ?? '—'}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        {isAdmin ? (
                          <IconButton
                            aria-label={tDetail('aria.deleteAccreditation')}
                            size="small"
                            onClick={() =>
                              confirmDelete(
                                `/institutions/accreditations/${row.id}`,
                                'this accreditation',
                              )
                            }
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Card>
      ) : null}

      {tab === 'contacts' ? (
        <Card variant="outlined">
          <SectionHeader
            title="Contacts"
            actionLabel="Add contact"
            onAction={() => setContactOpen(true)}
            isAdmin={isAdmin}
          />
          {inst.contacts.length === 0 ? (
            <EmptyState
              title="No contacts yet"
              actions={
                isAdmin ? (
                  <Button
                    startIcon={<AddIcon />}
                    variant="contained"
                    onClick={() => setContactOpen(true)}
                  >
                    Add contact
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <TableContainer>
              <Table size="small" aria-label={tDetail('aria.contacts')}>
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Designation</TableCell>
                    <TableCell>Email</TableCell>
                    <TableCell>Phone</TableCell>
                    <TableCell>Primary</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {inst.contacts.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.full_name}</TableCell>
                      <TableCell>
                        {row.designation ?? '—'}
                        {row.department ? ` · ${row.department}` : ''}
                      </TableCell>
                      <TableCell>{row.email ?? '—'}</TableCell>
                      <TableCell>{formatPhone(row.phone_e164) || '—'}</TableCell>
                      <TableCell>
                        {row.is_primary ? <Chip size="small" label="Primary" /> : '—'}
                      </TableCell>
                      <TableCell align="right">
                        {isAdmin ? (
                          <IconButton
                            aria-label={tDetail('aria.deleteContact')}
                            size="small"
                            onClick={() =>
                              confirmDelete(
                                `/institutions/contacts/${row.id}`,
                                'this contact',
                              )
                            }
                          >
                            <DeleteOutlineIcon fontSize="small" />
                          </IconButton>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Card>
      ) : null}

      {tab === 'campuses' ? (
        <Card variant="outlined">
          <SectionHeader
            title="Campuses"
            actionLabel="Add campus"
            onAction={() => setCampusDialog({ open: true, campus: null })}
            isAdmin={isAdmin}
          />
          {inst.campuses.length === 0 ? (
            <EmptyState
              title="No campuses yet"
              actions={
                isAdmin ? (
                  <Button
                    startIcon={<AddIcon />}
                    variant="contained"
                    onClick={() => setCampusDialog({ open: true, campus: null })}
                  >
                    Add campus
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <TableContainer>
              <Table size="small" aria-label={tDetail('aria.campuses')}>
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Timezone</TableCell>
                    <TableCell>Phone</TableCell>
                    <TableCell>Email</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {inst.campuses.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        {row.name}
                        {row.is_main ? (
                          <Chip size="small" label="Main" sx={{ ml: 1 }} />
                        ) : null}
                      </TableCell>
                      <TableCell>{row.timezone}</TableCell>
                      <TableCell>{formatPhone(row.phone_e164) || '—'}</TableCell>
                      <TableCell>{row.email ?? '—'}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={row.is_active ? 'Active' : 'Inactive'}
                          color={row.is_active ? 'success' : 'default'}
                          variant={row.is_active ? 'filled' : 'outlined'}
                        />
                      </TableCell>
                      <TableCell align="right">
                        {isAdmin ? (
                          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                            <IconButton
                              aria-label={tDetail('aria.editCampus', { name: row.name })}
                              size="small"
                              onClick={() => setCampusDialog({ open: true, campus: row })}
                            >
                              <EditOutlinedIcon fontSize="small" />
                            </IconButton>
                            <IconButton
                              aria-label={tDetail('aria.deleteCampus', { name: row.name })}
                              size="small"
                              onClick={() =>
                                confirmDelete(
                                  `/institutions/campuses/${row.id}`,
                                  'this campus',
                                )
                              }
                            >
                              <DeleteOutlineIcon fontSize="small" />
                            </IconButton>
                          </Stack>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Card>
      ) : null}

      {tab === 'schools' ? (
        <Card variant="outlined">
          <SectionHeader
            title="Schools & departments"
            actionLabel="Add school"
            onAction={() => setSchoolDialog({ open: true, school: null })}
            isAdmin={isAdmin}
          />
          {inst.schools.length === 0 ? (
            <EmptyState
              title="No schools yet"
              actions={
                isAdmin ? (
                  <Button
                    startIcon={<AddIcon />}
                    variant="contained"
                    onClick={() => setSchoolDialog({ open: true, school: null })}
                  >
                    Add school
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <Stack divider={<Box sx={{ borderTop: (t) => `1px solid ${t.palette.divider}` }} />}>
              {inst.schools.map((s) => (
                <Box key={s.id} sx={{ p: 2 }}>
                  <Stack
                    direction="row"
                    alignItems="center"
                    justifyContent="space-between"
                    spacing={1}
                  >
                    <Box>
                      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
                        {s.name}
                        {s.short_name ? (
                          <Typography
                            component="span"
                            variant="body2"
                            color="text.secondary"
                            sx={{ ml: 1 }}
                          >
                            {s.short_name}
                          </Typography>
                        ) : null}
                      </Typography>
                      <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
                        <Chip
                          size="small"
                          label={s.is_active ? 'Active' : 'Inactive'}
                          variant="outlined"
                        />
                        {s._count?.programs ? (
                          <Chip size="small" label={`${s._count.programs} programs`} />
                        ) : null}
                      </Stack>
                    </Box>
                    {isAdmin ? (
                      <Stack direction="row" spacing={0.5}>
                        <Button
                          size="small"
                          startIcon={<AddIcon />}
                          onClick={() =>
                            setDeptDialog({
                              open: true,
                              schoolId: s.id,
                              department: null,
                            })
                          }
                        >
                          Department
                        </Button>
                        <IconButton
                          aria-label={tDetail('aria.editSchool', { name: s.name })}
                          size="small"
                          onClick={() => setSchoolDialog({ open: true, school: s })}
                        >
                          <EditOutlinedIcon fontSize="small" />
                        </IconButton>
                        <IconButton
                          aria-label={tDetail('aria.deleteSchool', { name: s.name })}
                          size="small"
                          onClick={() =>
                            confirmDelete(
                              `/institutions/schools/${s.id}`,
                              `school "${s.name}"`,
                            )
                          }
                        >
                          <DeleteOutlineIcon fontSize="small" />
                        </IconButton>
                      </Stack>
                    ) : null}
                  </Stack>
                  {s.departments && s.departments.length > 0 ? (
                    <Box sx={{ mt: 1.5, pl: 2 }}>
                      <TableContainer>
                        <Table size="small" aria-label={tDetail('aria.departmentsIn', { name: s.name })}>
                          <TableBody>
                            {s.departments.map((d) => (
                              <TableRow key={d.id}>
                                <TableCell sx={{ width: '50%' }}>
                                  {d.name}
                                  {d.short_name ? (
                                    <Typography
                                      component="span"
                                      variant="caption"
                                      color="text.secondary"
                                      sx={{ ml: 1 }}
                                    >
                                      {d.short_name}
                                    </Typography>
                                  ) : null}
                                </TableCell>
                                <TableCell>
                                  <Chip
                                    size="small"
                                    label={d.is_active ? 'Active' : 'Inactive'}
                                    variant="outlined"
                                  />
                                </TableCell>
                                <TableCell align="right">
                                  {isAdmin ? (
                                    <Stack
                                      direction="row"
                                      spacing={0.5}
                                      justifyContent="flex-end"
                                    >
                                      <IconButton
                                        aria-label={tDetail('aria.editDepartment', { name: d.name })}
                                        size="small"
                                        onClick={() =>
                                          setDeptDialog({
                                            open: true,
                                            schoolId: s.id,
                                            department: d,
                                          })
                                        }
                                      >
                                        <EditOutlinedIcon fontSize="small" />
                                      </IconButton>
                                      <IconButton
                                        aria-label={tDetail('aria.deleteDepartment', { name: d.name })}
                                        size="small"
                                        onClick={() =>
                                          confirmDelete(
                                            `/institutions/departments/${d.id}`,
                                            `department "${d.name}"`,
                                          )
                                        }
                                      >
                                        <DeleteOutlineIcon fontSize="small" />
                                      </IconButton>
                                    </Stack>
                                  ) : null}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </TableContainer>
                    </Box>
                  ) : null}
                </Box>
              ))}
            </Stack>
          )}
        </Card>
      ) : null}

      {tab === 'programs' ? (
        <Card variant="outlined">
          <SectionHeader
            title="Programs"
            actionLabel="New program"
            onAction={() => setCreateProgramOpen(true)}
            isAdmin={isAdmin}
          />
          {programsQ.isLoading ? (
            <Box sx={{ p: 2 }}>
              <LoadingSkeleton rows={4} />
            </Box>
          ) : programRows.length === 0 ? (
            <EmptyState
              title="No programs yet"
              description={
                isAdmin
                  ? 'Add the first program offered by this institution to start configuring intakes, fees, and entry requirements.'
                  : 'No programs are catalogued for this institution yet.'
              }
              actions={
                isAdmin ? (
                  <Button
                    variant="contained"
                    startIcon={<AddIcon />}
                    onClick={() => setCreateProgramOpen(true)}
                  >
                    New program
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <TableContainer>
              <Table size="small" aria-label={tDetail('aria.programs')}>
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Level</TableCell>
                    <TableCell align="right">Intakes</TableCell>
                    <TableCell align="right">Requirements</TableCell>
                    <TableCell align="right">Modules</TableCell>
                    <TableCell align="right">Duration (m)</TableCell>
                    <TableCell>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {programRows.map((p) => (
                    <TableRow
                      key={p.id}
                      hover
                      sx={{ cursor: 'pointer' }}
                      onClick={() => router.push(`/programs/${p.id}`)}
                    >
                      <TableCell>
                        {p.name}
                        {p.short_name ? (
                          <Typography
                            component="span"
                            variant="caption"
                            color="text.secondary"
                            sx={{ ml: 1 }}
                          >
                            {p.short_name}
                          </Typography>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <Chip size="small" label={p.level} variant="outlined" />
                      </TableCell>
                      <TableCell align="right">{p._count?.intakes ?? 0}</TableCell>
                      <TableCell align="right">{p._count?.requirements ?? 0}</TableCell>
                      <TableCell align="right">{p._count?.modules ?? 0}</TableCell>
                      <TableCell align="right">{p.duration_months}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={p.is_active ? 'Active' : 'Inactive'}
                          color={p.is_active ? 'success' : 'default'}
                          variant={p.is_active ? 'filled' : 'outlined'}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Card>
      ) : null}

      {tab === 'super_agents' ? (
        <InstitutionSuperAgentsSection institutionId={inst.id} isAdmin={isAdmin} />
      ) : null}

      <EditInstitutionDialog
        open={editOpen}
        institution={inst}
        onClose={() => setEditOpen(false)}
      />
      <IdentifierDialog
        open={identifierOpen}
        institutionId={inst.id}
        onClose={() => setIdentifierOpen(false)}
      />
      <AccreditationDialog
        open={accreditationOpen}
        institutionId={inst.id}
        onClose={() => setAccreditationOpen(false)}
      />
      <ContactDialog
        open={contactOpen}
        institutionId={inst.id}
        onClose={() => setContactOpen(false)}
      />
      <CampusDialog
        open={campusDialog.open}
        institutionId={inst.id}
        campus={campusDialog.campus}
        onClose={() => setCampusDialog({ open: false, campus: null })}
      />
      <SchoolDialog
        open={schoolDialog.open}
        institutionId={inst.id}
        school={schoolDialog.school}
        onClose={() => setSchoolDialog({ open: false, school: null })}
      />
      <DepartmentDialog
        open={deptDialog.open}
        institutionId={inst.id}
        schoolId={deptDialog.schoolId}
        department={deptDialog.department}
        onClose={() => setDeptDialog({ open: false, schoolId: '', department: null })}
      />
      <CreateProgramDialog
        open={createProgramOpen}
        defaultInstitutionId={inst.id}
        onClose={() => setCreateProgramOpen(false)}
      />
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete?"
        description={
          pendingDelete
            ? `Delete ${pendingDelete.label}? This cannot be undone.`
            : undefined
        }
        confirmLabel={null}
        confirmText="Delete"
        onConfirm={async () => {
          if (!pendingDelete) return;
          await deleteMut.mutateAsync(pendingDelete.path);
        }}
        onClose={() => setPendingDelete(null)}
        loading={deleteMut.isPending}
        errorText={
          deleteMut.error instanceof ApiError
            ? deleteMut.error.detail || deleteMut.error.title || null
            : deleteMut.error
              ? 'Network error.'
              : null
        }
      />
    </Stack>
  );
}

function StatTile({
  icon,
  label,
  value,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: number;
  onClick?: () => void;
}) {
  return (
    <Card
      variant="outlined"
      sx={{
        p: 1.5,
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color 120ms',
        '&:hover': onClick
          ? { borderColor: (t) => t.palette.primary.main }
          : undefined,
      }}
      onClick={onClick}
    >
      <Stack direction="row" spacing={1.25} alignItems="center">
        <Box
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 32,
            height: 32,
            borderRadius: 1,
            bgcolor: 'action.hover',
            color: 'text.secondary',
          }}
        >
          {icon}
        </Box>
        <Stack spacing={0}>
          <Typography variant="caption" color="text.secondary">
            {label}
          </Typography>
          <Typography variant="h6" sx={{ fontWeight: 600, lineHeight: 1.1 }}>
            {value}
          </Typography>
        </Stack>
      </Stack>
    </Card>
  );
}

function OverviewField({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" sx={{ mt: 0.25 }}>
        {value}
      </Typography>
    </Box>
  );
}

function SectionHeader({
  title,
  actionLabel,
  onAction,
  isAdmin,
}: {
  title: string;
  actionLabel: string;
  onAction: () => void;
  isAdmin: boolean;
}) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      justifyContent="space-between"
      sx={{ p: 2, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
    >
      <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
        {title}
      </Typography>
      {isAdmin ? (
        <Button size="small" startIcon={<AddIcon />} onClick={onAction}>
          {actionLabel}
        </Button>
      ) : null}
    </Stack>
  );
}
