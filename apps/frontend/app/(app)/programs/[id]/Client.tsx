'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
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
import PriceChangeOutlinedIcon from '@mui/icons-material/PriceChangeOutlined';
import EventAvailableOutlinedIcon from '@mui/icons-material/EventAvailableOutlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { safeHref } from '@/lib/safeHref';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import ErrorState from '@/components/ErrorState';
import EmptyState from '@/components/EmptyState';
import ConfirmDialog from '@/components/ConfirmDialog';
import EditProgramDialog from '@/features/programs/EditProgramDialog';
import IntakeDialog from '@/features/programs/IntakeDialog';
import FeeListDialog from '@/features/programs/FeeListDialog';
import RequirementDialog from '@/features/programs/RequirementDialog';
import ModuleDialog from '@/features/programs/ModuleDialog';
import {
  ACADEMIC_LEVELS,
  DURATION_PATTERNS,
  type DurationPattern,
  type ProgramDetail,
  type ProgramIntakeRow,
  type ProgramModuleRow,
  type ProgramRequirementRow,
} from '@/features/programs/types';
import EventRepeatOutlinedIcon from '@mui/icons-material/EventRepeatOutlined';

function levelLabel(l: string): string {
  return ACADEMIC_LEVELS.find((x) => x.value === l)?.label ?? l;
}

function patternLabel(p: DurationPattern | null | undefined): string | null {
  if (!p) return null;
  return DURATION_PATTERNS.find((x) => x.value === p)?.label ?? p;
}

