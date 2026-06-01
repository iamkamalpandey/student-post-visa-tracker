# Deep Audit Findings — SPV Backend

Date: 2026-05-14
Test driver: `infra/scripts/spv_deep_test.sh`
Latest run log: `infra/docs/test-results/deep-test-20260514-094605.log`
Scoreboard: 110 / 126 tests passing (16 failures, all real bugs).

This document enumerates every defect surfaced by the deep test. Each finding
lists severity, exact location, reproduction, and a suggested fix. **No code
changes were made by the auditing agent — remediation is left to other agents.**

Severity scale: P0 (data loss / security), P1 (core feature broken), P2 (privacy
or correctness leak), P3 (cosmetic / observability).

---

## P0-1 — `PATCH /students/:id` always returns 500 (core CRUD broken)

- **Status code observed:** `500 Internal Server Error` for every PATCH attempt.
- **Affected endpoint:** `PATCH /api/v1/students/:id`
- **Location:** `apps/backend/src/modules/students/students.service.ts:225`
- **Root cause:** the update payload sets `data.updated_by = { connect: { id: actorId } }`,
  but the Prisma schema defines no relation called `updated_by` on `Student`. The
  scalar field is `updated_by_id`. Prisma rejects with:
  ```
  Unknown argument `updated_by`. Did you mean `updated_at`?
  ```
- **Reproduction:**
  ```bash
  curl -X PATCH http://localhost:4000/api/v1/students/<sid> \
    -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
    -H 'If-Match: "1"' -d '{"notes":"x"}'
  # → 500 Prisma "Unknown argument updated_by"
  ```
- **Knock-on effect:** stale-If-Match / 412 path is also unreachable, since the
  service crashes on the happy-path UPDATE before we ever read the version
  mismatch. Exit-survey of the optimistic-concurrency code (`students.service.ts:255-261`)
  is therefore unverifiable end-to-end.
- **Suggested fix:** replace `updated_by: { connect: { id: actorId } }` with
  `updated_by_id: actorId` (matching how `created_by_id` is set on create at
  line 174). Optionally also add a `updated_by` relation field on `Student` to
  schema.prisma if a relation is desired, but the simpler scalar path matches
  the rest of the codebase.

---

## P0-2 — Bulk module `*.service.create()` fails on every Date field

- **Status code observed:** `500 Internal Server Error` for ten sub-resources.
- **Affected endpoints (all POST):**
  - `POST /students/:id/language-tests`     (`test_date` → `LanguageTestResult.test_date :: Date`)
  - `POST /students/:id/identifications`    (`issued_on`)
  - `POST /students/:id/visas`              (`issued_on`, `expires_on`)
  - `POST /students/:id/regulator-ids`      (`issued_on`)
  - `POST /students/:id/dependents`         (`date_of_birth`)
  - `POST /students/:id/employment`         (`started_on`)
  - `POST /students/:id/accommodations`     (`move_in_date`)
  - `POST /students/:id/insurances`         (`starts_on`, `ends_on`)
  - `POST /students/:id/finance`            (`due_on`, `paid_on`)
  - `POST /students/:id/engagements`        (`check_date`)
  - `POST /students/:id/messages`           (writes message thread w/ a Date field)
  - `POST /students/:id/sponsorships`       (`starts_on`)
- **Root cause:** every service follows this pattern (e.g. `apps/backend/src/modules/employment/service.ts:16`):
  ```ts
  return db(req).studentEmployment.create({
    data: { ...body, student_id: studentId, tenant_id: req.user!.tid } as never,
  });
  ```
  The Zod request schemas define date fields via `Iso8601Date` (a `YYYY-MM-DD` string),
  but Prisma's `@db.Date` columns require either a `Date` instance or an ISO-8601
  *datetime* string with a time component. Prisma rejects with
  `Invalid value for argument 'started_on': premature end of input. Expected ISO-8601 DateTime.`
- **Reproduction (employment):**
  ```bash
  curl -X POST .../students/<sid>/employment \
    -H "Authorization: Bearer <c-token>" -H "Content-Type: application/json" \
    -d '{"employer_name":"Acme","work_type":"PART_TIME","started_on":"2026-04-01","hours_per_week":20}'
  # → 500 Prisma "premature end of input"
  ```
