'use client';

import { useState, type ReactNode } from 'react';
import NextLink from 'next/link';
import { useRouter } from 'next/navigation';
import {
  Box, Button, Chip, Grid, Link as MuiLink, Paper, Stack, Tab, Tabs, Typography,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import AddOutlinedIcon from '@mui/icons-material/AddOutlined';
import PersonAddAlt1OutlinedIcon from '@mui/icons-material/PersonAddAlt1Outlined';
import { useSnackbar } from 'notistack';

import DataTable, { type DataTableColumn } from '@/components/DataTable';
import StatusChip from '@/components/StatusChip';
import ConfirmDialog from '@/components/ConfirmDialog';
import ErrorState from '@/components/ErrorState';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import { useAuth } from '@/lib/auth';
import { canWriteStudents, isAdmin } from '@/lib/auth-helpers';
import { todayLocalIso, useFormat } from '@/lib/format';
import { funnelColor, funnelLabel } from '@/lib/crm-funnel';
import { ApiError } from '@/lib/api';
import {
  useLead, useMarkLeadFeePaid, useWaiveLeadFee, useDeleteLeadFee,
  type CrmFeeRow, type CrmLeadDetail,
} from '@/lib/queries';
import AddFeeDialog from '@/features/crm-leads/AddFeeDialog';
import EditLeadDialog from '@/features/crm-leads/EditLeadDialog';
import ConvertToStudentDialog from '@/features/crm-leads/ConvertToStudentDialog';

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Grid item xs={12} sm={6} md={4}>
      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 500 }}>{children}</Typography>
    </Grid>
  );
}

type FeeAction = { kind: 'pay' | 'waive' | 'delete'; fee: CrmFeeRow } | null;

