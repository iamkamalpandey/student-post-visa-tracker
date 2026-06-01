'use client';

// Refactored to SVT form-pattern per design pass.

import { useEffect } from 'react';
import NextLink from 'next/link';
import { Autocomplete, Box, Link, MenuItem, Stack, TextField, Tooltip, Typography } from '@mui/material';
import LabeledField from '@/components/LabeledField';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { z } from 'zod';
import {
  CreateEnrollmentRequest,
  EnrollmentStatusEnum,
  type CreateEnrollmentRequest as CreateEnrollmentRequestType,
} from '@spv/zod-schemas';

// Form-only superset of CreateEnrollmentRequest: adds reason_code so the
// FSM-required reason field round-trips through react-hook-form / zodResolver
// without tripping CreateEnrollmentRequest's `.strict()` unknown-key guard.
const EnrollmentFormSchema = CreateEnrollmentRequest.extend({
  reason_code: z.string().max(120).optional(),
});
import { api, ApiError } from '@/lib/api';
import { useCurrencies, useTenant } from '@/lib/queries';
import { formatDate, formatMoney } from '@/lib/format';
import DataTable, { type DataTableColumn } from '@/components/DataTable';
import ConfirmDialog from '@/components/ConfirmDialog';
import StatusChip from '@/components/StatusChip';
import {
  COMMISSION_STATUS_COLOR,
  type CommissionRow,
} from '@/features/commissions/types';
import {
  FormDialog,
  RowActions,
  SectionHeader,
  SectionStates,
  compactPayload,
  unwrapList,
  useCanWrite,
  useDialogState,
} from '../sectionShared';
import { useAuth } from '@/lib/auth';
import {
  getAllowedNextStates,
  transitionRequiresReason,
  type EnrollmentStatus as FsmEnrollmentStatus,
} from './enrollment-fsm';

type Enrollment = {
  id: string;
  // SVT-WAVE-OCC-REQUIRED-2026-05 — optimistic-concurrency version. Backend
  // requires this in the If-Match header on PATCH (428 if missing, 412 if
  // stale). The list endpoint returns it on every row.
  version: number;
  institution_id: string;
  program_id: string;
  program_intake_id?: string | null;
  campus_id?: string | null;
  enrollment_no?: string | null;
  start_date?: string | null;
  expected_end_date?: string | null;
  actual_end_date?: string | null;
  status: 'OFFERED' | 'ACCEPTED' | 'ENROLLED' | 'DEFERRED' | 'WITHDRAWN' | 'COMPLETED' | 'CANCELLED';
  tuition_total_minor?: number | string | null;
  tuition_currency?: string | null;
  scholarship_minor?: number | string | null;
  scholarship_name?: string | null;
  agent_commission_minor?: number | string | null;
  super_agent_id?: string | null;
  super_agent?: { id: string; name: string; short_name?: string | null } | null;
  notes?: string | null;
};

type LookupOption = { id: string; label: string };
type Institution = { id: string; legal_name?: string; name?: string };
type Program = { id: string; name?: string; title?: string; code?: string };
type Intake = { id: string; intake_label?: string; name?: string; start_date?: string };
type Campus = { id: string; name?: string };
// SVT-SUPERAGENTS-2026-05: per-enrollment super-agent attribution. The
// "Direct" sentinel id is local-only — it serialises to null on the wire
// (= direct enrollment, no super-agent).
type SuperAgentLink = {
  id: string;
  super_agent_id: string;
  super_agent?: { id: string; name: string; short_name?: string | null };
};
const SUPER_AGENT_DIRECT_ID = '__direct__';

// Wire shape for GET /super-agents/:id/resolve-commission. `source` describes
// where the rate came from so we can label the helper text accurately.
type ResolvedCommission = {
  rule_id: string | null;
  commission_pct: number | null;
  currency: string | null;
  source: 'rule' | 'super_agent_default' | 'institution_default' | 'none';
};

export type EnrollmentsSectionProps = { studentId: string };