- **Why qualifications + travel + compliance + contacts pass the test:** their
  test payloads happen to omit any date field, so the bug is hidden. Real client
  payloads that include dates will all 500.
- **Suggested fix:** in every service, normalise date-only inputs before calling
  Prisma:
  ```ts
  function toPrismaDate(d?: string) { return d ? new Date(d + 'T00:00:00Z') : undefined; }
  ```
  Then build the `data` object explicitly and convert each `Iso8601Date` field.
  Alternative: change the Zod schema to coerce to a `Date` (`z.coerce.date()`),
  but that diverges from the OpenAPI contract.

---

## P1-3 — RLS GUC-missing path is permissive (cross-tenant leak risk)

- **Severity:** P1 (security defence-in-depth weakened)
- **Affected:** every `tenant_isolation` policy created in
  `apps/backend/prisma/migrations/20991231235959_init_rls_and_triggers/migration.sql`
- **Root cause:** the policy is
  ```sql
  USING (tenant_id = app_current_tenant() OR app_current_tenant() IS NULL)
  WITH CHECK (...)
  ```
  When the app neglects to call `SET LOCAL app.tenant_id = …`, the GUC is NULL,
  the OR-clause matches, and the connection sees **every tenant's rows**.
- **Proof:**
  ```bash
  $ docker exec -e PGPASSWORD=spv_app_dev_password spv-postgres \
      psql -U spv_app -d spv_dev -At -c "SELECT count(*) FROM students;"
  98     # all rows across every tenant
  $ docker exec ... psql -U spv_app -d spv_dev -At -c \
      "BEGIN; SET LOCAL app.tenant_id = '00000000-0000-0000-0000-000000000000'; SELECT count(*) FROM students; ROLLBACK;"
  0      # correctly hidden when GUC is set to a foreign tenant
  ```
- **Operational risk:** the application middleware (`tenantContext.ts:27`) does
  *not* actually call `SET LOCAL app.tenant_id`. The comment admits that the
  GUC injection "is wired up in the next milestone". Until that lands, every
  Prisma query runs with a NULL `app.tenant_id`, and the only thing keeping
  tenants apart is the application-level `where: { tenant_id: ctx.tenantId }`
  filter — RLS provides zero defence-in-depth today.
- **Suggested fix:** harden the policy to be deny-by-default:
  ```sql
  USING (tenant_id = app_current_tenant())
  WITH CHECK (tenant_id = app_current_tenant());
  ```
  Then complete the planned per-query `set_config('app.tenant_id', $1, true)`
  Prisma client extension so legitimate requests still work.

---

## P1-4 — `POST /students/:id/transitions` leaks the encrypted PII column

- **Severity:** P1 (PII exposure in API response)
- **Affected endpoint:** `POST /students/:id/transitions`
- **Location:** `apps/backend/src/modules/students/students.controller.ts:156`
  (`res.status(200).json(result)` returns the raw service result without
  passing through `redactSensitive`.)
- **Symptom:** the JSON body includes
  `"name_in_passport_enc": {"type":"Buffer","data":[1,0,60,158,…]}` — a verbatim
  copy of the encrypted bytea column, exposing ciphertext metadata and length
  to any caller that can advance a stage.
- **Reproduction:** see test log line `PII leak in POST /transitions` (FAIL).
- **Suggested fix:** wrap the service result in `redactSensitive(result)`
  (already used by `getById`, `list`, `create`) before responding. Ideally
  refactor `redactSensitive` into a shared serialiser so every Student-shaped
  response is filtered uniformly.

---

## P1-5 — Audit-log writes from `students` and `stages` controllers silently drop

- **Severity:** P1 (compliance / forensics — no audit trail for student writes)
- **Affected files:**
  - `apps/backend/src/modules/students/students.controller.ts:62, 90, 110, 147`
  - `apps/backend/src/modules/stages/stages.controller.ts:44, 62, 79, 95, 121, 138`
- **Root cause:** call signature mismatch.
  `shared/audit.ts` exports
  ```ts
  export async function writeAudit(event: AuditEvent): Promise<void>
  ```
  with camelCase keys (`tenantId`, `actorId`, `entityType`, `entityId`).
  Both controllers call it as
  ```ts
  await writeAudit(req, { action: 'student.create', entity_type: 'Student', entity_id: id, after: created });
  ```
  — wrong arity (passes `req` as `event`) and wrong key casing. The body of
  `writeAudit` then catches the resulting `prisma.auditLog.create()` failure
  (NOT NULL violation on `action` because `event.action` is undefined) and
  swallows it via the safety-net `try/catch` so the caller never notices.
