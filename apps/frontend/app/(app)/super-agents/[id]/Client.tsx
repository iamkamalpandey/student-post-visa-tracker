'use client';

// Super-agent detail page. Identity card + status chip + FSM actions on
// Overview; CRUD tabs for Contacts, Commission rules, Linked institutions;
// and a Performance tab reading the metrics endpoint.
//
// All mutations carry If-Match on PATCH and Idempotency-Key on POST via the
// shared `api` client; backend writes the audit row.

import { useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import NextLink from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
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
import AddIcon from '@mui/icons-material/Add';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import PauseCircleOutlineIcon from '@mui/icons-material/PauseCircleOutline';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import HighlightOffOutlinedIcon from '@mui/icons-material/HighlightOffOutlined';
import StarIcon from '@mui/icons-material/Star';
import StarOutlineIcon from '@mui/icons-material/StarOutline';
import LinkOffIcon from '@mui/icons-material/LinkOff';
import OpenInNewOutlinedIcon from '@mui/icons-material/OpenInNewOutlined';

import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import ConfirmDialog from '@/components/ConfirmDialog';
import EmptyState from '@/components/EmptyState';
import ErrorState from '@/components/ErrorState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import SuperAgentContactDialog, {
  type SuperAgentContactRow,
} from '@/features/super-agents/SuperAgentContactDialog';
import SuperAgentCommissionRuleDialog, {
  type SuperAgentCommissionRuleRow,
} from '@/features/super-agents/SuperAgentCommissionRuleDialog';
import LinkInstitutionDialog from '@/features/super-agents/LinkInstitutionDialog';
import { formatPhone } from '@/lib/format';
import { safeHref } from '@/lib/safeHref';

type SuperAgentDetail = {
  id: string;
  name: string;
  short_name: string | null;
  legal_name: string | null;
  country_code: string | null;
  website: string | null;
  status: 'ACTIVE' | 'PAUSED' | 'TERMINATED';
  is_active: boolean;
  default_commission_pct: string | number | null;
  default_currency: string | null;
  payment_terms_days: number | null;
  notes: string | null;
  version: number;
  type?: { id: string; key: string; label: string } | null;
  sub_processor?: { id: string; name: string } | null;
};

type Metrics = {
  super_agent_id: string;
  enrollments_total: number;
  enrollments_by_status: Record<string, number>;
  commissions_by_currency: Record<string, string>;
  linked_institutions: number;
};

// /super-agents/:id/institutions row (inverse list).
type LinkedInstitutionRow = {
  id: string;
  super_agent_id: string;
  institution_id: string;
  is_preferred: boolean;
  notes: string | null;
  institution?: {
    id: string;
    display_name: string;
    legal_name?: string | null;
    short_name?: string | null;
    country_code?: string | null;
    type?: string | null;
    commission_pct?: string | null;
  };
};

type ApiList<T> = { data: T[] };

const TABS = ['Overview', 'Contacts', 'Commission rules', 'Linked institutions', 'Performance'] as const;

function statusColor(s: SuperAgentDetail['status']): 'success' | 'warning' | 'default' {
  if (s === 'ACTIVE') return 'success';
  if (s === 'PAUSED') return 'warning';
  return 'default';
}