export default function EnrollmentsSection({ studentId }: EnrollmentsSectionProps) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const canWrite = useCanWrite();
  const dlg = useDialogState<Enrollment>();
  const deleteDlg = useDialogState<Enrollment>();

  const queryKey = ['students', studentId, 'enrollments'];
  const listQuery = useQuery({
    queryKey,
    queryFn: async () => {
      const res = await api.get(`/students/${studentId}/enrollments`);
      return unwrapList<Enrollment>(res.data);
    },
  });

  // Fetch the student's commissions in a single roundtrip and index by
  // enrollment_id for the per-row lookup. We tolerate missing endpoints (404)
  // by treating the result as an empty map — keeps the section usable while
  // backend rollout is in progress.
  const commissionsQuery = useQuery<Map<string, CommissionRow>>({
    queryKey: ['commissions', { student_id: studentId }],
    queryFn: async () => {
      try {
        const res = await api.get('/commissions', {
          params: { student_id: studentId, limit: 100 },
        });
        const list = unwrapList<CommissionRow>(res.data);
        const map = new Map<string, CommissionRow>();
        for (const row of list) {
          if (row.enrollment?.id) map.set(row.enrollment.id, row);
        }
        return map;
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          return new Map<string, CommissionRow>();
        }
        throw err;
      }
    },
    staleTime: 30_000,
  });

  const commissionByEnrollment = commissionsQuery.data ?? new Map<string, CommissionRow>();

  const columns: DataTableColumn<Enrollment>[] = [
    { key: 'no', label: 'Enrolment #', render: (r) => r.enrollment_no ?? '—' },
    { key: 'status', label: 'Status', render: (r) => <StatusChip status={r.status} /> },
    { key: 'start', label: 'Start', render: (r) => formatDate(r.start_date ?? '') },
    { key: 'end', label: 'Expected end', render: (r) => formatDate(r.expected_end_date ?? '') },
    {
      key: 'tuition',
      label: 'Tuition',
      render: (r) =>
        r.tuition_total_minor != null && r.tuition_currency
          ? formatMoney(r.tuition_total_minor, r.tuition_currency)
          : '—',
    },
    { key: 'scholarship', label: 'Scholarship', render: (r) => r.scholarship_name ?? '—' },
    {
      key: 'commission',
      label: 'Commission',
      render: (r) => {
        const c = commissionByEnrollment.get(r.id);
        if (!c) {
          return (
            <Typography variant="caption" color="text.disabled">
              {commissionsQuery.isLoading ? '…' : '—'}
            </Typography>
          );
        }
        const href = `/commissions?student_id=${encodeURIComponent(studentId)}&enrollment_id=${encodeURIComponent(r.id)}`;
        const amount = formatMoney(
          typeof c.amount_minor === 'bigint'
            ? c.amount_minor
            : (() => {
                try { return BigInt(c.amount_minor as string); } catch { return 0n; }
              })(),
          c.currency,
        );
        return (
          <Tooltip title="View in Commissions">
            <Link
              component={NextLink}
              href={href}
              underline="hover"
              color="inherit"
              onClick={(e) => e.stopPropagation()}
            >
              <Stack direction="row" spacing={0.75} alignItems="center">
                <StatusChip status={c.status} color={COMMISSION_STATUS_COLOR[c.status]} />
                <Typography variant="body2" sx={{ fontWeight: 600 }}>
                  {amount}
                </Typography>
              </Stack>
            </Link>
          </Tooltip>
        );
      },
    },
    {
      key: 'actions',
      label: '',
      align: 'right',
      render: (r) => (
        <RowActions
          canWrite={canWrite}
          onEdit={() => dlg.openEdit(r)}
          onDelete={() => deleteDlg.openEdit(r)}
        />
      ),
    },
  ];

  const removeMutation = useMutation<void, ApiError, Enrollment>({
    mutationFn: async (row) => {
      await api.delete(`/enrollments/${row.id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Enrolment deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey });
      deleteDlg.close();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  return (
    <Box>
      <SectionHeader
        title="Enrolments"
        description="Programs the student has been offered, accepted or enrolled into."
        onAdd={dlg.openCreate}
        addLabel="Add enrolment"
        canAdd={canWrite}
      />
      <SectionStates
        query={listQuery}
        resource="enrolments"
        onAdd={dlg.openCreate}
        addLabel="Add enrolment"
        canAdd={canWrite}
      >
        {(rows) => <DataTable columns={columns} rows={rows} getRowId={(r) => r.id} />}
      </SectionStates>
      <EnrollmentFormDialog
        open={dlg.open}
        editing={dlg.editing}
        studentId={studentId}
        onClose={dlg.close}
        onSaved={() => qc.invalidateQueries({ queryKey })}
      />
      <ConfirmDialog
        open={deleteDlg.open}
        title="Delete enrolment?"
        description="This permanently removes the enrolment record."
        confirmText="Delete"
        loading={removeMutation.isPending}
        errorText={removeMutation.error?.detail ?? null}
        onClose={() => deleteDlg.close()}
        onConfirm={() => {
          if (deleteDlg.editing) removeMutation.mutate(deleteDlg.editing);
        }}
      />
    </Box>
  );
}

// ---------------------------------------------------------------------------

// Renders a `reason_code` TextField only when the user has *actually* picked a
// status that requires one (per the FSM). On create, or when the status is
// unchanged / doesn't require a reason, the field is omitted entirely so the
// payload stays compact.
function ReasonCodeField({
  control,
  errors,
  currentStatus,
  isEditing,
}: {
  control: ReturnType<typeof useForm<FormValues>>['control'];
  errors: Record<string, { message?: string } | undefined>;
  currentStatus: FsmEnrollmentStatus | null;
  isEditing: boolean;
}) {
  const target = useWatch({ control, name: 'status' }) as FsmEnrollmentStatus | undefined;
  const needs =
    isEditing &&
    currentStatus &&
    target &&
    transitionRequiresReason(currentStatus, target);
  return (
    <Controller
      name="reason_code"
      control={control}
      render={({ field }) => {
        if (!needs) {
          // Keep the field registered but invisible so the value is always
          // submitted as part of the form payload (or stripped by compactPayload).
          return <input type="hidden" {...field} value={field.value ?? ''} />;
        }
        return (
          <LabeledField
            label="Reason"
            required
            error={Boolean(errors['reason_code'])}
            helperText={errors['reason_code']?.message ?? 'Required for this transition (min 3 chars).'}
            htmlFor="enr-reason"
          >
            <TextField
              id="enr-reason"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="Brief reason (audit log)"
              inputProps={{ minLength: 3, maxLength: 120 }}
              error={Boolean(errors['reason_code'])}
              value={field.value ?? ''}
              onChange={field.onChange}
              onBlur={field.onBlur}
              name={field.name}
              inputRef={field.ref}
            />
          </LabeledField>
        );
      }}
    />
  );
}

// In the form we hold money fields as plain strings (number-input value);
// the zod resolver will coerce them to bigint on submit via z.coerce.bigint().
type FormValues = Omit<
  CreateEnrollmentRequestType,
  'tuition_total_minor' | 'scholarship_minor' | 'agent_commission_minor'
> & {
  tuition_total_minor?: string;
  scholarship_minor?: string;
  agent_commission_minor?: string;
  // Required by some FSM transitions on edit (e.g. ACCEPTED→WITHDRAWN). Sent
  // through to PATCH; ignored on create.
  reason_code?: string;
};

function EnrollmentFormDialog({
  open,
  editing,
  studentId,
  onClose,
  onSaved,
}: {
  open: boolean;
  editing: Enrollment | null;
  studentId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { enqueueSnackbar } = useSnackbar();
  const currencies = useCurrencies();
  const { user } = useAuth();
  const role = user?.role ?? null;

  const {
    register,
    control,
    handleSubmit,
    reset,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(EnrollmentFormSchema),
    defaultValues: {
      institution_id: '',
      program_id: '',
      program_intake_id: undefined,
      campus_id: undefined,
      super_agent_id: undefined,
      enrollment_no: '',
      status: 'OFFERED',
      tuition_currency: '',
      scholarship_minor: '0',
      scholarship_name: '',
      notes: '',
    },
  });

  const institutionId = useWatch({ control, name: 'institution_id' });
  const programId = useWatch({ control, name: 'program_id' });

  const institutions = useQuery({
    queryKey: ['institutions', 'all'],
    enabled: open,
    queryFn: async () => {
      const res = await api.get<{ data: Institution[] } | Institution[]>('/institutions', {
        params: { limit: 100 },
      });
      return unwrapList<Institution>(res.data).map((i) => ({
        id: i.id,
        label: i.legal_name ?? i.name ?? i.id,
      })) as LookupOption[];
    },
  });

  const programs = useQuery({
    queryKey: ['programs', institutionId ?? null],
    enabled: open && Boolean(institutionId),
    queryFn: async () => {
      const res = await api.get<{ data: Program[] } | Program[]>('/programs', {
        params: { institution_id: institutionId, limit: 100 },
      });
      return unwrapList<Program>(res.data).map((p) => ({
        id: p.id,
        label: p.name ?? p.title ?? p.code ?? p.id,
      })) as LookupOption[];
    },
  });

  const intakes = useQuery({
    queryKey: ['programs', programId ?? null, 'intakes'],
    enabled: open && Boolean(programId),
    queryFn: async () => {
      const res = await api.get(`/programs/${programId}/intakes`);
      return unwrapList<Intake>(res.data).map((i) => ({
        id: i.id,
        label: i.intake_label ?? i.name ?? (i.start_date ? formatDate(i.start_date) : i.id),
      })) as LookupOption[];
    },
  });

  const campuses = useQuery({
    queryKey: ['institutions', institutionId ?? null, 'campuses'],
    enabled: open && Boolean(institutionId),
    queryFn: async () => {
      const res = await api.get(`/institutions/${institutionId}/campuses`);
      return unwrapList<Campus>(res.data).map((c) => ({
        id: c.id,
        label: c.name ?? c.id,
      })) as LookupOption[];
    },
  });

  // SVT-SUPERAGENTS-2026-05: super-agents linked to the picked institution.
  // Disabled until an institution is chosen; the Autocomplete prepends a
  // "Direct (no super-agent)" sentinel option that serialises to null.
  const superAgents = useQuery({
    queryKey: ['institutions', institutionId ?? null, 'super-agents'],
    enabled: open && Boolean(institutionId),
    queryFn: async () => {
      const res = await api.get(`/institutions/${institutionId}/super-agents`);
      const list = unwrapList<SuperAgentLink>(res.data);
      const out: LookupOption[] = [
        { id: SUPER_AGENT_DIRECT_ID, label: 'Direct (no super-agent)' },
      ];
      for (const l of list) {
        const sa = l.super_agent;
        if (!sa) continue;
        out.push({
          id: sa.id,
          label: `${sa.name}${sa.short_name ? ` (${sa.short_name})` : ''}`,
        });
      }
      return out;
    },
  });

  // SVT-SUPERAGENTS-2026-05: resolve the rate the recalculator WILL apply when
  // this enrolment lands in CommissionClaim. Pure preview; the backend is the
  // authority. Helper text on the super-agent picker surfaces the result so
  // counsellors don't have to context-switch to the rules tab.
  const superAgentId = useWatch({ control, name: 'super_agent_id' });
  const resolvedCommission = useQuery<ResolvedCommission | null>({
    queryKey: [
      'super-agents',
      superAgentId ?? null,
      'resolve-commission',
      institutionId ?? null,
    ],
    enabled: open && Boolean(superAgentId && institutionId),
    staleTime: 30_000,
    queryFn: async () => {
      try {
        const res = await api.get<ResolvedCommission>(
          `/super-agents/${superAgentId}/resolve-commission`,
          { params: { institution_id: institutionId } },
        );
        return res.data;
      } catch (err) {
        // Tolerate 404/403 — the helper text simply hides.
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          return null;
        }
        throw err;
      }
    },
  });

  // SVT-WAVE28-DEFAULTS-2026-05 — seed tuition_currency from tenant default on
  // create. Edit path keeps the row's stored currency.
  const tenantQ = useTenant(open && !editing);

  useEffect(() => {
    if (!open) return;
    reset({
      institution_id: editing?.institution_id ?? '',
      program_id: editing?.program_id ?? '',
      program_intake_id: editing?.program_intake_id ?? undefined,
      campus_id: editing?.campus_id ?? undefined,
      super_agent_id: editing?.super_agent_id ?? undefined,
      enrollment_no: editing?.enrollment_no ?? '',
      start_date: editing?.start_date?.slice(0, 10),
      expected_end_date: editing?.expected_end_date?.slice(0, 10),
      actual_end_date: editing?.actual_end_date?.slice(0, 10),
      status: editing?.status ?? 'OFFERED',
      tuition_total_minor:
        editing?.tuition_total_minor != null ? String(editing.tuition_total_minor) : undefined,
      tuition_currency: editing?.tuition_currency ?? (tenantQ.data?.default_currency ?? ''),
      scholarship_minor:
        editing?.scholarship_minor != null ? String(editing.scholarship_minor) : '0',
      scholarship_name: editing?.scholarship_name ?? '',
      agent_commission_minor:
        editing?.agent_commission_minor != null ? String(editing.agent_commission_minor) : undefined,
      notes: editing?.notes ?? '',
      reason_code: '',
    } as FormValues);
  }, [open, editing, reset, tenantQ.data?.default_currency]);

  // When the institution changes, reset dependent selects.
  useEffect(() => {
    if (!open) return;
    if (editing && editing.institution_id === institutionId) return;
    setValue('program_id', '');
    setValue('program_intake_id', undefined);
    setValue('campus_id', undefined);
    setValue('super_agent_id', undefined);
  }, [institutionId, open, editing, setValue]);

  useEffect(() => {
    if (!open) return;
    if (editing && editing.program_id === programId) return;
    setValue('program_intake_id', undefined);
  }, [programId, open, editing, setValue]);

  const mutation = useMutation<unknown, ApiError, FormValues>({
    mutationFn: async (raw) => {
      const values: Record<string, unknown> = { ...raw };
      // Coerce numeric strings → numbers (zod coerces to bigint server-side).
      for (const k of [
        'tuition_total_minor',
        'scholarship_minor',
        'agent_commission_minor',
      ]) {
        const v = values[k];
        if (typeof v === 'string' && v !== '') values[k] = v;
        else if (v === '') delete values[k];
      }
      const body = compactPayload(values);
      if (editing) {
        // SVT-WAVE-OCC-REQUIRED-2026-05 — backend requires If-Match on
        // PATCH (428 if missing, 412 if stale). Send the version the list
        // query saw; concurrent edits surface as a 412 the user can resolve
        // by refreshing the section.
        return api.patch(`/enrollments/${editing.id}`, body, {
          headers: { 'If-Match': `"${editing.version}"` },
        });
      }
      return api.post(`/students/${studentId}/enrollments`, body);
    },
    onSuccess: () => {
      enqueueSnackbar(editing ? 'Enrolment updated' : 'Enrolment added', { variant: 'success' });
      onSaved();
      onClose();
    },
    onError: (err) => enqueueSnackbar(err.detail || err.title, { variant: 'error' }),
  });

  const onSubmit = handleSubmit((values) => mutation.mutate(values));

  return (
    <FormDialog
      open={open}
      title={editing ? 'Edit enrolment' : 'Add enrolment'}
      formId="enrollment-form"
      isSubmitting={isSubmitting || mutation.isPending}
      errorText={mutation.error?.detail ?? null}
      onClose={onClose}
    >
      <Box
        component="form"
        id="enrollment-form"
        onSubmit={onSubmit}
        noValidate
        sx={{
          // Standardise input heights to 44px so date, text, select and
          // autocomplete all line up vertically. Multiline (notes) is
          // excluded so it can grow.
          '& .MuiOutlinedInput-root:not(.MuiInputBase-multiline)': { minHeight: 44, height: 44 },
          '& .MuiOutlinedInput-input:not(textarea)': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& input[type="date"]': { paddingTop: 0, paddingBottom: 0, height: '100%' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root': { paddingTop: '0 !important', paddingBottom: '0 !important' },
          '& .MuiAutocomplete-root .MuiOutlinedInput-root .MuiAutocomplete-input': { padding: '0 6px !important' },
        }}
      >
        {/* Required-field legend — explicit so the convention is unambiguous. */}
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          <Box component="span" sx={{ color: 'error.main', fontWeight: 700, mr: 0.5 }}>*</Box>
          Required
        </Typography>
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
          <Box sx={{ gridColumn: { sm: '1 / -1' } }}>
            <LabeledField
              label="Institution"
              required
              error={Boolean(errors.institution_id)}
              helperText={errors.institution_id?.message ?? ''}
              htmlFor="enr-inst"
            >
              <Controller
                name="institution_id"
                control={control}
                render={({ field }) => {
                  const opts = institutions.data ?? [];
                  return (
                    <Autocomplete
                      options={opts}
                      loading={institutions.isLoading}
                      getOptionLabel={(o) => o.label}
                      isOptionEqualToValue={(o, v) => o.id === v.id}
                      value={opts.find((o) => o.id === field.value) ?? null}
                      onChange={(_, v) => field.onChange(v?.id ?? '')}
                      fullWidth
                      size="medium"
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          id="enr-inst"
                          hiddenLabel
                          placeholder="Search institutions"
                          error={Boolean(errors.institution_id)}
                        />
                      )}
                    />
                  );
                }}
              />
            </LabeledField>
          </Box>
          <LabeledField
            label="Program"
            required
            error={Boolean(errors.program_id)}
            helperText={
              errors.program_id?.message ?? (institutionId ? '' : 'Pick an institution first.')
            }
            htmlFor="enr-prog"
          >
            <Controller
              name="program_id"
              control={control}
              render={({ field }) => {
                const opts = programs.data ?? [];
                return (
                  <Autocomplete
                    options={opts}
                    loading={programs.isLoading}
                    disabled={!institutionId}
                    getOptionLabel={(o) => o.label}
                    isOptionEqualToValue={(o, v) => o.id === v.id}
                    value={opts.find((o) => o.id === field.value) ?? null}
                    onChange={(_, v) => field.onChange(v?.id ?? '')}
                    fullWidth
                    size="medium"
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        id="enr-prog"
                        hiddenLabel
                        placeholder="Pick a program"
                        error={Boolean(errors.program_id)}
                      />
                    )}
                  />
                );
              }}
            />
          </LabeledField>
          <LabeledField
            label="Intake"
            error={Boolean(errors.program_intake_id)}
            helperText={errors.program_intake_id?.message ?? ''}
            htmlFor="enr-intake"
          >
            <Controller
              name="program_intake_id"
              control={control}
              render={({ field }) => {
                const opts = intakes.data ?? [];
                return (
                  <Autocomplete
                    options={opts}
                    loading={intakes.isLoading}
                    disabled={!programId}
                    getOptionLabel={(o) => o.label}
                    isOptionEqualToValue={(o, v) => o.id === v.id}
                    value={opts.find((o) => o.id === field.value) ?? null}
                    onChange={(_, v) => field.onChange(v?.id ?? undefined)}
                    fullWidth
                    size="medium"
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        id="enr-intake"
                        hiddenLabel
                        placeholder="Optional"
                        error={Boolean(errors.program_intake_id)}
                      />
                    )}
                  />
                );
              }}
            />
          </LabeledField>
          <LabeledField
            label="Campus"
            error={Boolean(errors.campus_id)}
            helperText={errors.campus_id?.message ?? ''}
            htmlFor="enr-campus"
          >
            <Controller
              name="campus_id"
              control={control}
              render={({ field }) => {
                const opts = campuses.data ?? [];
                return (
                  <Autocomplete
                    options={opts}
                    loading={campuses.isLoading}
                    disabled={!institutionId}
                    getOptionLabel={(o) => o.label}
                    isOptionEqualToValue={(o, v) => o.id === v.id}
                    value={opts.find((o) => o.id === field.value) ?? null}
                    onChange={(_, v) => field.onChange(v?.id ?? undefined)}
                    fullWidth
                    size="medium"
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        id="enr-campus"
                        hiddenLabel
                        placeholder="Optional"
                        error={Boolean(errors.campus_id)}
                      />
                    )}
                  />
                );
              }}
            />
          </LabeledField>
          {/* SVT-SUPERAGENTS-2026-05: super-agent picker. Sentinel "Direct"
             option serialises to null on the wire (= no super-agent). */}
          <LabeledField
            label="Super-agent"
            error={Boolean(errors.super_agent_id)}
            helperText={
              errors.super_agent_id?.message ??
              (institutionId
                ? superAgentId && superAgentId !== SUPER_AGENT_DIRECT_ID
                  ? resolvedCommission.isLoading
                    ? 'Resolving rate…'
                    : resolvedCommission.data?.commission_pct != null
                      ? `Resolved rate: ${resolvedCommission.data.commission_pct}% on tuition${
                          resolvedCommission.data.currency
                            ? ` (${resolvedCommission.data.currency})`
                            : ''
                        } — ${
                          resolvedCommission.data.source === 'rule'
                            ? 'Institution-specific rule'
                            : resolvedCommission.data.source === 'super_agent_default'
                              ? 'Super-agent default'
                              : resolvedCommission.data.source === 'institution_default'
                                ? 'Institution default'
                                : 'No matching rule'
                        }.`
                      : 'Rate will be computed on save.'
                  : 'Pick the aggregator used for this enrollment, or leave as Direct.'
                : 'Pick an institution first.')
            }
            htmlFor="enr-sa"
          >
            <Controller
              name="super_agent_id"
              control={control}
              render={({ field }) => {
                const opts = superAgents.data ?? [];
                const currentId = field.value ?? SUPER_AGENT_DIRECT_ID;
                return (
                  <Autocomplete
                    options={opts}
                    loading={superAgents.isLoading}
                    disabled={!institutionId}
                    getOptionLabel={(o) => o.label}
                    isOptionEqualToValue={(o, v) => o.id === v.id}
                    value={opts.find((o) => o.id === currentId) ?? null}
                    onChange={(_, v) => {
                      // Map the sentinel back to undefined so compactPayload
                      // drops it / sends null per zod schema.
                      const id = v?.id ?? null;
                      field.onChange(id === SUPER_AGENT_DIRECT_ID || id == null ? null : id);
                    }}
                    fullWidth
                    size="medium"
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        id="enr-sa"
                        hiddenLabel
                        placeholder="Direct (no super-agent)"
                        error={Boolean(errors.super_agent_id)}
                      />
                    )}
                  />
                );
              }}
            />
          </LabeledField>
          <LabeledField
            label="Enrolment number"
            error={Boolean(errors.enrollment_no)}
            helperText={errors.enrollment_no?.message ?? ''}
            htmlFor="enr-no"
          >
            <TextField
              id="enr-no"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="Provider's reference"
              error={Boolean(errors.enrollment_no)}
              {...register('enrollment_no')}
            />
          </LabeledField>
          <LabeledField
            label="Status"
            error={Boolean(errors.status)}
            helperText={
              errors.status?.message ??
              (editing &&
              (editing.status as FsmEnrollmentStatus) &&
              getAllowedNextStates(editing.status as FsmEnrollmentStatus, role).length === 0
                ? 'No transitions available for your role.'
                : '')
            }
            htmlFor="enr-status"
          >
            <Controller
              name="status"
              control={control}
              render={({ field }) => {
                // On create (no `editing`) we surface every status — the create
                // endpoint isn't FSM-gated. On edit we offer only the current
                // status (keep / no-op) plus the FSM-allowed next states for
                // this role; backend remains the authoritative gate.
                const currentStatus = (editing?.status ?? null) as FsmEnrollmentStatus | null;
                const allowedNext = currentStatus
                  ? getAllowedNextStates(currentStatus, role)
                  : [];
                const options: FsmEnrollmentStatus[] = editing
                  ? currentStatus
                    ? ([currentStatus, ...allowedNext.filter((s) => s !== currentStatus)] as FsmEnrollmentStatus[])
                    : (EnrollmentStatusEnum.options as readonly FsmEnrollmentStatus[]).slice()
                  : (EnrollmentStatusEnum.options as readonly FsmEnrollmentStatus[]).slice();
                return (
                  <TextField
                    id="enr-status"
                    select
                    fullWidth
                    size="medium"
                    hiddenLabel
                    error={Boolean(errors.status)}
                    {...field}
                  >
                    {options.map((o) => (
                      <MenuItem
                        key={o}
                        value={o}
                        // Disable the current-status row so it reads as "no change"
                        // rather than a self-edge submission.
                        disabled={editing ? o === currentStatus : false}
                      >
                        {o}
                        {editing && o === currentStatus ? ' (current)' : ''}
                      </MenuItem>
                    ))}
                  </TextField>
                );
              }}
            />
          </LabeledField>
          <ReasonCodeField
            control={control}
            errors={errors as Record<string, { message?: string } | undefined>}
            currentStatus={(editing?.status ?? null) as FsmEnrollmentStatus | null}
            isEditing={Boolean(editing)}
          />
          <LabeledField
            label="Start date"
            error={Boolean(errors.start_date)}
            helperText={errors.start_date?.message ?? ''}
            htmlFor="enr-start"
          >
            <TextField
              id="enr-start"
              type="date"
              fullWidth
              size="medium"
              hiddenLabel
              error={Boolean(errors.start_date)}
              {...register('start_date')}
            />
          </LabeledField>
          <LabeledField
            label="Expected end date"
            error={Boolean(errors.expected_end_date)}
            helperText={errors.expected_end_date?.message ?? ''}
            htmlFor="enr-end"
          >
            <TextField
              id="enr-end"
              type="date"
              fullWidth
              size="medium"
              hiddenLabel
              error={Boolean(errors.expected_end_date)}
              {...register('expected_end_date')}
            />
          </LabeledField>
          <LabeledField
            label="Tuition total (minor units)"
            error={Boolean(errors.tuition_total_minor)}
            helperText={errors.tuition_total_minor?.message ?? 'Smallest currency unit.'}
            htmlFor="enr-tuition"
          >
            <TextField
              id="enr-tuition"
              type="number"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="0"
              inputProps={{ min: 0, step: 1 }}
              error={Boolean(errors.tuition_total_minor)}
              {...register('tuition_total_minor')}
            />
          </LabeledField>
          <LabeledField
            label="Tuition currency"
            error={Boolean(errors.tuition_currency)}
            helperText={errors.tuition_currency?.message ?? ''}
            htmlFor="enr-curr"
          >
            <Controller
              name="tuition_currency"
              control={control}
              render={({ field }) => (
                <TextField
                  id="enr-curr"
                  select
                  fullWidth
                  size="medium"
                  hiddenLabel
                  error={Boolean(errors.tuition_currency)}
                  value={field.value ?? ''}
                  onChange={field.onChange}
                >
                  <MenuItem value="">—</MenuItem>
                  {(currencies.data ?? []).map((c) => (
                    <MenuItem key={c.code} value={c.code}>
                      {c.code} — {c.name}
                    </MenuItem>
                  ))}
                </TextField>
              )}
            />
          </LabeledField>
          <LabeledField
            label="Scholarship (minor units)"
            error={Boolean(errors.scholarship_minor)}
            helperText={errors.scholarship_minor?.message ?? ''}
            htmlFor="enr-sch-amt"
          >
            <TextField
              id="enr-sch-amt"
              type="number"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="0"
              inputProps={{ min: 0, step: 1 }}
              error={Boolean(errors.scholarship_minor)}
              {...register('scholarship_minor')}
            />
          </LabeledField>
          <LabeledField
            label="Scholarship name"
            error={Boolean(errors.scholarship_name)}
            helperText={errors.scholarship_name?.message ?? ''}
            htmlFor="enr-sch-name"
          >
            <TextField
              id="enr-sch-name"
              fullWidth
              size="medium"
              hiddenLabel
              placeholder="e.g. Vice-Chancellor's Award"
              error={Boolean(errors.scholarship_name)}
              {...register('scholarship_name')}
            />
          </LabeledField>
          <Box sx={{ gridColumn: { sm: '1 / -1' } }}>
            <LabeledField
              label="Notes"
              error={Boolean(errors.notes)}
              helperText={errors.notes?.message ?? ''}
              htmlFor="enr-notes"
            >
              <TextField
                id="enr-notes"
                fullWidth
                hiddenLabel
                multiline
                minRows={2}
                error={Boolean(errors.notes)}
                {...register('notes')}
              />
            </LabeledField>
          </Box>
        </Box>
      </Box>
    </FormDialog>
  );
}