export default function ProgramDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const tDetail = useTranslations('programs.detail');

  const [tab, setTab] = useState<'overview' | 'intakes' | 'requirements' | 'modules'>(
    'overview',
  );
  const [editOpen, setEditOpen] = useState(false);
  const [intakeDialog, setIntakeDialog] = useState<{
    open: boolean;
    intake: ProgramIntakeRow | null;
    cloneFrom: ProgramIntakeRow | null;
  }>({ open: false, intake: null, cloneFrom: null });
  const [feeDialog, setFeeDialog] = useState<{
    open: boolean;
    intakeId: string;
    intakeLabel: string;
  }>({ open: false, intakeId: '', intakeLabel: '' });
  const [reqDialog, setReqDialog] = useState<{
    open: boolean;
    requirement: ProgramRequirementRow | null;
  }>({ open: false, requirement: null });
  const [moduleDialog, setModuleDialog] = useState<{
    open: boolean;
    module: ProgramModuleRow | null;
  }>({ open: false, module: null });
  const [pendingDelete, setPendingDelete] = useState<{ path: string; label: string } | null>(
    null,
  );

  const detailQ = useQuery({
    queryKey: ['programs', 'detail', id],
    enabled: Boolean(id),
    queryFn: async () => {
      const res = await api.get<ProgramDetail>(`/programs/${id}`);
      return res.data;
    },
  });

  const prog = detailQ.data ?? null;

  const deleteMut = useMutation({
    mutationFn: async (path: string) => {
      await api.delete(path);
    },
    onSuccess: () => {
      enqueueSnackbar('Removed.', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['programs', 'detail', id] });
      setPendingDelete(null);
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) {
        enqueueSnackbar(err.detail || err.title || 'Failed to delete.', { variant: 'error' });
      } else {
        enqueueSnackbar('Network error.', { variant: 'error' });
      }
    },
  });

  function confirmDelete(path: string, label: string) {
    if (!isAdmin) return;
    setPendingDelete({ path, label });
  }

  if (detailQ.isLoading) return <LoadingSkeleton variant="page" />;
  if (detailQ.isError || !prog) {
    return <ErrorState onRetry={() => void detailQ.refetch()} />;
  }

  return (
    <Stack spacing={3}>
      <Stack spacing={1}>
        <Breadcrumbs separator="›">
          {/* SVT-QA-2026-08 — breadcrumb label standardised to "Courses"
              to match the sidebar + page heading + browser tab. */}
          <Link href="/programs" style={{ color: 'inherit', textDecoration: 'none' }}>
            <Stack direction="row" alignItems="center" spacing={0.5}>
              <ArrowBackIosNewIcon fontSize="inherit" />
              <Typography variant="body2">Courses</Typography>
            </Stack>
          </Link>
          {prog.institution ? (
            <Link
              href={`/institutions/${prog.institution.id}`}
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              <Typography variant="body2">{prog.institution.display_name}</Typography>
            </Link>
          ) : null}
          <Typography variant="body2" color="text.secondary">
            {prog.name}
          </Typography>
        </Breadcrumbs>
        <Stack
          direction={{ xs: 'column', md: 'row' }}
          spacing={2}
          alignItems={{ md: 'center' }}
          justifyContent="space-between"
        >
          <Box>
            <Stack direction="row" spacing={1} alignItems="baseline">
              <Typography variant="h4" sx={{ fontWeight: 600 }}>
                {prog.name}
              </Typography>
              {prog.code ? (
                <Typography
                  variant="body2"
                  color="text.secondary"
                  sx={{ fontFamily: 'monospace' }}
                >
                  {prog.code}
                </Typography>
              ) : null}
            </Stack>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center" flexWrap="wrap" useFlexGap>
              {prog.short_name ? (
                <Typography variant="body2" color="text.secondary">
                  {prog.short_name}
                </Typography>
              ) : null}
              <Chip size="small" label={levelLabel(prog.level)} variant="outlined" />
              {prog.duration_pattern ? (
                <Chip
                  size="small"
                  label={patternLabel(prog.duration_pattern) ?? prog.duration_pattern}
                  variant="outlined"
                  color="info"
                />
              ) : null}
              <Chip size="small" label={prog.delivery_mode} variant="outlined" />
              {prog.institution ? (
                <Link
                  href={`/institutions/${prog.institution.id}`}
                  style={{ textDecoration: 'none' }}
                >
                  <Chip
                    size="small"
                    clickable
                    label={`${prog.institution.display_name} · ${prog.institution.country_code}`}
                  />
                </Link>
              ) : null}
              <Chip
                size="small"
                label={prog.is_active ? 'Active' : 'Inactive'}
                color={prog.is_active ? 'success' : 'default'}
              />
            </Stack>
          </Box>
          {isAdmin ? (
            <Stack direction="row" spacing={1}>
              <Button
                variant="contained"
                size="small"
                startIcon={<AddIcon />}
                onClick={() =>
                  setIntakeDialog({ open: true, intake: null, cloneFrom: null })
                }
              >
                Add intake
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
          gridTemplateColumns: { xs: '1fr 1fr', sm: 'repeat(5, 1fr)' },
        }}
      >
        <StatTile
          icon={<EventAvailableOutlinedIcon fontSize="small" />}
          label="Open intakes"
          value={prog.intakes.filter((i) => i.is_open).length}
          onClick={() => setTab('intakes')}
        />
        <StatTile
          icon={<PriceChangeOutlinedIcon fontSize="small" />}
          label="Fees configured"
          value={prog.intakes.reduce((sum, i) => sum + (i.fees?.length ?? 0), 0)}
          onClick={() => setTab('intakes')}
        />
        <StatTile
          icon={<RuleOutlinedIcon fontSize="small" />}
          label="Requirements"
          value={prog.requirements.length}
          onClick={() => setTab('requirements')}
        />
        <StatTile
          icon={<MenuBookOutlinedIcon fontSize="small" />}
          label="Modules"
          value={prog.modules.length}
          onClick={() => setTab('modules')}
        />
        <StatTile
          icon={<EventRepeatOutlinedIcon fontSize="small" />}
          label="Pattern"
          value={patternLabel(prog.duration_pattern) ?? '—'}
        />
      </Box>

      <Tabs
        value={tab}
        onChange={(_, v) => setTab(v)}
        sx={{ borderBottom: (t) => `1px solid ${t.palette.divider}` }}
      >
        <Tab value="overview" label="Overview" />
        <Tab value="intakes" label={`Intakes (${prog.intakes.length})`} />
        <Tab value="requirements" label={`Requirements (${prog.requirements.length})`} />
        <Tab value="modules" label={`Modules (${prog.modules.length})`} />
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
            <OverviewField label="Code" value={prog.code ?? '—'} />
            <OverviewField label="Name" value={prog.name} />
            <OverviewField label="Level" value={levelLabel(prog.level)} />
            <OverviewField label="Field of study" value={prog.field_of_study ?? '—'} />
            <OverviewField label="ISCED-F" value={prog.isced_code ?? '—'} />
            <OverviewField label="Delivery" value={prog.delivery_mode} />
            <OverviewField label="Language" value={prog.language_of_instruction} />
            <OverviewField label="Duration" value={`${prog.duration_months} months`} />
            <OverviewField label="Credit hours" value={prog.credit_hours ?? '—'} />
            <OverviewField label="School" value={prog.school?.name ?? '—'} />
            <OverviewField label="Department" value={prog.department?.name ?? '—'} />
            <OverviewField
              label="URL"
              value={
                prog.url ? (
                  // SVT-SEC-P1-FE1-2026-05 — scheme-allowlist before href to
                  // neutralise javascript:/data:/vbscript: XSS from legacy rows.
                  <a href={safeHref(prog.url)} target="_blank" rel="noreferrer">
                    {prog.url}
                    <OpenInNewIcon sx={{ fontSize: 12, ml: 0.5 }} />
                  </a>
                ) : (
                  '—'
                )
              }
            />
          </Box>
          {prog.description ? (
            <Box sx={{ mt: 3 }}>
              <Typography variant="caption" color="text.secondary">
                Description
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.5, whiteSpace: 'pre-wrap' }}>
                {prog.description}
              </Typography>
            </Box>
          ) : null}
        </Card>
      ) : null}

      {tab === 'intakes' ? (
        <Card variant="outlined">
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ p: 2, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
          >
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Intakes
            </Typography>
            {isAdmin ? (
              <Stack direction="row" spacing={1}>
                {prog.intakes.length > 0 ? (
                  <Tooltip title="Pre-fills a new intake form using the most recent intake's dates +1 year. Review before saving.">
                    <Button
                      size="small"
                      variant="outlined"
                      startIcon={<ContentCopyOutlinedIcon fontSize="small" />}
                      onClick={() =>
                        setIntakeDialog({
                          open: true,
                          intake: null,
                          cloneFrom: prog.intakes[0] ?? null,
                        })
                      }
                    >
                      Clone latest
                    </Button>
                  </Tooltip>
                ) : null}
                <Button
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={() =>
                    setIntakeDialog({ open: true, intake: null, cloneFrom: null })
                  }
                >
                  Add intake
                </Button>
              </Stack>
            ) : null}
          </Stack>
          {prog.intakes.length === 0 ? (
            <EmptyState
              title="No intakes yet"
              description={
                isAdmin
                  ? 'Add the first intake to start tracking applications, fees, and capacity.'
                  : 'No intakes have been scheduled yet.'
              }
            />
          ) : (
            <TableContainer>
              <Table size="small" aria-label={tDetail('aria.intakes')}>
                <TableHead>
                  <TableRow>
                    <TableCell>Label</TableCell>
                    <TableCell>Year/Month</TableCell>
                    <TableCell>Applications</TableCell>
                    <TableCell>Classes</TableCell>
                    <TableCell align="right">Capacity</TableCell>
                    <TableCell>Status</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {prog.intakes.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.intake_label}</TableCell>
                      <TableCell>
                        {row.intake_year}-
                        {String(row.intake_month).padStart(2, '0')}
                      </TableCell>
                      <TableCell>
                        {row.application_open ? row.application_open.slice(0, 10) : '—'}
                        {row.application_close
                          ? ` → ${row.application_close.slice(0, 10)}`
                          : ''}
                      </TableCell>
                      <TableCell>
                        {row.classes_start_on ? row.classes_start_on.slice(0, 10) : '—'}
                        {row.classes_end_on
                          ? ` → ${row.classes_end_on.slice(0, 10)}`
                          : ''}
                      </TableCell>
                      <TableCell align="right">{row.capacity ?? '—'}</TableCell>
                      <TableCell>
                        <Chip
                          size="small"
                          label={row.is_open ? 'Open' : 'Closed'}
                          color={row.is_open ? 'success' : 'default'}
                          variant={row.is_open ? 'filled' : 'outlined'}
                        />
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                          <Tooltip title="Manage fees">
                            <Button
                              size="small"
                              variant="outlined"
                              startIcon={<PriceChangeOutlinedIcon fontSize="small" />}
                              onClick={() =>
                                setFeeDialog({
                                  open: true,
                                  intakeId: row.id,
                                  intakeLabel: `${row.intake_label} · ${row.intake_year}-${String(row.intake_month).padStart(2, '0')}`,
                                })
                              }
                            >
                              Fees
                              {row.fees && row.fees.length > 0
                                ? ` (${row.fees.length})`
                                : ''}
                            </Button>
                          </Tooltip>
                          {isAdmin ? (
                            <>
                              <IconButton
                                aria-label={tDetail('aria.editIntake', { label: row.intake_label })}
                                size="small"
                                onClick={() =>
                                  setIntakeDialog({ open: true, intake: row, cloneFrom: null })
                                }
                              >
                                <EditOutlinedIcon fontSize="small" />
                              </IconButton>
                              <IconButton
                                aria-label={tDetail('aria.deleteIntake', { label: row.intake_label })}
                                size="small"
                                onClick={() =>
                                  confirmDelete(
                                    `/programs/intakes/${row.id}`,
                                    `intake "${row.intake_label}"`,
                                  )
                                }
                              >
                                <DeleteOutlineIcon fontSize="small" />
                              </IconButton>
                            </>
                          ) : null}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Card>
      ) : null}

      {tab === 'requirements' ? (
        <Card variant="outlined">
          <SectionHeader
            title="Requirements"
            actionLabel="Add requirement"
            onAction={() => setReqDialog({ open: true, requirement: null })}
            isAdmin={isAdmin}
          />
          {prog.requirements.length === 0 ? (
            <EmptyState title="No requirements yet" />
          ) : (
            <TableContainer>
              <Table size="small" aria-label={tDetail('aria.requirements')}>
                <TableHead>
                  <TableRow>
                    <TableCell>Category</TableCell>
                    <TableCell>Label</TableCell>
                    <TableCell>Details</TableCell>
                    <TableCell align="right">Min value</TableCell>
                    <TableCell>Mandatory</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {prog.requirements.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>
                        <Chip size="small" label={row.category} variant="outlined" />
                      </TableCell>
                      <TableCell>{row.label}</TableCell>
                      <TableCell>
                        <Typography
                          variant="body2"
                          sx={{
                            maxWidth: 280,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                          title={row.details ?? undefined}
                        >
                          {row.details ?? '—'}
                        </Typography>
                      </TableCell>
                      <TableCell align="right">
                        {row.min_value
                          ? `${row.min_value}${row.unit ? ` ${row.unit}` : ''}`
                          : '—'}
                      </TableCell>
                      <TableCell>
                        {row.is_mandatory ? (
                          <Chip size="small" label="Mandatory" color="primary" />
                        ) : (
                          <Chip size="small" label="Optional" variant="outlined" />
                        )}
                      </TableCell>
                      <TableCell align="right">
                        {isAdmin ? (
                          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                            <IconButton
                              aria-label={tDetail('aria.editRequirement', { label: row.label })}
                              size="small"
                              onClick={() =>
                                setReqDialog({ open: true, requirement: row })
                              }
                            >
                              <EditOutlinedIcon fontSize="small" />
                            </IconButton>
                            <IconButton
                              aria-label={tDetail('aria.deleteRequirement', { label: row.label })}
                              size="small"
                              onClick={() =>
                                confirmDelete(
                                  `/programs/requirements/${row.id}`,
                                  `requirement "${row.label}"`,
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

      {tab === 'modules' ? (
        <Card variant="outlined">
          <SectionHeader
            title="Modules"
            actionLabel="Add module"
            onAction={() => setModuleDialog({ open: true, module: null })}
            isAdmin={isAdmin}
          />
          {prog.modules.length === 0 ? (
            <EmptyState title="No modules yet" />
          ) : (
            <TableContainer>
              <Table size="small" aria-label={tDetail('aria.modules')}>
                <TableHead>
                  <TableRow>
                    <TableCell>Code</TableCell>
                    <TableCell>Title</TableCell>
                    <TableCell align="right">Credits</TableCell>
                    <TableCell align="right">Semester</TableCell>
                    <TableCell>Type</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {prog.modules.map((row) => (
                    <TableRow key={row.id}>
                      <TableCell>{row.code}</TableCell>
                      <TableCell>{row.title}</TableCell>
                      <TableCell align="right">{row.credits ?? '—'}</TableCell>
                      <TableCell align="right">{row.semester ?? '—'}</TableCell>
                      <TableCell>
                        {row.is_core ? (
                          <Chip size="small" label="Core" color="primary" />
                        ) : (
                          <Chip size="small" label="Elective" variant="outlined" />
                        )}
                      </TableCell>
                      <TableCell align="right">
                        {isAdmin ? (
                          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                            <IconButton
                              aria-label={tDetail('aria.editModule', { code: row.code })}
                              size="small"
                              onClick={() =>
                                setModuleDialog({ open: true, module: row })
                              }
                            >
                              <EditOutlinedIcon fontSize="small" />
                            </IconButton>
                            <IconButton
                              aria-label={tDetail('aria.deleteModule', { code: row.code })}
                              size="small"
                              onClick={() =>
                                confirmDelete(
                                  `/programs/modules/${row.id}`,
                                  `module "${row.code}"`,
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

      <EditProgramDialog
        open={editOpen}
        program={prog}
        onClose={() => setEditOpen(false)}
      />
      <IntakeDialog
        open={intakeDialog.open}
        programId={prog.id}
        intake={intakeDialog.intake}
        cloneFrom={intakeDialog.cloneFrom}
        program={prog}
        onClose={() => setIntakeDialog({ open: false, intake: null, cloneFrom: null })}
      />
      <FeeListDialog
        open={feeDialog.open}
        intakeId={feeDialog.intakeId}
        intakeLabel={feeDialog.intakeLabel}
        isAdmin={isAdmin}
        onClose={() => setFeeDialog({ open: false, intakeId: '', intakeLabel: '' })}
      />
      <RequirementDialog
        open={reqDialog.open}
        programId={prog.id}
        requirement={reqDialog.requirement}
        onClose={() => setReqDialog({ open: false, requirement: null })}
      />
      <ModuleDialog
        open={moduleDialog.open}
        programId={prog.id}
        module={moduleDialog.module}
        onClose={() => setModuleDialog({ open: false, module: null })}
      />
      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title="Delete?"
        description={
          pendingDelete ? `Delete ${pendingDelete.label}? This cannot be undone.` : undefined
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

function StatTile({
  icon,
  label,
  value,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | string;
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
          <Typography
            variant={typeof value === 'number' ? 'h6' : 'subtitle2'}
            sx={{
              fontWeight: 600,
              lineHeight: 1.2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={typeof value === 'string' ? value : undefined}
          >
            {value}
          </Typography>
        </Stack>
      </Stack>
    </Card>
  );
}
