'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import {
  Avatar,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  Divider,
  Stack,
  Step,
  StepContent,
  StepLabel,
  Stepper,
  Tab,
  Tabs,
  Typography,
} from '@mui/material';
import ArrowBackOutlinedIcon from '@mui/icons-material/ArrowBackOutlined';
import DeleteOutlineOutlinedIcon from '@mui/icons-material/DeleteOutlineOutlined';
import TimelineOutlinedIcon from '@mui/icons-material/TimelineOutlined';
import AlternateEmailOutlinedIcon from '@mui/icons-material/AlternateEmailOutlined';
import CallOutlinedIcon from '@mui/icons-material/CallOutlined';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';

import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useFormat } from '@/lib/format';
import { canWriteStudents } from '@/lib/auth-helpers';
import LoadingSkeleton from '@/components/LoadingSkeleton';
import ErrorState from '@/components/ErrorState';
import ConfirmDialog from '@/components/ConfirmDialog';
import EmptyState from '@/components/EmptyState';
import CompletenessRing from '@/components/CompletenessRing';
import SectionErrorBoundary from '@/components/SectionErrorBoundary';
import AdvanceStageDialog from '@/features/students/AdvanceStageDialog';
import EditCoreProfileDialog from '@/features/students/EditCoreProfileDialog';
import AssignCounsellorDialog from '@/features/students/AssignCounsellorDialog';
import ContactsSection from '@/features/students/profile/ContactsSection';
import IdentificationsSection from '@/features/students/profile/IdentificationsSection';
import VisasSection from '@/features/students/profile/VisasSection';
import InsuranceSection from '@/features/students/profile/InsuranceSection';
import RegulatorIdsSection from '@/features/students/profile/RegulatorIdsSection';
import DependentsSection from '@/features/students/profile/DependentsSection';
import ComplianceSection from '@/features/students/profile/ComplianceSection';
import CustomFieldsSection from '@/features/attributes/CustomFieldsSection';
import TravelSection from '@/features/students/journey/TravelSection';
import AccommodationsSection from '@/features/students/journey/AccommodationsSection';
import EngagementsSection from '@/features/students/journey/EngagementsSection';
import CurrentStageChecklist from '@/features/students/journey/CurrentStageChecklist';
import QualificationsSection from '@/features/students/studies/QualificationsSection';
import LanguageTestsSection from '@/features/students/studies/LanguageTestsSection';
import EnrollmentsSection from '@/features/students/studies/EnrollmentsSection';
import EmploymentSection from '@/features/students/studies/EmploymentSection';
import DocumentsSection from '@/features/students/records/DocumentsSection';
import AddressesSection from '@/features/students/records/AddressesSection';
import FinanceSection from '@/features/students/records/FinanceSection';
import SponsorshipsSection from '@/features/students/records/SponsorshipsSection';
import MessagesSection from '@/features/students/records/MessagesSection';
import PlanSummaryCard from '@/features/billing/PlanSummaryCard';
import FeePlanWizardDialog from '@/features/billing/FeePlanWizardDialog';
import RecordPaymentDialog from '@/features/billing/RecordPaymentDialog';
import { useBillingEnabled, useFeePlans, type FeePlan } from '@/features/billing/queries';
import { useStudentEnrollments } from '@/lib/queries';

type StageRef = {
  id: string;
  key: string;
  label: string;
  sequence: number;
  category: string;
  color_hex?: string | null;
  is_initial?: boolean;
  // v6: forwarded to AdvanceStageDialog so it can render the optional date input.
  prompt_date_label?: string | null;
};

type AssignedRef = {
  id: string;
  given_name: string;
  family_name: string;
};

type Student = {
  id: string;
  student_code: string;
  given_name: string;
  middle_name?: string | null;
  family_name: string;
  preferred_name?: string | null;
  name_in_passport?: string | null;
  date_of_birth: string;
  gender: string;
  gender_self_described?: string | null;
  nationality_code: string;
  marital_status?: string | null;
  primary_language: string;
  religion?: string | null;
  ethnicity?: string | null;
  email_primary?: string | null;
  email_secondary?: string | null;
  phone_primary_e164?: string | null;
  phone_secondary_e164?: string | null;
  notes?: string | null;
  status: string;
  current_stage_id: string | null;
  current_stage: StageRef | null;
  assigned_to: AssignedRef | null;
  created_at: string;
  updated_at: string;
  version: number;
  completeness_pct?: number;
};

