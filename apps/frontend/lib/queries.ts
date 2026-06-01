'use client';

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from '@tanstack/react-query';
import { api } from './api';

// ---------------------------------------------------------------------------
// Shared lookup / reference-data hooks.
// All keys live under ['lookups', ...] except stages which are listed under
// ['stages']. Reference data uses a 10-minute staleTime; stages use 60s
// because admins can edit them in-app.
// ---------------------------------------------------------------------------

const LOOKUPS_STALE_MS = 10 * 60_000;
const STAGES_STALE_MS = 60_000;

/**
 * Unwraps `{ data: T }` envelopes returned by the SPV REST API while still
 * tolerating bare-array responses for endpoints that don't envelope.
 */
function unwrap<T>(payload: unknown): T {
  if (payload && typeof payload === 'object' && 'data' in (payload as Record<string, unknown>)) {
    return (payload as { data: T }).data;
  }
  return payload as T;
}

// ---------- Types ----------------------------------------------------------

export type CountryLookup = {
  code_alpha2: string;
  name: string;
  dial_code: string;
};

export type CurrencyLookup = {
  code: string;
  name: string;
  symbol?: string;
  minor_unit?: number;
};

export type IscedFieldLookup = {
  code: string;
  label: string;
  parent_code?: string | null;
};

export type DocumentTypeLookup = {
  key: string;
  label: string;
  category?: string | null;
};

export type RelationshipTypeLookup = {
  key: string;
  label: string;
};

export type VisaCategoryLookup = {
  code: string;
  label: string;
  country_code: string;
  description?: string | null;
};

export type StageLookup = {
  id: string;
  key: string;
  label: string;
  sequence: number;
  category: string;
  is_initial: boolean;
  is_terminal: boolean;
  color_hex: string | null;
  /** MUI icon name (e.g. "Flight", "School") — see stageIconFor() in StageChip. */
  icon?: string | null;
  sla_hours?: number | null;
};

// ---------- Hooks ----------------------------------------------------------

/** List ISO-3166 alpha-2 countries with phone dial codes. */
export function useCountries(): UseQueryResult<CountryLookup[]> {
  return useQuery({
    queryKey: ['lookups', 'countries'],
    queryFn: async () => {
      const res = await api.get('/lookups/countries');
      return unwrap<CountryLookup[]>(res.data);
    },
    staleTime: LOOKUPS_STALE_MS,
  });
}

/** List ISO-4217 currencies. */
export function useCurrencies(): UseQueryResult<CurrencyLookup[]> {
  return useQuery({
    queryKey: ['lookups', 'currencies'],
    queryFn: async () => {
      const res = await api.get('/lookups/currencies');
      return unwrap<CurrencyLookup[]>(res.data);
    },
    staleTime: LOOKUPS_STALE_MS,
  });
}

/** List ISCED fields of education. */
export function useIscedFields(): UseQueryResult<IscedFieldLookup[]> {
  return useQuery({
    queryKey: ['lookups', 'isced-fields'],
    queryFn: async () => {
      const res = await api.get('/lookups/isced-fields');
      return unwrap<IscedFieldLookup[]>(res.data);
    },
    staleTime: LOOKUPS_STALE_MS,
  });
}

/** List supported document types (passport, transcript, etc.). */
export function useDocumentTypes(): UseQueryResult<DocumentTypeLookup[]> {
  return useQuery({
    queryKey: ['lookups', 'document-types'],
    queryFn: async () => {
      const res = await api.get('/lookups/document-types');
      return unwrap<DocumentTypeLookup[]>(res.data);
    },
    staleTime: LOOKUPS_STALE_MS,
  });
}

/** List family / sponsor / contact relationship types. */
export function useRelationshipTypes(): UseQueryResult<RelationshipTypeLookup[]> {
  return useQuery({
    queryKey: ['lookups', 'relationship-types'],
    queryFn: async () => {
      const res = await api.get('/lookups/relationship-types');
      return unwrap<RelationshipTypeLookup[]>(res.data);
    },
    staleTime: LOOKUPS_STALE_MS,
  });
}

/**
 * List the configured pipeline stages. Refreshes more aggressively because
 * admins can edit stage labels/colors at runtime.
 */