export default function DetailClient({ id }: { id: string }) {
  const router = useRouter();
  const { user } = useAuth();
  const fmt = useFormat();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = canWriteStudents(user?.role);
  const admin = isAdmin(user?.role);

  const { data: lead, isLoading, isError, refetch } = useLead(id);
  const [tab, setTab] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [addFeeOpen, setAddFeeOpen] = useState(false);
  const [feeAction, setFeeAction] = useState<FeeAction>(null);

  const markPaid = useMarkLeadFeePaid(id);
  const waive = useWaiveLeadFee(id);
  const del = useDeleteLeadFee(id);

  if (isLoading) return <LoadingSkeleton />;
  if (isError || !lead) return <ErrorState onRetry={() => void refetch()} />;

  const actionPending = markPaid.isPending || waive.isPending || del.isPending;
  const primaryState = lead.lead_courses.find((lc) => lc.state_v2 === 'visa_accepted')?.state_v2 ?? lead.lead_courses[0]?.state_v2 ?? null;

  function onFeeError(err: unknown, fallback: string) {
    enqueueSnackbar(err instanceof ApiError ? err.detail || err.title : fallback, { variant: 'error' });
  }
  function confirmFeeAction() {
    if (!feeAction) return;
    const { kind, fee } = feeAction;
    const close = () => setFeeAction(null);
    if (kind === 'pay') {
      // SVT-QA-2026-08 — LOCAL day for paid_on (not UTC); see lib/format.
      markPaid.mutate({ feeId: fee.id, paid_on: todayLocalIso() }, { onSuccess: () => { enqueueSnackbar('Fee marked paid.', { variant: 'success' }); close(); }, onError: (e) => onFeeError(e, 'Could not mark paid') });
    } else if (kind === 'waive') {
      waive.mutate({ feeId: fee.id }, { onSuccess: () => { enqueueSnackbar('Fee waived.', { variant: 'success' }); close(); }, onError: (e) => onFeeError(e, 'Could not waive') });
    } else {
      del.mutate({ feeId: fee.id }, { onSuccess: () => { enqueueSnackbar('Fee deleted.', { variant: 'success' }); close(); }, onError: (e) => onFeeError(e, 'Could not delete') });
    }
  }

  const feeColumns: DataTableColumn<CrmFeeRow>[] = [
    { key: 'session', label: 'Session', render: (f) => <Typography variant="body2" sx={{ fontWeight: 600 }}>{f.session_label}</Typography> },
    { key: 'amount', label: 'Amount', align: 'right', render: (f) => fmt.money(f.amount_minor, f.currency) },
    { key: 'due', label: 'Due', render: (f) => fmt.date(f.due_on) },
    { key: 'status', label: 'Status', render: (f) => <StatusChip status={f.status} /> },
    { key: 'source', label: 'Source', hideOnMobile: true, render: (f) => <Chip size="small" variant="outlined" label={f.seeded_from_v2 ? 'From V2' : 'Manual'} /> },
    {
      key: 'actions', label: '', align: 'right',
      render: (f) => canWrite ? (
        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
          {f.status !== 'PAID' && f.status !== 'WAIVED' ? (
            <>
              <Button size="small" onClick={() => setFeeAction({ kind: 'pay', fee: f })}>Mark paid</Button>
              <Button size="small" color="inherit" onClick={() => setFeeAction({ kind: 'waive', fee: f })}>Waive</Button>
            </>
          ) : null}
          <Button size="small" color="error" onClick={() => setFeeAction({ kind: 'delete', fee: f })}>Delete</Button>
        </Stack>
      ) : null,
    },
  ];

  const TABS = ['Profile', 'Applications', 'Status history', 'Activity', 'Qualifications', 'Payments', 'Fees'];

  return (
    <Stack spacing={2.5}>
      <MuiLink component={NextLink} href="/leads" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, fontSize: 14 }}>
        <ArrowBackOutlinedIcon fontSize="small" /> Leads
      </MuiLink>

      <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} spacing={1.5}>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
          <Typography variant="h5" sx={{ fontWeight: 700 }}>{lead.full_name}</Typography>
          <Chip size="small" color={funnelColor(primaryState)} variant={funnelColor(primaryState) === 'default' ? 'outlined' : 'filled'} label={funnelLabel(primaryState)} sx={{ fontWeight: 600 }} />
          <StatusChip status={lead.spv_status} />
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          {lead.student_id && lead.student ? (
            <Button component={NextLink} href={`/students/${lead.student_id}`} variant="outlined" color="success" startIcon={<PersonAddAlt1OutlinedIcon />}>
              View student {lead.student.student_code}
            </Button>
          ) : admin ? (
            <Button variant="outlined" color="secondary" startIcon={<PersonAddAlt1OutlinedIcon />} onClick={() => setConvertOpen(true)}>
              Convert to Student
            </Button>
          ) : null}
          {canWrite ? <Button variant="outlined" startIcon={<EditOutlinedIcon />} onClick={() => setEditOpen(true)}>Edit</Button> : null}
        </Stack>
      </Stack>

      <Paper variant="outlined" sx={{ borderRadius: 2 }}>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons="auto" sx={{ borderBottom: (t) => `1px solid ${t.palette.divider}`, px: 1 }}>
          {TABS.map((label) => <Tab key={label} label={label} sx={{ textTransform: 'none', fontWeight: 600 }} />)}
        </Tabs>

        <Box sx={{ p: 2.5 }}>
          {tab === 0 && (
            <Grid container spacing={2}>
              <InfoRow label="Email">{lead.email ?? '—'}</InfoRow>
              <InfoRow label="Phone">{lead.phone_number}</InfoRow>
              <InfoRow label="Secondary phone">{lead.secondary_number ?? '—'}</InfoRow>
              <InfoRow label="Gender">{lead.gender ?? '—'}</InfoRow>
              <InfoRow label="Date of birth">{lead.dob ?? '—'}</InfoRow>
              <InfoRow label="City">{lead.city ?? '—'}</InfoRow>
              <InfoRow label="Address">{lead.address ?? '—'}</InfoRow>
              <InfoRow label="Field of study">{lead.field_of_study ?? '—'}</InfoRow>
              <InfoRow label="Intake">{lead.intake_month ?? '—'}</InfoRow>
              <InfoRow label="Source">{lead.source ?? '—'}</InfoRow>
              <InfoRow label="Priority">{lead.priority ?? '—'}</InfoRow>
              <InfoRow label="V2 reference">{`lead ${lead.v2_lead_id}`}</InfoRow>
              <InfoRow label="Last synced">{lead.synced_at ? fmt.dateTime(lead.synced_at) : '—'}</InfoRow>
              {lead.spv_notes ? <Grid item xs={12}><Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>Notes</Typography><Typography variant="body2">{lead.spv_notes}</Typography></Grid> : null}
            </Grid>
          )}

          {tab === 1 && (
            <DataTable
              columns={[
                { key: 'course', label: 'Course', render: (a: CrmLeadDetail['applications'][number]) => a.course?.name ?? '—' },
                { key: 'institution', label: 'Institution', render: (a) => a.course?.institution?.name ?? '—' },
                { key: 'intake', label: 'Intake', render: (a) => a.intake_key },
                { key: 'state', label: 'State', render: (a) => <Chip size="small" variant="outlined" label={a.state} /> },
              ]}
              rows={lead.applications}
              getRowId={(a) => a.id}
              emptyTitle="No applications"
              ariaLabel="Applications"
            />
          )}

          {tab === 2 && (
            <DataTable
              columns={[
                { key: 'to', label: 'Stage', render: (h: CrmLeadDetail['course_history'][number]) => funnelLabel(h.to_state) },
                { key: 'from', label: 'From', hideOnMobile: true, render: (h) => (h.from_state ? funnelLabel(h.from_state) : '—') },
                { key: 'when', label: 'Changed', render: (h) => fmt.dateTime(h.changed_at) },
              ]}
              rows={lead.course_history}
              getRowId={(h) => h.id}
              emptyTitle="No status history"
              ariaLabel="Status history"
            />
          )}

          {tab === 3 && (
            <Stack spacing={3}>
              <ActivitySection title="Remarks" rows={lead.remarks} getId={(r) => r.id} columns={[{ key: 'content', label: 'Remark', render: (r: CrmLeadDetail['remarks'][number]) => r.content }, { key: 'when', label: 'When', render: (r) => (r.v2_created_at ? fmt.date(r.v2_created_at) : '—') }]} />
              <ActivitySection title="Follow-ups" rows={lead.follow_ups} getId={(r) => r.id} columns={[{ key: 'date', label: 'Date', render: (r: CrmLeadDetail['follow_ups'][number]) => fmt.date(r.date) }, { key: 'status', label: 'Status', render: (r) => r.status ?? '—' }]} />
              <ActivitySection title="Calls" rows={lead.calls} getId={(r) => r.id} columns={[{ key: 'status', label: 'Status', render: (r: CrmLeadDetail['calls'][number]) => r.status }, { key: 'notes', label: 'Notes', render: (r) => r.notes ?? '—' }, { key: 'when', label: 'When', render: (r) => (r.v2_created_at ? fmt.date(r.v2_created_at) : '—') }]} />
              <ActivitySection title="Visits" rows={lead.visits} getId={(r) => r.id} columns={[{ key: 'purpose', label: 'Purpose', render: (r: CrmLeadDetail['visits'][number]) => r.purpose }, { key: 'outcome', label: 'Outcome', render: (r) => r.outcome ?? '—' }, { key: 'date', label: 'Date', render: (r) => r.date }]} />
            </Stack>
          )}

          {tab === 4 && (
            <Stack spacing={3}>
              <ActivitySection title="Qualifications" rows={lead.qualifications} getId={(r) => r.id} columns={[{ key: 'level', label: 'Level', render: (r: CrmLeadDetail['qualifications'][number]) => r.level }, { key: 'inst', label: 'Institution', render: (r) => r.institution_name ?? '—' }, { key: 'grade', label: 'Grade', render: (r) => [r.grade, r.grade_scale].filter(Boolean).join(' ') || '—' }, { key: 'year', label: 'Year', render: (r) => r.end_year ?? '—' }]} />
              <ActivitySection title="Language tests" rows={lead.language_tests} getId={(r) => r.id} columns={[{ key: 'type', label: 'Test', render: (r: CrmLeadDetail['language_tests'][number]) => r.test_type }, { key: 'score', label: 'Overall', render: (r) => r.overall_score ?? '—' }, { key: 'date', label: 'Date', render: (r) => (r.test_date ? fmt.date(r.test_date) : '—') }]} />
              <ActivitySection title="Guardians" rows={lead.guardians} getId={(r) => r.id} columns={[{ key: 'name', label: 'Name', render: (r: CrmLeadDetail['guardians'][number]) => r.full_name }, { key: 'rel', label: 'Relationship', render: (r) => r.relationship_type }, { key: 'phone', label: 'Phone', render: (r) => r.phone ?? '—' }]} />
            </Stack>
          )}

          {tab === 5 && (
            <DataTable
              columns={[
                { key: 'amount', label: 'Amount', align: 'right', render: (p: CrmLeadDetail['payments'][number]) => fmt.money(p.amount_minor, p.currency) },
                { key: 'method', label: 'Method', render: (p) => p.method },
                { key: 'receipt', label: 'Receipt', hideOnMobile: true, render: (p) => p.receipt_no ?? '—' },
                { key: 'when', label: 'Received', render: (p) => fmt.date(p.received_at) },
              ]}
              rows={lead.payments}
              getRowId={(p) => p.id}
              emptyTitle="No payments"
              ariaLabel="Payments"
            />
          )}

          {tab === 6 && (() => {
            // Outstanding = unpaid SPVT fees, summed per currency (BigInt, never
            // mixed across currencies). NOT netted against V2 payments — those
            // are a separate historical record shown on the Payments tab.
            // SVT-FIN-2026-08 — PARTIAL is open, and what is outstanding on it
            // is the BALANCE, not the billed amount. Summing amount_minor for a
            // part-paid fee would overstate the debt by whatever was already
            // received. For the other open statuses paid_amount_minor is null,
            // so the subtraction is a no-op and one expression covers all four.
            const open = new Set(['SCHEDULED', 'DUE', 'PARTIAL', 'OVERDUE']);
            const byCurrency = new Map<string, bigint>();
            for (const f of lead.fees) {
              if (!open.has(f.status)) continue;
              const balance = BigInt(f.amount_minor) - BigInt(f.paid_amount_minor ?? 0);
              if (balance <= 0n) continue;
              byCurrency.set(f.currency, (byCurrency.get(f.currency) ?? 0n) + balance);
            }
            const outstanding = [...byCurrency.entries()];
            return (
              <Stack spacing={1.5}>
                <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                    <Typography variant="body2" color="text.secondary">Outstanding (unpaid):</Typography>
                    {outstanding.length === 0
                      ? <Chip size="small" variant="outlined" label="Nothing outstanding" />
                      : outstanding.map(([cur, amt]) => <Chip key={cur} size="small" color="warning" label={fmt.money(amt.toString(), cur)} sx={{ fontWeight: 700 }} />)}
                  </Stack>
                  {canWrite ? (
                    <Button variant="contained" size="small" startIcon={<AddOutlinedIcon />} onClick={() => setAddFeeOpen(true)}>Add fee</Button>
                  ) : null}
                </Stack>
                <DataTable columns={feeColumns} rows={lead.fees} getRowId={(f) => f.id} emptyTitle="No fees scheduled" emptyDescription="Add a session fee to track payments and reminders." ariaLabel="Fee schedule" />
              </Stack>
            );
          })()}
        </Box>
      </Paper>

      {editOpen ? <EditLeadDialog open={editOpen} lead={lead} onClose={() => setEditOpen(false)} /> : null}
      {addFeeOpen ? <AddFeeDialog open={addFeeOpen} leadId={lead.id} onClose={() => setAddFeeOpen(false)} /> : null}
      {convertOpen ? (
        <ConvertToStudentDialog
          lead={lead}
          open={convertOpen}
          onClose={() => setConvertOpen(false)}
          onConverted={(studentId) => {
            setConvertOpen(false);
            // ConvertToStudentDialog already fires a rich success toast
            // (including fee-migration + enrol notes). Notistack persists
            // across route navigation, so no need to fire a second one here.
            router.push(`/students/${studentId}`);
          }}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(feeAction)}
        title={feeAction?.kind === 'pay' ? 'Mark fee as paid' : feeAction?.kind === 'waive' ? 'Waive fee' : 'Delete fee'}
        description={feeAction ? `${feeAction.kind === 'pay' ? 'Mark' : feeAction.kind === 'waive' ? 'Waive' : 'Delete'} the “${feeAction.fee.session_label}” fee (${fmt.money(feeAction.fee.amount_minor, feeAction.fee.currency)})?` : ''}
        destructive={feeAction?.kind === 'delete'}
        confirmText={feeAction?.kind === 'pay' ? 'Mark paid' : feeAction?.kind === 'waive' ? 'Waive' : 'Delete'}
        loading={actionPending}
        onConfirm={confirmFeeAction}
        onClose={() => setFeeAction(null)}
      />
    </Stack>
  );
}

// Small titled sub-table for the Activity / Qualifications tabs.
function ActivitySection<R>({ title, rows, columns, getId }: { title: string; rows: R[]; columns: DataTableColumn<R>[]; getId: (r: R) => string }) {
  return (
    <Box>
      <Typography variant="subtitle2" sx={{ fontWeight: 700, mb: 1 }}>{title}</Typography>
      <DataTable columns={columns} rows={rows} getRowId={getId} emptyTitle={`No ${title.toLowerCase()}`} ariaLabel={title} />
    </Box>
  );
}