type TimelineEvent = {
  id: string;
  occurred_at: string;
  effective_at: string;
  reason_code?: string | null;
  notes?: string | null;
  actor_role?: string | null;
  from_stage?: { id: string; key: string; label: string } | null;
  to_stage?: { id: string; key: string; label: string } | null;
};

function initialsOf(g: string, f: string): string {
  return `${g?.[0] ?? ''}${f?.[0] ?? ''}`.toUpperCase() || '?';
}

type StudentDetailTab = 'profile' | 'journey' | 'studies' | 'records' | 'billing';

const VALID_TABS: ReadonlySet<StudentDetailTab> = new Set([
  'profile',
  'journey',
  'studies',
  'records',
  'billing',
]);

export default function StudentDetailClient({ id }: { id: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const { user } = useAuth();
  const fmt = useFormat();

  // Allow `/students/[id]?tab=records&section=messages`-style deep links from
  // the inbox. We only honour the initial value — subsequent tab clicks are
  // local state.
  const initialTab: StudentDetailTab = (() => {
    const raw = searchParams?.get('tab');
    return raw && VALID_TABS.has(raw as StudentDetailTab) ? (raw as StudentDetailTab) : 'profile';
  })();
  const [tab, setTab] = useState<StudentDetailTab>(initialTab);

  // SVT-WAVE-POLISH-2026-05 — `?section=<id>` deep links. After the page
  // settles (and the requested tab has rendered), we scroll the anchor into
  // view. `scroll-margin-top` on SectionAnchor compensates for the fixed
  // AppShell header so the heading lands below the AppBar, not under it.
  const sectionParam = searchParams?.get('section') ?? null;
  useEffect(() => {
    if (!sectionParam) return;
    // Two RAFs so we run after MUI Tabs paint + section mount; one RAF is too
    // early when the tab itself just changed.
    let raf1 = 0;
    let raf2 = 0;
    raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        const el = document.getElementById(`section-${sectionParam}`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      window.cancelAnimationFrame(raf2);
    };
  }, [sectionParam, tab]);
  const [advanceOpen, setAdvanceOpen] = useState(false);
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const billingEnabledQuery = useBillingEnabled();
  const billingTabEnabled = billingEnabledQuery.data === true;

  const studentQuery = useQuery<Student, ApiError>({
    queryKey: ['student', id],
    queryFn: async () => {
      const res = await api.get<Student>(`/students/${id}`);
      return res.data;
    },
    retry: (failureCount, err) => {
      if (err instanceof ApiError && err.status === 404) return false;
      return failureCount < 2;
    },
  });

  const timelineQuery = useQuery<TimelineEvent[], ApiError>({
    queryKey: ['student-timeline', id],
    queryFn: async () => {
      const res = await api.get<{ data: TimelineEvent[] }>(`/students/${id}/timeline`);
      return res.data.data;
    },
    enabled: studentQuery.isSuccess,
  });

  const stagesQuery = useQuery({
    queryKey: ['stages'],
    queryFn: async (): Promise<StageRef[]> => {
      const res = await api.get<{ data: StageRef[] }>('/stages');
      return res.data.data;
    },
    staleTime: 5 * 60_000,
  });

  const deleteMutation = useMutation<void, ApiError>({
    mutationFn: async () => {
      await api.delete(`/students/${id}`);
    },
    onSuccess: () => {
      enqueueSnackbar('Student deleted', { variant: 'success' });
      qc.invalidateQueries({ queryKey: ['students'] });
      router.replace('/students');
    },
    onError: (err) => {
      enqueueSnackbar(err.detail || err.title || 'Could not delete student', {
        variant: 'error',
      });
    },
  });

  const isAdmin = user?.role === 'ADMIN';
  const canEditCore = canWriteStudents(user?.role);

  const sortedTimeline = useMemo(
    () => (timelineQuery.data ?? []).slice().sort((a, b) => a.occurred_at.localeCompare(b.occurred_at)),
    [timelineQuery.data],
  );

  if (studentQuery.isLoading) {
    return <LoadingSkeleton variant="page" />;
  }

  if (studentQuery.isError) {
    if (studentQuery.error.status === 404) {
      return (
        <EmptyState
          title="Student not found"
          description="This record may have been deleted or you may not have access to it."
          actions={
            <Button
              variant="contained"
              startIcon={<ArrowBackOutlinedIcon />}
              onClick={() => router.push('/students')}
            >
              Back to students
            </Button>
          }
        />
      );
    }
    return (
      <ErrorState
        title="Could not load student"
        description={studentQuery.error.detail || studentQuery.error.title}
        onRetry={() => studentQuery.refetch()}
        requestId={studentQuery.error.requestId}
      />
    );
  }

  const student = studentQuery.data!;
  const stage = student.current_stage;
  const assigned = student.assigned_to;
  // current_stage from /students/:id doesn't include color_hex; look it up from the
  // stages catalog so the chip mirrors the list view styling.
  const stageColor =
    (stagesQuery.data ?? []).find((s) => s.id === stage?.id)?.color_hex ?? null;

  return (
    <Stack spacing={3}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Button
          variant="text"
          startIcon={<ArrowBackOutlinedIcon />}
          onClick={() => router.push('/students')}
        >
          All students
        </Button>
        {isAdmin && (
          <Button
            variant="outlined"
            color="error"
            startIcon={<DeleteOutlineOutlinedIcon />}
            onClick={() => setConfirmDelete(true)}
          >
            Delete
          </Button>
        )}
      </Stack>

      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: { xs: '1fr', md: '320px 1fr' },
          gap: 3,
          alignItems: 'flex-start',
        }}
      >
        {/* Left rail — sticky on md+ so it stays in view while scrolling
            the deep tab content. Top offset matches the AppShell AppBar
            (56 / 64) plus the page-padding gutter so the rail doesn't
            collide with the fixed header. */}
        <Box
          sx={{
            position: { md: 'sticky' },
            top: { md: 'calc(64px + 16px)' },
            alignSelf: { md: 'flex-start' },
          }}
        >
          <Card variant="outlined" sx={{ borderRadius: 2 }}>
            <CardContent>
              <Stack spacing={2} alignItems="center" textAlign="center">
                <Box sx={{ position: 'relative' }}>
                  <Avatar
                    sx={{
                      width: 80,
                      height: 80,
                      bgcolor: 'primary.main',
                      fontSize: 28,
                      fontWeight: 600,
                    }}
                  >
                    {initialsOf(student.given_name, student.family_name)}
                  </Avatar>
                  {typeof student.completeness_pct === 'number' && (
                    <Box
                      sx={{
                        position: 'absolute',
                        bottom: -6,
                        right: -10,
                        bgcolor: 'background.paper',
                        borderRadius: '50%',
                        boxShadow: 1,
                      }}
                    >
                      <CompletenessRing
                        value={student.completeness_pct}
                        size={36}
                        thickness={4}
                        label="Profile completeness"
                      />
                    </Box>
                  )}
                </Box>
                <Stack spacing={0.5} alignItems="center">
                  <Typography variant="h6" sx={{ fontWeight: 600 }}>
                    {student.given_name} {student.family_name}
                  </Typography>
                  <Typography variant="caption" sx={{ fontFamily: 'monospace' }} color="text.secondary">
                    {student.student_code}
                  </Typography>
                </Stack>
                <Stack direction="row" spacing={1} flexWrap="wrap" justifyContent="center">
                  {stage && (
                    <Chip
                      size="small"
                      label={stage.label}
                      sx={
                        stageColor
                          ? {
                              bgcolor: `${stageColor}1f`,
                              color: stageColor,
                              fontWeight: 500,
                              borderColor: stageColor,
                            }
                          : { fontWeight: 500 }
                      }
                      variant={stageColor ? 'outlined' : 'filled'}
                    />
                  )}
                  <Chip
                    size="small"
                    label={student.status}
                    color={student.status === 'ACTIVE' ? 'success' : 'default'}
                    variant="outlined"
                  />
                </Stack>
                {canEditCore && (
                  <Stack direction="row" spacing={1} sx={{ width: '100%' }}>
                    <Button
                      variant="contained"
                      size="small"
                      fullWidth
                      startIcon={<TimelineOutlinedIcon fontSize="small" />}
                      onClick={() => setAdvanceOpen(true)}
                    >
                      Advance
                    </Button>
                    <Button
                      variant="outlined"
                      size="small"
                      fullWidth
                      startIcon={<EditOutlinedIcon fontSize="small" />}
                      onClick={() => setEditProfileOpen(true)}
                    >
                      Edit
                    </Button>
                  </Stack>
                )}
              </Stack>
              <Divider sx={{ my: 2 }} />
              <Stack spacing={1.5}>
                <DetailRow
                  label="Counsellor"
                  value={assigned ? `${assigned.given_name} ${assigned.family_name}` : 'Unassigned'}
                  action={canEditCore ? { label: 'Change', onClick: () => setAssignOpen(true) } : undefined}
                />
                <DetailRow label="Nationality" value={student.nationality_code} />
                <DetailRow label="Language" value={student.primary_language} />
                <DetailRow
                  label="Created"
                  value={fmt.dateTime(student.created_at)}
                />
              </Stack>
            </CardContent>
          </Card>
        </Box>

        {/* Main area */}
        <Stack spacing={2}>
          <Card variant="outlined" sx={{ borderRadius: 2 }}>
            <Tabs
              value={tab}
              onChange={(_, v) => setTab(v)}
              // SVT-A11Y-2026-05 — scrollable + auto-scroll-buttons so all
              // four tabs remain reachable on 320px-wide viewports without
              // overflow/clip. allowScrollButtonsMobile keeps the chevrons
              // visible on touch devices where hover triggers don't apply.
              variant="scrollable"
              scrollButtons="auto"
              allowScrollButtonsMobile
              sx={{ px: 2, borderBottom: (t) => `1px solid ${t.palette.divider}` }}
            >
              <Tab value="profile" label="Profile" />
              <Tab value="journey" label="Journey" />
              <Tab value="studies" label="Studies" />
              <Tab value="records" label="Records" />
              {billingTabEnabled && <Tab value="billing" label="Billing" />}
            </Tabs>
            <CardContent>
              {tab === 'profile' && (
                <ProfileTab
                  student={student}
                  onEdit={canEditCore ? () => setEditProfileOpen(true) : undefined}
                />
              )}
              {tab === 'journey' && (
                <JourneyTab
                  studentId={student.id}
                  currentStageId={student.current_stage_id}
                  currentStageLabel={student.current_stage?.label ?? null}
                  events={sortedTimeline}
                  loading={timelineQuery.isLoading}
                  error={timelineQuery.error}
                  onAdvance={() => setAdvanceOpen(true)}
                />
              )}
              {tab === 'studies' && <StudiesTab studentId={student.id} />}
              {tab === 'records' && <RecordsTab studentId={student.id} />}
              {tab === 'billing' && billingTabEnabled && (
                <BillingTab studentId={student.id} />
              )}
            </CardContent>
          </Card>
        </Stack>
      </Box>

      <AdvanceStageDialog
        open={advanceOpen}
        onClose={() => setAdvanceOpen(false)}
        studentId={student.id}
        currentStageId={student.current_stage_id}
        stages={stagesQuery.data ?? []}
      />

      <EditCoreProfileDialog
        open={editProfileOpen}
        onClose={() => setEditProfileOpen(false)}
        student={student}
      />

      <AssignCounsellorDialog
        open={assignOpen}
        onClose={() => setAssignOpen(false)}
        studentId={student.id}
        studentVersion={student.version}
        currentAssigneeId={student.assigned_to?.id ?? null}
      />

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => (deleteMutation.isPending ? undefined : setConfirmDelete(false))}
        title="Delete student?"
        description={
          <Typography variant="body2">
            This soft-deletes <strong>{student.given_name} {student.family_name}</strong> ({student.student_code}).
            They will no longer appear in lists. This action is reversible by an administrator.
          </Typography>
        }
        confirmLabel={student.student_code}
        confirmText="Delete student"
        loading={deleteMutation.isPending}
        onConfirm={() => deleteMutation.mutate()}
      />
    </Stack>
  );
}