- **Symptom:** `audit_logs` table contained 0 rows after creating, patching,
  transitioning, and deleting students in the test. After the fix, only the
  audit emitters that *do* call writeAudit correctly (auth.service, exports,
  documents, imports) wrote 7 rows total; the student/stage emitters wrote
  none.
- **Suggested fix:** rewrite each call site to use the helper signature, e.g.
  ```ts
  await writeAudit({
    tenantId: user.tid,
    actorId: user.sub,
    actorEmail: user.email,
    action: 'student.create',
    entityType: 'Student',
    entityId: id,
    after: created,
    ip: req.ip,
    ua: req.header('user-agent'),
    requestId: req.requestId,
  });
  ```
  Alternatively introduce a `writeAuditFromReq(req, partial)` wrapper that
  builds the AuditEvent from `req.audit` and merges in the partial. Add a unit
  test that asserts an `auditLog.create` row is produced after every
  student/stage mutation.

---

## P3-6 — `auth/login` rate-limit slow-path

- **Severity:** P3 (configuration tunable)
- **Observation:** With 12 rapid bad-cred logins, only 2 of them returned 429.
  The default `RATE_LIMIT_AUTH_PER_MINUTE = 10` (config/env.ts:39) plus the
  fact that the test happens slowly enough that the per-IP bucket only refuses
  the last two requests. Still **passes** the spec ("≥1 returned 429"), but the
  `auth/login` window is large enough that brute-force resistance is weaker
  than typical (most production setups use 5/min or 5/15min).
- **Suggested fix:** consider lowering the default to 5/min or adding a
  separate exponential lockout on repeated failures for the same email.

---

## Verified-working invariants (no defect)

- Encryption-at-rest for `name_in_passport_enc`: 106 bytes opaque ciphertext,
  no plaintext leak in raw psql `SELECT encode(name_in_passport_enc,'escape')`.
- `GET /students/:id` and `GET /students` (list) correctly redact the cipher
  column (only the transition endpoint forgot — see P1-4).
- RFC 7807 problem+json shape on 404 and on 412 (stale If-Match attempt that
  *did* still hit the validate path): all five required fields (`type`,
  `title`, `status`, `instance`, `request_id`) present.
- Pagination over 30 students: `limit=10` returns 10 rows + a `nextCursor`,
  page 2 returns the next 10.
- Idempotency on `POST /imports/:job_id/apply`: replay with the same
  `Idempotency-Key` returns byte-identical body and applies no second batch.
- Audit hash chain: `audit_logs_verify(<tenant_uuid>)` returns no broken rows
  on a 7-row chain.
- `audit_logs` immutability: `UPDATE audit_logs … WHERE id = <existing>` is
  rejected by the BEFORE UPDATE trigger with `ERROR: audit_logs is append-only`.
- RBAC denies for VIEWER on every write endpoint and for COUNSELLOR on every
  ADMIN-only endpoint (`/users`, `/dsar` list, `/sub-processors`,
  `/breach-incidents`, `/attribute-definitions`, `/message-templates`,
  `/exports` non-redacted, `/stages` write).
- Tenant cross-talk via raw psql `SET LOCAL app.tenant_id = '<bogus uuid>'`:
  rows hidden as expected (the GUC-mismatch arm of the policy works; only the
  GUC-missing arm leaks — see P1-3).

---

## Remediation priority

1. **Fix P0-1** (PATCH /students). One-line change in `students.service.ts`.
2. **Fix P0-2** (date coercion). Pattern fix across ~10 services; add a shared
   `toPrismaDate()` helper in `shared/`.
3. **Fix P1-3** (RLS GUC default). Drop the `OR app_current_tenant() IS NULL`
   clause AFTER finishing the per-query `set_config` Prisma extension so the
   app actually sets the GUC.
4. **Fix P1-4** (PII leak in transition response). One-line change in
   `students.controller.ts`.
5. **Fix P1-5** (audit-write signature). Mechanical refactor; add a regression
   test that counts `audit_logs` rows after a student create.

After remediation, re-run `bash infra/scripts/spv_deep_test.sh` to confirm the
test count returns to 126 / 126.