export default function SuperAgentDetailClient() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [tab, setTab] = useState(0);

  // ---- queries ------------------------------------------------------------
  const detailQ = useQuery({
    queryKey: ['super-agent', id],
    queryFn: async () => {
      const res = await api.get<SuperAgentDetail>(`/super-agents/${id}`);
      return res.data;
    },
    enabled: Boolean(id),
  });

  const metricsQ = useQuery({
    queryKey: ['super-agent-metrics', id],
    queryFn: async () => {
      const res = await api.get<Metrics>(`/super-agents/${id}/metrics`);
      return res.data;
    },
    // Always load — drives both the Performance tab and the "Linked
    // institutions" count chip on the header. Cheap groupBy, well-bounded.
    enabled: Boolean(id),
  });

  const contactsQ = useQuery({
    queryKey: ['super-agent', id, 'contacts'],
    queryFn: async () => {
      const res = await api.get<ApiList<SuperAgentContactRow>>(
        `/super-agents/${id}/contacts`,
      );
      return res.data.data;
    },
    enabled: Boolean(id) && tab === 1,
  });

  const rulesQ = useQuery({
    queryKey: ['super-agent', id, 'commission-rules'],
    queryFn: async () => {
      const res = await api.get<ApiList<SuperAgentCommissionRuleRow>>(
        `/super-agents/${id}/commission-rules`,
      );
      return res.data.data;
    },
    enabled: Boolean(id) && tab === 2,
  });

  const linksQ = useQuery({
    queryKey: ['super-agent', id, 'institutions'],
    queryFn: async () => {
      const res = await api.get<ApiList<LinkedInstitutionRow>>(
        `/super-agents/${id}/institutions`,
      );
      return res.data.data;
    },
    enabled: Boolean(id) && tab === 3,
  });

  // ---- dialog state -------------------------------------------------------
  const [contactDlg, setContactDlg] = useState<{ open: boolean; row: SuperAgentContactRow | null }>({
    open: false,
    row: null,
  });
  const [contactDelete, setContactDelete] = useState<SuperAgentContactRow | null>(null);
  const [ruleDlg, setRuleDlg] = useState<{ open: boolean; row: SuperAgentCommissionRuleRow | null }>(
    { open: false, row: null },
  );
  const [ruleDelete, setRuleDelete] = useState<SuperAgentCommissionRuleRow | null>(null);
  const [linkDlg, setLinkDlg] = useState(false);
  const [unlinkTarget, setUnlinkTarget] = useState<LinkedInstitutionRow | null>(null);
  const [fsmDlg, setFsmDlg] = useState<null | 'PAUSE' | 'RESUME' | 'TERMINATE'>(null);
  const [terminateReason, setTerminateReason] = useState('');

  const sa = detailQ.data;

  // ---- FSM mutation -------------------------------------------------------
  // Single PATCH endpoint gates status changes through the backend FSM.
  // Pause/Resume don't require a reason; Terminate does.
  const fsmMutation = useMutation<unknown, ApiError, { action: 'PAUSE' | 'RESUME' | 'TERMINATE' }>({
    mutationFn: async ({ action }) => {
      if (!sa) throw new Error('No record loaded');
      const status =
        action === 'PAUSE' ? 'PAUSED' : action === 'RESUME' ? 'ACTIVE' : 'TERMINATED';
      const body: Record<string, unknown> = { status };
      if (action === 'TERMINATE') body['reason_code'] = terminateReason.trim();
      const res = await api.patch(`/super-agents/${sa.id}`, body, {
        headers: { 'If-Match': `"${sa.version}"` },
      });
      return res.data;
    },
    onSuccess: (_d, vars) => {
      const verb =
        vars.action === 'PAUSE'
          ? 'Paused'
          : vars.action === 'RESUME'
            ? 'Resumed'
            : 'Terminated';
      enqueueSnackbar(`Super-agent ${verb.toLowerCase()}`, { variant: 'success' });
      setFsmDlg(null);
      setTerminateReason('');
      void qc.invalidateQueries({ queryKey: ['super-agent', id] });
      void qc.invalidateQueries({ queryKey: ['super-agents'] });
    },
    onError: (err) => {
      enqueueSnackbar(err.detail || err.title || 'Could not change status', {
        variant: 'error',
      });
    },
  });

  // ---- contact delete -----------------------------------------------------
  const contactDeleteMutation = useMutation<void, ApiError, SuperAgentContactRow>({
    mutationFn: async (row) => {
      await api.delete(`/super-agents/${id}/contacts/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Contact removed', { variant: 'success' });
      setContactDelete(null);
      void qc.invalidateQueries({ queryKey: ['super-agent', id, 'contacts'] });
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title || 'Delete failed', { variant: 'error' }),
  });

  // ---- rule delete --------------------------------------------------------
  const ruleDeleteMutation = useMutation<void, ApiError, SuperAgentCommissionRuleRow>({
    mutationFn: async (row) => {
      await api.delete(`/super-agents/${id}/commission-rules/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Rule removed', { variant: 'success' });
      setRuleDelete(null);
      void qc.invalidateQueries({ queryKey: ['super-agent', id, 'commission-rules'] });
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title || 'Delete failed', { variant: 'error' }),
  });

  // ---- link mutations -----------------------------------------------------
  const togglePreferredMutation = useMutation<unknown, ApiError, LinkedInstitutionRow>({
    mutationFn: async (link) => {
      // PATCH /institutions/:id/super-agents/:linkId — flips is_preferred.
      const res = await api.patch(
        `/institutions/${link.institution_id}/super-agents/${link.id}`,
        { is_preferred: !link.is_preferred },
      );
      return res.data;
    },
    onSuccess: () => {
      enqueueSnackbar('Preferred channel updated', { variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['super-agent', id, 'institutions'] });
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title || 'Update failed', { variant: 'error' }),
  });

  const unlinkMutation = useMutation<void, ApiError, LinkedInstitutionRow>({
    mutationFn: async (link) => {
      await api.delete(`/institutions/${link.institution_id}/super-agents/${link.id}`);
    },
    onSuccess: (_d, link) => {
      enqueueSnackbar('Institution unlinked', { variant: 'success' });
      setUnlinkTarget(null);
      void qc.invalidateQueries({ queryKey: ['super-agent', id, 'institutions'] });
      void qc.invalidateQueries({ queryKey: ['super-agent-metrics', id] });
      void qc.invalidateQueries({ queryKey: ['institutions', link.institution_id, 'super-agents'] });
      void qc.invalidateQueries({ queryKey: ['institutions', 'detail', link.institution_id] });
      void qc.invalidateQueries({ queryKey: ['institutions', 'list'] });
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title || 'Unlink failed', { variant: 'error' }),
  });

  // ---- already-linked ids for the link dialog ----------------------------
  const linkedInstitutionIds = useMemo(
    () => new Set((linksQ.data ?? []).map((l) => l.institution_id)),
    [linksQ.data],
  );

  // ---- render guards ------------------------------------------------------
  if (detailQ.isLoading) return <LoadingSkeleton rows={6} />;
  if (detailQ.isError) {
    const err = detailQ.error instanceof ApiError ? detailQ.error : null;
    return (
      <ErrorState
        title="Couldn’t load super-agent"
        description={err?.detail ?? err?.title ?? 'Failed to load.'}
        requestId={err?.requestId}
        onRetry={() => void detailQ.refetch()}
      />
    );
  }
  if (!sa) return null;

  // ---- FSM derived state --------------------------------------------------
  const canPause = isAdmin && sa.status === 'ACTIVE';
  const canResume = isAdmin && sa.status === 'PAUSED';
  const canTerminate = isAdmin && sa.status !== 'TERMINATED';

  return (
    <Stack spacing={3}>
      {/* Hero header */}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
        <Stack spacing={0.5} sx={{ flex: 1 }}>
          <Typography variant="caption" color="text.secondary">
            <span
              role="link"
              tabIndex={0}
              onClick={() => router.push('/super-agents')}
              onKeyDown={(e) => {
                if (e.key === 'Enter') router.push('/super-agents');
              }}
              style={{ cursor: 'pointer', textDecoration: 'underline' }}
            >
              Super-agents
            </span>{' '}
            / {sa.name}
          </Typography>
          <Stack direction="row" alignItems="center" spacing={1.5}>
            <Typography variant="h4" sx={{ fontWeight: 700, letterSpacing: -0.3 }}>
              {sa.name}
            </Typography>
            <Chip size="small" label={sa.status} color={statusColor(sa.status)} variant="outlined" />
          </Stack>
          <Typography variant="body2" color="text.secondary">
            {sa.legal_name ?? sa.name} · {sa.type?.label ?? '—'}
            {sa.country_code ? ` · ${sa.country_code}` : ''}
          </Typography>
        </Stack>
      </Stack>

      {/* Identity card */}
      <Card variant="outlined">
        <CardContent>
          <Stack direction="row" spacing={3} flexWrap="wrap" useFlexGap>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Default commission
              </Typography>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>
                {sa.default_commission_pct != null ? `${sa.default_commission_pct}%` : '—'}
                {sa.default_currency ? ` · ${sa.default_currency}` : ''}
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Payment terms
              </Typography>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>
                {sa.payment_terms_days != null ? `${sa.payment_terms_days} days` : '—'}
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Sub-processor
              </Typography>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>
                {sa.sub_processor?.name ?? '—'}
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Linked institutions
              </Typography>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>
                {metricsQ.data ? metricsQ.data.linked_institutions : '—'}
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">
                Website
              </Typography>
              <Typography variant="body1" sx={{ fontWeight: 600 }}>
                {sa.website ? (
                  // SVT-SEC-P1-FE1-2026-05 — scheme-allowlist before href to
                  // neutralise javascript:/data:/vbscript: XSS from legacy rows.
                  <a href={safeHref(sa.website)} target="_blank" rel="noreferrer">
                    {sa.website.replace(/^https?:\/\//, '')}{' '}
                    <OpenInNewOutlinedIcon sx={{ fontSize: 12, ml: 0.25 }} />
                  </a>
                ) : (
                  '—'
                )}
              </Typography>
            </Box>
          </Stack>
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs value={tab} onChange={(_, v) => setTab(v as number)} variant="scrollable" scrollButtons="auto">
        {TABS.map((t) => (
          <Tab key={t} label={t} sx={{ minHeight: 48, textTransform: 'none', fontWeight: 600 }} />
        ))}
      </Tabs>

      {/* --- Overview tab --------------------------------------------------- */}
      {tab === 0 && (
        <Stack spacing={2}>
          <Card variant="outlined">
            <CardContent>
              <Stack
                direction={{ xs: 'column', md: 'row' }}
                spacing={2}
                alignItems={{ md: 'center' }}
                justifyContent="space-between"
              >
                <Stack spacing={0.25}>
                  <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                    Lifecycle
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Pause hides this super-agent from new enrolment picks. Terminate is permanent and requires a
                    reason for the audit log.
                  </Typography>
                </Stack>
                {isAdmin ? (
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    <Button
                      variant="outlined"
                      color="warning"
                      startIcon={<PauseCircleOutlineIcon />}
                      disabled={!canPause || fsmMutation.isPending}
                      onClick={() => setFsmDlg('PAUSE')}
                    >
                      Pause
                    </Button>
                    <Button
                      variant="outlined"
                      color="success"
                      startIcon={<PlayCircleOutlineIcon />}
                      disabled={!canResume || fsmMutation.isPending}
                      onClick={() => setFsmDlg('RESUME')}
                    >
                      Resume
                    </Button>
                    <Button
                      variant="outlined"
                      color="error"
                      startIcon={<HighlightOffOutlinedIcon />}
                      disabled={!canTerminate || fsmMutation.isPending}
                      onClick={() => setFsmDlg('TERMINATE')}
                    >
                      Terminate
                    </Button>
                  </Stack>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    Admins manage lifecycle changes.
                  </Typography>
                )}
              </Stack>
            </CardContent>
          </Card>

          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle1" sx={{ fontWeight: 700, mb: 1 }}>
                Notes
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ whiteSpace: 'pre-wrap' }}>
                {sa.notes ?? '—'}
              </Typography>
            </CardContent>
          </Card>
        </Stack>
      )}

      {/* --- Contacts tab -------------------------------------------------- */}
      {tab === 1 && (
        <Card variant="outlined">
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ p: 2, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
          >
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Contacts
            </Typography>
            {isAdmin ? (
              <Button
                size="small"
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => setContactDlg({ open: true, row: null })}
              >
                Add contact
              </Button>
            ) : null}
          </Stack>
          {contactsQ.isLoading ? (
            <Box sx={{ p: 2 }}>
              <LoadingSkeleton rows={3} />
            </Box>
          ) : contactsQ.isError ? (
            <Box sx={{ p: 2 }}>
              <ErrorState
                title="Could not load contacts"
                description={
                  contactsQ.error instanceof ApiError
                    ? contactsQ.error.detail || contactsQ.error.title
                    : 'Please try again.'
                }
                onRetry={() => void contactsQ.refetch()}
              />
            </Box>
          ) : (contactsQ.data ?? []).length === 0 ? (
            <EmptyState
              title="No contacts yet"
              description={
                isAdmin
                  ? 'Add the people you escalate to at this aggregator.'
                  : 'No contacts are recorded for this super-agent.'
              }
            />
          ) : (
            <TableContainer>
              <Table size="small" aria-label="Super-agent contacts">
                <TableHead>
                  <TableRow>
                    <TableCell>Name</TableCell>
                    <TableCell>Role</TableCell>
                    <TableCell>Email</TableCell>
                    <TableCell>Phone</TableCell>
                    <TableCell>Primary</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(contactsQ.data ?? []).map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>{c.name}</TableCell>
                      <TableCell>{c.role ?? '—'}</TableCell>
                      <TableCell>{c.email ?? '—'}</TableCell>
                      <TableCell>{formatPhone(c.phone_e164) || '—'}</TableCell>
                      <TableCell>
                        {c.is_primary ? <Chip size="small" color="primary" label="Primary" /> : '—'}
                      </TableCell>
                      <TableCell align="right">
                        {isAdmin ? (
                          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                            <Tooltip title="Edit">
                              <IconButton
                                size="small"
                                aria-label={`Edit ${c.name}`}
                                onClick={() => setContactDlg({ open: true, row: c })}
                              >
                                <EditOutlinedIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="Delete">
                              <IconButton
                                size="small"
                                aria-label={`Delete ${c.name}`}
                                onClick={() => setContactDelete(c)}
                              >
                                <DeleteOutlineIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Stack>
                        ) : (
                          <span aria-hidden>—</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Card>
      )}

      {/* --- Commission rules tab ----------------------------------------- */}
      {tab === 2 && (
        <Card variant="outlined">
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ p: 2, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
          >
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Commission rules
            </Typography>
            {isAdmin ? (
              <Button
                size="small"
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => setRuleDlg({ open: true, row: null })}
              >
                Add rule
              </Button>
            ) : null}
          </Stack>
          {rulesQ.isLoading ? (
            <Box sx={{ p: 2 }}>
              <LoadingSkeleton rows={3} />
            </Box>
          ) : rulesQ.isError ? (
            <Box sx={{ p: 2 }}>
              <ErrorState
                title="Could not load rules"
                description={
                  rulesQ.error instanceof ApiError
                    ? rulesQ.error.detail || rulesQ.error.title
                    : 'Please try again.'
                }
                onRetry={() => void rulesQ.refetch()}
              />
            </Box>
          ) : (rulesQ.data ?? []).length === 0 ? (
            <EmptyState
              title="No commission rules"
              description={
                isAdmin
                  ? "Defaults from the super-agent are used when no rule matches. Add a rule to override per institution, program-level, or effective window."
                  : 'No effective rules. The super-agent default rate applies.'
              }
            />
          ) : (
            <TableContainer>
              <Table size="small" aria-label="Commission rules">
                <TableHead>
                  <TableRow>
                    <TableCell>Scope</TableCell>
                    <TableCell align="right">Rate</TableCell>
                    <TableCell>Effective from</TableCell>
                    <TableCell>Effective to</TableCell>
                    <TableCell>Notes</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(rulesQ.data ?? []).map((r) => {
                    const scopeBits: string[] = [];
                    if (r.institution?.display_name) scopeBits.push(r.institution.display_name);
                    else if (r.institution_id) scopeBits.push('Institution-specific');
                    else scopeBits.push('All institutions');
                    if (r.program_level) scopeBits.push(r.program_level);
                    return (
                      <TableRow key={r.id}>
                        <TableCell>{scopeBits.join(' · ')}</TableCell>
                        <TableCell align="right">
                          {String(r.commission_pct)}% {r.currency}
                        </TableCell>
                        <TableCell>{r.effective_from.slice(0, 10)}</TableCell>
                        <TableCell>
                          {r.effective_to ? r.effective_to.slice(0, 10) : <Chip size="small" label="Open" />}
                        </TableCell>
                        <TableCell>
                          <Typography
                            variant="caption"
                            sx={{
                              maxWidth: 260,
                              display: 'inline-block',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              verticalAlign: 'middle',
                            }}
                            title={r.notes ?? undefined}
                          >
                            {r.notes ?? '—'}
                          </Typography>
                        </TableCell>
                        <TableCell align="right">
                          {isAdmin ? (
                            <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                              <Tooltip title="Edit">
                                <IconButton
                                  size="small"
                                  aria-label="Edit rule"
                                  onClick={() => setRuleDlg({ open: true, row: r })}
                                >
                                  <EditOutlinedIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title="Delete">
                                <IconButton
                                  size="small"
                                  aria-label="Delete rule"
                                  onClick={() => setRuleDelete(r)}
                                >
                                  <DeleteOutlineIcon fontSize="small" />
                                </IconButton>
                              </Tooltip>
                            </Stack>
                          ) : (
                            <span aria-hidden>—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Card>
      )}

      {/* --- Linked institutions tab -------------------------------------- */}
      {tab === 3 && (
        <Card variant="outlined">
          <Stack
            direction="row"
            alignItems="center"
            justifyContent="space-between"
            sx={{ p: 2, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
          >
            <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
              Linked institutions
            </Typography>
            {isAdmin ? (
              <Button
                size="small"
                variant="contained"
                startIcon={<AddIcon />}
                onClick={() => setLinkDlg(true)}
              >
                Link institution
              </Button>
            ) : null}
          </Stack>
          {linksQ.isLoading ? (
            <Box sx={{ p: 2 }}>
              <LoadingSkeleton rows={3} />
            </Box>
          ) : linksQ.isError ? (
            <Box sx={{ p: 2 }}>
              <ErrorState
                title="Could not load links"
                description={
                  linksQ.error instanceof ApiError
                    ? linksQ.error.detail || linksQ.error.title
                    : 'Please try again.'
                }
                onRetry={() => void linksQ.refetch()}
              />
            </Box>
          ) : (linksQ.data ?? []).length === 0 ? (
            <EmptyState
              title="No institutions linked"
              description={
                isAdmin
                  ? 'Link an institution to make this super-agent selectable for its enrolments.'
                  : 'No institutions reached through this super-agent yet.'
              }
            />
          ) : (
            <TableContainer>
              <Table size="small" aria-label="Linked institutions">
                <TableHead>
                  <TableRow>
                    <TableCell>Institution</TableCell>
                    <TableCell>Type</TableCell>
                    <TableCell>Country</TableCell>
                    <TableCell align="right">Default commission</TableCell>
                    <TableCell>Preferred</TableCell>
                    <TableCell align="right" />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(linksQ.data ?? []).map((l) => {
                    const inst = l.institution;
                    return (
                      <TableRow key={l.id} hover>
                        <TableCell>
                          {inst ? (
                            <NextLink
                              href={`/institutions/${inst.id}`}
                              style={{ color: 'inherit', textDecoration: 'underline' }}
                            >
                              {inst.display_name}
                            </NextLink>
                          ) : (
                            l.institution_id
                          )}
                        </TableCell>
                        <TableCell>{inst?.type ?? '—'}</TableCell>
                        <TableCell>{inst?.country_code ?? '—'}</TableCell>
                        <TableCell align="right">
                          {inst?.commission_pct != null ? `${inst.commission_pct}%` : '—'}
                        </TableCell>
                        <TableCell>
                          {isAdmin ? (
                            <Tooltip title={l.is_preferred ? 'Unmark preferred' : 'Mark as preferred'}>
                              <IconButton
                                size="small"
                                aria-label={
                                  l.is_preferred
                                    ? `Unmark ${inst?.display_name ?? 'institution'} preferred`
                                    : `Mark ${inst?.display_name ?? 'institution'} preferred`
                                }
                                onClick={() => togglePreferredMutation.mutate(l)}
                                disabled={togglePreferredMutation.isPending}
                              >
                                {l.is_preferred ? (
                                  <StarIcon fontSize="small" sx={{ color: 'warning.main' }} />
                                ) : (
                                  <StarOutlineIcon fontSize="small" />
                                )}
                              </IconButton>
                            </Tooltip>
                          ) : l.is_preferred ? (
                            <Chip size="small" color="warning" label="Preferred" />
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell align="right">
                          {isAdmin ? (
                            <Tooltip title="Unlink">
                              <IconButton
                                size="small"
                                aria-label={`Unlink ${inst?.display_name ?? 'institution'}`}
                                onClick={() => setUnlinkTarget(l)}
                              >
                                <LinkOffIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          ) : (
                            <span aria-hidden>—</span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Card>
      )}

      {/* --- Performance tab ---------------------------------------------- */}
      {tab === 4 && (
        <Card variant="outlined">
          <CardContent>
            {metricsQ.isLoading ? (
              <LoadingSkeleton rows={3} />
            ) : metricsQ.isError ? (
              <Typography color="error">Failed to load metrics.</Typography>
            ) : metricsQ.data ? (
              <Stack spacing={2}>
                <Stack direction="row" spacing={3}>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Total enrolments
                    </Typography>
                    <Typography variant="h5">{metricsQ.data.enrollments_total}</Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary">
                      Linked institutions
                    </Typography>
                    <Typography variant="h5">{metricsQ.data.linked_institutions}</Typography>
                  </Box>
                </Stack>
                <Box>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    By status
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    {Object.entries(metricsQ.data.enrollments_by_status).map(([k, v]) => (
                      <Chip key={k} size="small" label={`${k}: ${v}`} />
                    ))}
                  </Stack>
                </Box>
                <Box>
                  <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
                    Commission per currency (minor units)
                  </Typography>
                  <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                    {Object.entries(metricsQ.data.commissions_by_currency).map(([k, v]) => (
                      <Chip key={k} size="small" label={`${k}: ${v}`} />
                    ))}
                  </Stack>
                </Box>
              </Stack>
            ) : null}
          </CardContent>
        </Card>
      )}

      {/* Dialogs ---------------------------------------------------------- */}
      <SuperAgentContactDialog
        open={contactDlg.open}
        superAgentId={id}
        row={contactDlg.row}
        onClose={() => setContactDlg({ open: false, row: null })}
      />
      <ConfirmDialog
        open={contactDelete !== null}
        title="Remove contact?"
        description={
          contactDelete ? (
            <Typography variant="body2" color="text.secondary">
              Removes <strong>{contactDelete.name}</strong> from this super-agent. Past audit entries
              reference the contact by id and are preserved.
            </Typography>
          ) : null
        }
        confirmText="Remove"
        loading={contactDeleteMutation.isPending}
        onConfirm={() => {
          if (contactDelete) contactDeleteMutation.mutate(contactDelete);
        }}
        onClose={() => setContactDelete(null)}
      />

      <SuperAgentCommissionRuleDialog
        open={ruleDlg.open}
        superAgentId={id}
        existing={rulesQ.data ?? []}
        row={ruleDlg.row}
        onClose={() => setRuleDlg({ open: false, row: null })}
      />
      <ConfirmDialog
        open={ruleDelete !== null}
        title="Delete commission rule?"
        description={
          ruleDelete ? (
            <Typography variant="body2" color="text.secondary">
              The rule will no longer be considered by the resolver. Past commission claims that
              were sealed against this rule are not affected.
            </Typography>
          ) : null
        }
        confirmText="Delete"
        loading={ruleDeleteMutation.isPending}
        onConfirm={() => {
          if (ruleDelete) ruleDeleteMutation.mutate(ruleDelete);
        }}
        onClose={() => setRuleDelete(null)}
      />

      <LinkInstitutionDialog
        open={linkDlg}
        superAgentId={id}
        excludeIds={linkedInstitutionIds}
        onClose={() => setLinkDlg(false)}
      />
      <ConfirmDialog
        open={unlinkTarget !== null}
        title="Unlink institution"
        description={
          unlinkTarget ? (
            <Typography variant="body2" color="text.secondary">
              Removes this super-agent as a channel for{' '}
              <strong>{unlinkTarget.institution?.display_name ?? 'this institution'}</strong>. Past
              enrolments stay attributed; new ones can no longer pick this combination unless
              re-linked.
            </Typography>
          ) : null
        }
        confirmLabel={unlinkTarget?.institution?.display_name ?? null}
        confirmText="Unlink"
        loading={unlinkMutation.isPending}
        onConfirm={() => {
          if (unlinkTarget) unlinkMutation.mutate(unlinkTarget);
        }}
        onClose={() => setUnlinkTarget(null)}
      />

      {/* FSM action dialogs ----------------------------------------------- */}
      <ConfirmDialog
        open={fsmDlg === 'PAUSE'}
        title="Pause super-agent?"
        description={
          <Typography variant="body2" color="text.secondary">
            Counsellors will not be able to pick this super-agent for new enrolments while it is
            paused. Existing enrolments are unaffected. You can resume at any time.
          </Typography>
        }
        confirmText="Pause"
        destructive={false}
        loading={fsmMutation.isPending}
        onConfirm={() => fsmMutation.mutate({ action: 'PAUSE' })}
        onClose={() => setFsmDlg(null)}
      />
      <ConfirmDialog
        open={fsmDlg === 'RESUME'}
        title="Resume super-agent?"
        description={
          <Typography variant="body2" color="text.secondary">
            Counsellors will be able to pick this super-agent for new enrolments again.
          </Typography>
        }
        confirmText="Resume"
        destructive={false}
        loading={fsmMutation.isPending}
        onConfirm={() => fsmMutation.mutate({ action: 'RESUME' })}
        onClose={() => setFsmDlg(null)}
      />
      <ConfirmDialog
        open={fsmDlg === 'TERMINATE'}
        title="Terminate super-agent?"
        description={
          <Stack spacing={1.5}>
            <Typography variant="body2" color="text.secondary">
              Termination is permanent: this super-agent cannot be resumed. Past enrolments and
              commission claims remain attributed for historical reporting; new enrolments cannot
              select this agent.
            </Typography>
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                Reason (required, min 3 chars)
              </Typography>
              <Box
                component="textarea"
                rows={2}
                aria-label="Termination reason"
                value={terminateReason}
                onChange={(e) => setTerminateReason((e.target as HTMLTextAreaElement).value)}
                sx={{
                  width: '100%',
                  font: 'inherit',
                  padding: 1,
                  borderRadius: 1,
                  border: (t) => `1px solid ${t.palette.divider}`,
                  resize: 'vertical',
                }}
              />
            </Box>
          </Stack>
        }
        confirmLabel={sa.name}
        confirmText="Terminate"
        loading={fsmMutation.isPending}
        onConfirm={() => {
          if (terminateReason.trim().length < 3) {
            enqueueSnackbar('Reason must be at least 3 characters', { variant: 'warning' });
            return;
          }
          fsmMutation.mutate({ action: 'TERMINATE' });
        }}
        onClose={() => {
          setFsmDlg(null);
          setTerminateReason('');
        }}
      />

      {fsmMutation.isError ? (
        <Alert severity="error" variant="outlined">
          {fsmMutation.error.detail || fsmMutation.error.title || 'Status change failed.'}
        </Alert>
      ) : null}
    </Stack>
  );
}