// SVT-WAVE-POLISH-2026-05 — wraps a sub-section so deep links
// (?section=visa) can scroll to it. scroll-margin-top covers the fixed
// AppShell header height (56 / 64).
function SectionAnchor({
  id,
  children,
  mt = 4,
}: {
  id: string;
  children: React.ReactNode;
  mt?: number;
}) {
  return (
    <Box id={`section-${id}`} sx={{ mt, scrollMarginTop: { xs: 72, md: 88 } }}>
      {/* SVT-SYNC-2026-06: isolate each section so a crash doesn't take down the page. */}
      <SectionErrorBoundary section={id}>
        {children}
      </SectionErrorBoundary>
    </Box>
  );
}

function DetailRow({
  label,
  value,
  action,
}: {
  label: string;
  value: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
      <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: 0.5 }}>
        {label}
      </Typography>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="body2" sx={{ fontWeight: 500, textAlign: 'right' }}>
          {value}
        </Typography>
        {action && (
          <Button size="small" variant="text" onClick={action.onClick} sx={{ minWidth: 'auto', px: 0.5 }}>
            {action.label}
          </Button>
        )}
      </Stack>
    </Stack>
  );
}

function ProfileTab({ student, onEdit }: { student: Student; onEdit?: () => void }) {
  const fmt = useFormat();
  return (
    <Stack spacing={0}>
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' },
        gap: 2,
      }}
    >
      <Card variant="outlined" sx={{ borderRadius: 2 }}>
        <CardContent>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="overline" color="text.secondary">
              Identity
            </Typography>
            {onEdit && (
              <Button
                size="small"
                variant="text"
                startIcon={<EditOutlinedIcon fontSize="small" />}
                onClick={onEdit}
              >
                Edit profile
              </Button>
            )}
          </Stack>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <FieldRow label="Given name" value={student.given_name} />
            {student.middle_name && <FieldRow label="Middle name" value={student.middle_name} />}
            <FieldRow label="Family name" value={student.family_name} />
            {student.preferred_name && <FieldRow label="Preferred name" value={student.preferred_name} />}
            <FieldRow label="Date of birth" value={fmt.date(student.date_of_birth)} />
            <FieldRow label="Gender" value={student.gender.replace(/_/g, ' ').toLowerCase()} />
            <FieldRow label="Nationality" value={student.nationality_code} />
            <FieldRow label="Language" value={student.primary_language} />
            {student.marital_status && (
              <FieldRow label="Marital status" value={student.marital_status.toLowerCase()} />
            )}
            {student.religion && <FieldRow label="Religion" value={student.religion} />}
            {student.ethnicity && <FieldRow label="Ethnicity" value={student.ethnicity} />}
          </Stack>
        </CardContent>
      </Card>
      <Card variant="outlined" sx={{ borderRadius: 2 }}>
        <CardContent>
          <Typography variant="overline" color="text.secondary">
            Contact
          </Typography>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <ContactRow icon={<AlternateEmailOutlinedIcon fontSize="small" />} label="Primary email" value={student.email_primary ?? '—'} />
            {student.email_secondary && (
              <ContactRow icon={<AlternateEmailOutlinedIcon fontSize="small" />} label="Secondary email" value={student.email_secondary} />
            )}
            <ContactRow icon={<CallOutlinedIcon fontSize="small" />} label="Primary phone" value={student.phone_primary_e164 ?? '—'} />
            {student.phone_secondary_e164 && (
              <ContactRow icon={<CallOutlinedIcon fontSize="small" />} label="Secondary phone" value={student.phone_secondary_e164} />
            )}
          </Stack>
        </CardContent>
      </Card>
    </Box>
      <SectionAnchor id="contacts">
        <ContactsSection studentId={student.id} />
      </SectionAnchor>
      <SectionAnchor id="identifications">
        <IdentificationsSection studentId={student.id} />
      </SectionAnchor>
      <SectionAnchor id="visa">
        <VisasSection studentId={student.id} />
      </SectionAnchor>
      <SectionAnchor id="insurance">
        <InsuranceSection studentId={student.id} />
      </SectionAnchor>
      <SectionAnchor id="regulator-ids">
        <RegulatorIdsSection studentId={student.id} />
      </SectionAnchor>
      <SectionAnchor id="dependents">
        <DependentsSection studentId={student.id} />
      </SectionAnchor>
      <SectionAnchor id="compliance">
        <ComplianceSection studentId={student.id} />
      </SectionAnchor>
      {/*
        SVT-UNLOCK-2026-08 — custom fields. The AttributeDefinition /
        EntityAttribute backend shipped complete and had no UI at all, so
        tenant-defined fields existed in the database and were unreachable.
      */}
      <SectionAnchor id="custom-fields">
        <CustomFieldsSection entityType="student" entityId={student.id} />
      </SectionAnchor>
    </Stack>
  );
}