export function useStages(): UseQueryResult<StageLookup[]> {
  return useQuery({
    queryKey: ['stages'],
    queryFn: async () => {
      const res = await api.get('/stages');
      return unwrap<StageLookup[]>(res.data);
    },
    staleTime: STAGES_STALE_MS,
  });
}

// SVT-LIFECYCLE-2026-05: lifecycle stage transitions matrix.
//
// Returns the configured transitions out of `fromStageId`. When the matrix is
// empty for that stage, the AdvanceStageDialog falls back to its sequence
// rule (forward = free, backward = admin + reason). Disabled when no
// fromStageId is provided so we don't pull the whole matrix on dialog mount
// before the student is loaded.
export type StageTransition = {
  id?: string;
  from_stage_id: string;
  to_stage_id: string;
  requires_role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER' | null;
};

export function useStageTransitions(
  fromStageId: string | null | undefined,
): UseQueryResult<StageTransition[]> {
  const id = (fromStageId ?? '').trim();
  return useQuery({
    queryKey: ['stages', 'transitions', id || null],
    enabled: id.length > 0,
    queryFn: async () => {
      const res = await api.get('/stages/transitions', {
        params: { from_stage_id: id },
      });
      const data = unwrap<StageTransition[]>(res.data);
      return Array.isArray(data) ? data : [];
    },
    staleTime: STAGES_STALE_MS,
  });
}

/**
 * List visa categories for a destination country. Disabled until a country
 * code is provided so the UI can wait for a parent select.
 */
export function useVisaCategories(
  countryCode: string | undefined,
): UseQueryResult<VisaCategoryLookup[]> {
  return useQuery({
    queryKey: ['lookups', 'visa-categories', countryCode ?? null],
    enabled: Boolean(countryCode),
    queryFn: async () => {
      const res = await api.get('/lookups/visa-categories', {
        params: { country: countryCode },
      });
      return unwrap<VisaCategoryLookup[]>(res.data);
    },
    staleTime: LOOKUPS_STALE_MS,
  });
}

// ---------------------------------------------------------------------------
// Lightweight pickers — kept under ['lookups', ...] because they are read-only
// and live in the same cache as other reference data. They intentionally use
// short staleTimes since they hit data-bearing endpoints rather than true
// look-up tables.
// ---------------------------------------------------------------------------

const PICKER_STALE_MS = 30_000;

export type StudentLite = {
  id: string;
  student_code: string;
  given_name: string;
  family_name: string;
};

export type UserLite = {
  id: string;
  email: string;
  given_name: string;
  family_name: string;
  display_name?: string | null;
  role: 'ADMIN' | 'COUNSELLOR' | 'VIEWER';
  is_active?: boolean;
};

/**
 * Lightweight student autocomplete picker. Fires `/students?limit=25&search=`
 * on every keystroke (callers debounce). Disabled when `search` is empty so
 * we don't pull a default page on dialog mount.
 */
export function useStudentsLite(search?: string): UseQueryResult<StudentLite[]> {
  const term = (search ?? '').trim();
  return useQuery({
    queryKey: ['lookups', 'students-lite', term],
    enabled: term.length > 0,
    queryFn: async () => {
      const res = await api.get('/students', {
        params: { limit: 25, search: term },
      });
      const data = unwrap<StudentLite[]>(res.data);
      return Array.isArray(data) ? data : [];
    },
    staleTime: PICKER_STALE_MS,
    placeholderData: (prev) => prev,
  });
}

// ---------- Student enrollments (linkage picker) --------------------------

export type StudentEnrollmentLite = {
  id: string;
  status?: string | null;
  intake_label?: string | null;
  start_date?: string | null;
  program?: { id: string; name?: string | null } | null;
  program_intake?: {
    id: string;
    intake_label?: string | null;
    intake_year?: number | null;
    intake_month?: number | null;
  } | null;
  institution?: { id: string; display_name?: string | null } | null;
};

/**
 * Lists enrollments for a single student. Used by the reminders
 * "Enrollment" linkage picker — disabled until a student id is supplied so we
 * don't fire a request on dialog mount. Returns the raw rows (program +
 * intake joins included by the backend default include).
 */