function FieldRow({ label, value }: { label: string; value: string }) {
  return (
    <Stack direction="row" justifyContent="space-between" spacing={2}>
      <Typography variant="body2" color="text.secondary" sx={{ textTransform: 'capitalize' }}>
        {label}
      </Typography>
      <Typography variant="body2" sx={{ fontWeight: 500, textAlign: 'right', textTransform: 'capitalize' }}>
        {value}
      </Typography>
    </Stack>
  );
}

function ContactRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <Stack direction="row" spacing={1.5} alignItems="center">
      <Box sx={{ color: 'text.secondary' }}>{icon}</Box>
      <Stack sx={{ flexGrow: 1 }}>
        <Typography variant="caption" color="text.secondary">
          {label}
        </Typography>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {value}
        </Typography>
      </Stack>
    </Stack>
  );
}

function JourneyTab({
  studentId,
  currentStageId,
  currentStageLabel,
  events,
  loading,
  error,
  onAdvance,
}: {
  studentId: string;
  currentStageId: string | null;
  currentStageLabel: string | null;
  events: TimelineEvent[];
  loading: boolean;
  error: ApiError | null;
  onAdvance: () => void;
}) {
  const fmt = useFormat();
  return (
    <Stack spacing={2}>
      {/* Current-stage checklist sits at the TOP of the tab so counsellors land
          straight on actionable tasks before scanning the timeline below. */}
      <CurrentStageChecklist
        studentId={studentId}
        currentStageId={currentStageId}
        stageLabel={currentStageLabel}
      />

      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>
          Lifecycle journey
        </Typography>
        <Button variant="contained" size="small" onClick={onAdvance} startIcon={<TimelineOutlinedIcon />}>
          Advance stage
        </Button>
      </Stack>

      {loading ? (
        <LoadingSkeleton variant="list" rows={4} />
      ) : error ? (
        <ErrorState title="Could not load timeline" description={error.detail || error.title} />
      ) : events.length === 0 ? (
        <EmptyState
          title="No journey events yet"
          description="Stage transitions appear here as soon as you advance the student."
        />
      ) : (
        <Stepper orientation="vertical" activeStep={events.length} nonLinear>
          {events.map((evt) => {
            const fromLabel = evt.from_stage?.label ?? 'Initial';
            const toLabel = evt.to_stage?.label ?? '—';
            return (
              <Step key={evt.id} expanded completed>
                <StepLabel
                  optional={
                    <Typography variant="caption" color="text.secondary">
                      {fmt.dateTime(evt.effective_at)}
                      {evt.actor_role ? ` · ${evt.actor_role}` : ''}
                    </Typography>
                  }
                >
                  {fromLabel} → {toLabel}
                </StepLabel>
                <StepContent>
                  {evt.reason_code && (
                    <Typography variant="body2" sx={{ fontWeight: 500 }}>
                      Reason: {evt.reason_code}
                    </Typography>
                  )}
                  {evt.notes && (
                    <Typography variant="body2" color="text.secondary">
                      {evt.notes}
                    </Typography>
                  )}
                </StepContent>
              </Step>
            );
          })}
        </Stepper>
      )}

      <SectionAnchor id="travel">
        <TravelSection studentId={studentId} />
      </SectionAnchor>
      <SectionAnchor id="accommodation">
        <AccommodationsSection studentId={studentId} />
      </SectionAnchor>
      <SectionAnchor id="engagements">
        <EngagementsSection studentId={studentId} />
      </SectionAnchor>
    </Stack>
  );
}