export function useStudentEnrollments(
  studentId: string | null | undefined,
): UseQueryResult<StudentEnrollmentLite[]> {
  const id = (studentId ?? '').trim();
  return useQuery({
    queryKey: ['students', id, 'enrollments-lite'],
    enabled: id.length > 0,
    queryFn: async () => {
      const res = await api.get(`/students/${id}/enrollments`);
      const data = unwrap<StudentEnrollmentLite[]>(res.data);
      return Array.isArray(data) ? data : [];
    },
    staleTime: PICKER_STALE_MS,
  });
}

/**
 * Active workspace users — for assignee dropdowns. Admin-only callers should
 * gate the hook themselves via the `enabled` arg below.
 */
export function useUsersLite(enabled = true): UseQueryResult<UserLite[]> {
  return useQuery({
    queryKey: ['lookups', 'users-lite'],
    enabled,
    queryFn: async () => {
      // SVT-LOOKUP-FILTERS-2026-05: assignee/owner pickers should only see
      // active workspace users; the admin management list omits this so it
      // can still surface inactive accounts for re-activation.
      const res = await api.get('/users', { params: { limit: 100, active_only: true } });
      const data = unwrap<UserLite[]>(res.data);
      return Array.isArray(data) ? data : [];
    },
    staleTime: PICKER_STALE_MS,
  });
}

// ---------------------------------------------------------------------------
// Reminders — list query + bell-count helper.
// ---------------------------------------------------------------------------

export type ReminderRow = {
  id: string;
  tenant_id: string;
  student_id?: string | null;
  enrollment_id?: string | null;
  type: string;
  source_entity_type?: string | null;
  source_entity_id?: string | null;
  title: string;
  description?: string | null;
  due_on: string;
  scheduled_for: string;
  assigned_to_id?: string | null;
  status: 'PENDING' | 'SENT' | 'ACKNOWLEDGED' | 'SNOOZED' | 'DISMISSED';
  fire_count: number;
  sent_at?: string | null;
  acknowledged_at?: string | null;
  snooze_until?: string | null;
  created_at: string;
  // Optional joins the backend may include for list rendering convenience.
  student?: {
    id: string;
    student_code: string;
    given_name: string;
    family_name: string;
  } | null;
  assigned_to?: {
    id: string;
    given_name: string;
    family_name: string;
    display_name?: string | null;
  } | null;
};

export type ReminderListResponse = {
  data: ReminderRow[];
  page: { hasMore: boolean; nextCursor: string | null; total?: number };
};

export type ReminderFilters = {
  q?: string;
  status?: string;
  type?: string;
  assigned_to_id?: string;
  student_id?: string;
  due_from?: string;
  due_to?: string;
  page?: number;
  limit?: number;
};

/**
 * Strip blank/`all` filters before they hit the wire so the URL stays clean
 * and the backend doesn't have to treat empties as "no filter".
 */
function buildReminderParams(filters: ReminderFilters): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (filters.limit) out['limit'] = filters.limit;
  if (filters.q && filters.q.trim()) out['q'] = filters.q.trim();
  if (filters.status && filters.status !== 'all') out['status'] = filters.status;
  if (filters.type && filters.type !== 'all') out['type'] = filters.type;
  if (filters.assigned_to_id) out['assigned_to_id'] = filters.assigned_to_id;
  if (filters.student_id) out['student_id'] = filters.student_id;
  if (filters.due_from) out['due_from'] = filters.due_from;
  if (filters.due_to) out['due_to'] = filters.due_to;
  if (filters.page && filters.page > 0) out['page'] = filters.page;
  return out;
}

export function useReminders(
  filters: ReminderFilters = {},
): UseQueryResult<ReminderListResponse> {
  return useQuery({
    queryKey: ['reminders', filters],
    queryFn: async () => {
      const res = await api.get('/reminders', { params: buildReminderParams(filters) });
      const payload = res.data as ReminderListResponse | { data: ReminderRow[] };
      // Tolerate the bare-array shape some early endpoints emit.
      if ('page' in (payload as Record<string, unknown>)) return payload as ReminderListResponse;
      const arr = (payload as { data: ReminderRow[] }).data ?? [];
      return { data: arr, page: { hasMore: false, nextCursor: null, total: arr.length } };
    },
    placeholderData: (prev) => prev,
  });
}

/**
 * Convenience reader for the bell badge — returns the same `useReminders`
 * shape filtered to PENDING. Components typically only read `data?.page.total`
 * or `data?.data.length` for the count.
 */
export function useUnreadAdminMessages(): UseQueryResult<ReminderListResponse> {
  return useReminders({ status: 'PENDING', limit: 1 });
}

// ---------------------------------------------------------------------------
// Tenant settings — used by form-default seeders so currency/locale/timezone
// fields can pre-populate with the workspace's configured defaults rather than
// the hard-coded "GBP"/"en"/"UTC" placeholders the components shipped with.
// 5-minute staleTime — tenant settings rarely change and admins refresh after
// editing /settings anyway.
// ---------------------------------------------------------------------------

export type TenantSettings = {
  id: string;
  name: string;
  legal_name?: string | null;
  default_locale: string;
  default_timezone: string;
  default_currency: string;
  email_from?: string | null;
  // SVT-BILLING-TOGGLE-2026-05 — admin-controlled billing module gate. The
  // server defaults this to false on existing tenants, so consumers should
  // treat `undefined` as "off" when older payloads slip through.
  billing_enabled?: boolean;
};

/** Patch shape accepted by PATCH /tenants/me. All fields optional. */
export type UpdateTenantSettingsInput = {
  name?: string;
  legal_name?: string | null;
  default_locale?: string;
  default_timezone?: string;
  default_currency?: string;
  email_from?: string | null;
  billing_enabled?: boolean;
};

const TENANT_STALE_MS = 5 * 60_000;
const TENANT_QUERY_KEY = ['tenants', 'me'] as const;

export function useTenant(enabled = true): UseQueryResult<TenantSettings> {
  return useQuery({
    queryKey: TENANT_QUERY_KEY,
    enabled,
    queryFn: async () => {
      const res = await api.get<TenantSettings>('/tenants/me');
      return res.data;
    },
    staleTime: TENANT_STALE_MS,
  });
}

/**
 * PATCH /tenants/me with TanStack optimistic update. Cancels in-flight
 * tenant reads, snapshots the previous cache entry, applies the patch
 * locally, and rolls back on error. After settling we invalidate so the
 * server response (which may normalise values like currency casing) wins.
 *
 * Returned `context` is typed as `{ previous?: TenantSettings }` so callers
 * can rely on rollback semantics without a custom mutation context.
 */
export function useUpdateTenantSettings(): UseMutationResult<
  TenantSettings,
  unknown,
  UpdateTenantSettingsInput,
  { previous: TenantSettings | undefined }
> {
  const qc = useQueryClient();
  return useMutation<
    TenantSettings,
    unknown,
    UpdateTenantSettingsInput,
    { previous: TenantSettings | undefined }
  >({
    mutationFn: async (patch) => {
      const res = await api.patch<TenantSettings>('/tenants/me', patch);
      return res.data;
    },
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: TENANT_QUERY_KEY });
      const previous = qc.getQueryData<TenantSettings>(TENANT_QUERY_KEY);
      if (previous) {
        qc.setQueryData<TenantSettings>(TENANT_QUERY_KEY, { ...previous, ...patch });
      }
      return { previous };
    },
    onError: (_err, _patch, ctx) => {
      // Roll back to the snapshot we took in onMutate.
      if (ctx?.previous) qc.setQueryData(TENANT_QUERY_KEY, ctx.previous);
    },
    onSuccess: (data) => {
      // Server is the source of truth — overwrite the optimistic value with
      // whatever Postgres returned (normalised currency casing, etc.).
      qc.setQueryData<TenantSettings>(TENANT_QUERY_KEY, data);
    },
    onSettled: () => {
      // SVT-WAVE-BILLING-2026-05 — useBillingEnabled now projects from
      // /tenants/me directly, so invalidating TENANT_QUERY_KEY also flips
      // billing visibility for free. The legacy ['billing', 'enabled']
      // probe was removed when useBillingEnabled stopped 404-probing.
      void qc.invalidateQueries({ queryKey: TENANT_QUERY_KEY });
    },
  });
}