function StudiesTab({ studentId }: { studentId: string }) {
  return (
    <Stack spacing={0}>
      <SectionAnchor id="qualifications">
        <QualificationsSection studentId={studentId} />
      </SectionAnchor>
      <SectionAnchor id="language-tests">
        <LanguageTestsSection studentId={studentId} />
      </SectionAnchor>
      <SectionAnchor id="enrollments">
        <EnrollmentsSection studentId={studentId} />
      </SectionAnchor>
      <SectionAnchor id="employment">
        <EmploymentSection studentId={studentId} />
      </SectionAnchor>
    </Stack>
  );
}

function RecordsTab({ studentId }: { studentId: string }) {
  return (
    <Stack spacing={4} divider={<Divider flexItem />}>
      <Box id="section-documents" sx={{ scrollMarginTop: { xs: 72, md: 88 } }}>
        <DocumentsSection studentId={studentId} />
      </Box>
      <Box id="section-addresses" sx={{ scrollMarginTop: { xs: 72, md: 88 } }}>
        <AddressesSection studentId={studentId} />
      </Box>
      <Box id="section-finance" sx={{ scrollMarginTop: { xs: 72, md: 88 } }}>
        <FinanceSection studentId={studentId} />
      </Box>
      <Box id="section-sponsorships" sx={{ scrollMarginTop: { xs: 72, md: 88 } }}>
        <SponsorshipsSection studentId={studentId} />
      </Box>
      <Box id="section-messages" sx={{ scrollMarginTop: { xs: 72, md: 88 } }}>
        <MessagesSection studentId={studentId} />
      </Box>
    </Stack>
  );
}

// SVT-WAVE-BILLING-2026-05 — Billing tab. Renders one PlanSummaryCard per
// enrollment. Gated by useBillingEnabled() upstream so this never renders
// when the tenant has billing disabled. Empty state: enroll the student first.
function BillingTab({ studentId }: { studentId: string }) {
  const enrollmentsQuery = useStudentEnrollments(studentId);
  const enrollments = enrollmentsQuery.data ?? [];
  const [wizardEnrollmentId, setWizardEnrollmentId] = useState<string | null>(null);
  // SVT-WAVE-BILLING-2026-05 — Lifted dialog state so a single
  // RecordPaymentDialog instance services every enrollment row.
  const [payPlan, setPayPlan] = useState<FeePlan | null>(null);
  if (enrollmentsQuery.isLoading) {
    return (
      <Stack spacing={2}>
        <Typography variant="body2" color="text.secondary">Loading…</Typography>
      </Stack>
    );
  }
  if (enrollments.length === 0) {
    return (
      <Stack spacing={1}>
        <Typography variant="subtitle1" sx={{ fontWeight: 600 }}>Billing</Typography>
        <Typography variant="body2" color="text.secondary">
          No enrolments yet. Add one in the Studies tab to start a fee plan.
        </Typography>
      </Stack>
    );
  }
  return (
    <>
      <Stack spacing={2}>
        {enrollments.map((e) => (
          <EnrollmentBillingRow
            key={e.id}
            enrollmentId={e.id}
            onCreatePlan={() => setWizardEnrollmentId(e.id)}
            onRecordPayment={(plan) => setPayPlan(plan)}
          />
        ))}
      </Stack>
      {wizardEnrollmentId && (
        <FeePlanWizardDialog
          open={!!wizardEnrollmentId}
          enrollmentId={wizardEnrollmentId}
          onClose={() => setWizardEnrollmentId(null)}
        />
      )}
      {payPlan && (
        <RecordPaymentDialog
          open={!!payPlan}
          onClose={() => setPayPlan(null)}
          plan={payPlan}
        />
      )}
    </>
  );
}

// SVT-WAVE-BILLING-2026-05 — Per-enrollment row. Runs a parallel
// useFeePlans(ACTIVE) call so we can hand a real FeePlan object up to the
// RecordPaymentDialog (PlanSummaryCard loads its own copy internally).
function EnrollmentBillingRow({
  enrollmentId,
  onCreatePlan,
  onRecordPayment,
}: {
  enrollmentId: string;
  onCreatePlan: () => void;
  onRecordPayment: (plan: FeePlan) => void;
}) {
  const activePlansQuery = useFeePlans({ enrollment_id: enrollmentId, status: 'ACTIVE', limit: 1 });
  const activePlan = activePlansQuery.data?.data?.[0] ?? null;
  return (
    <Stack spacing={1}>
      <PlanSummaryCard enrollmentId={enrollmentId} onCreatePlan={onCreatePlan} />
      {activePlan && (
        <Box>
          <Button size="small" variant="outlined" onClick={() => onRecordPayment(activePlan)}>
            Record payment
          </Button>
        </Box>
      )}
    </Stack>
  );
}
