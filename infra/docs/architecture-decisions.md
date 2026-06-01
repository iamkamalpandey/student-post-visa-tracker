# Architecture Decision Records (lightweight)

ADRs in this file are short. The rationale lives here so future readers do not have to mine git history. Add new decisions to the bottom; do not edit historical entries.

---

## ADR-001 — Monorepo with pnpm + Turborepo

**Status:** Accepted, 2026-05-14.
**Decision:** Single git repository containing `apps/backend`, `apps/frontend`, and shared `packages/*`. Tasks are orchestrated by Turborepo; installs by pnpm workspaces.
**Why:** Shared Zod schemas and TypeScript types between backend and frontend eliminate API-drift bugs. Turborepo's task cache makes CI fast; pnpm's content-addressable store cuts disk and install time.
**Consequence:** One PR can change both apps atomically. Deploys remain independent because each app has its own Dockerfile and CI workflow with `paths:` filters.

## ADR-002 — Postgres + Prisma

**Status:** Accepted, 2026-05-14.
**Decision:** Postgres 16 as the primary store; Prisma 5 as the ORM and migration tool.
**Why:** RLS is essential for multi-tenant isolation and Postgres is the obvious choice. Prisma's typed client gives us schema-aware query building without sacrificing raw-SQL escape hatches.
**Consequence:** We accept Prisma's migration model (immutable applied migrations; expand-then-contract for schema changes). RLS policies live in a hand-written migration appended after `prisma migrate dev`.

## ADR-003 — RS256 JWT with JWKS rotation

**Status:** Accepted, 2026-05-14.
**Decision:** Sign access tokens with RS256; expose the public key at `/.well-known/jwks.json`; pin `algorithms: ['RS256']` in verify.
**Why:** HS256 with a single shared secret has well-documented `alg: none` and HS-with-RSA-public-key confusion attacks. RS256 + JWKS lets us rotate signing keys via `kid` without forcing every consumer to rotate a shared secret.
**Consequence:** Slightly more setup (PEM keys + JWKS endpoint). Worth it.

## ADR-004 — Envelope encryption for PII

**Status:** Accepted, 2026-05-14.
**Decision:** All high-sensitivity columns (passport / visa / sponsor income / MFA secrets / audit-log diffs) are stored as AES-256-GCM ciphertext. The DEK is generated per field, wrapped with a KMS-managed KEK, and the wrapped DEK is embedded in the blob.
**Why:** Disk encryption alone does not stop a leaked snapshot or rogue DBA. Per-record DEKs make crypto-shred (delete the DEK, ciphertext is forever unreadable) viable for retention enforcement and DSAR erasure.
**Consequence:** Reading a field is a KMS unwrap + AES decrypt — measured at < 1ms locally; cache the unwrapped DEK only for the request lifetime to bound exposure. The KMS layer is abstracted so swapping LocalKms (dev) for AWS / GCP / Vault is a one-line factory change.

## ADR-005 — Append-only audit log with hash chain

**Status:** Accepted, 2026-05-14.
**Decision:** `audit_logs` is enforced as INSERT-only via DB triggers. Each row stores `prev_hash` and `entry_hash = sha256(prev_hash || canonical(row))`. A SQL function recomputes the chain on demand.
**Why:** SOC 2 CC7.2 and ISO 27001 expect tamper-evident audit trails. The chain means a single modified row breaks verification and we can identify exactly where.
**Consequence:** A daily Merkle root must be anchored to a write-once external store (S3 Object Lock) — the chain alone proves nothing if the attacker can rewrite the latest tail. This anchor job ships in v2; v1 logs the root.

## ADR-006 — Dynamic lifecycle stages, not enum

**Status:** Accepted, 2026-05-14.
**Decision:** Lifecycle stages live in a `lifecycle_stages` table (per-tenant, ordered, optional transition matrix). They are not a TypeScript enum.
**Why:** Each consultancy tracks slightly different stages; destination countries (UK, US, AU, CA) impose their own milestones (CAS, I-20, COE, PGWP). Hard-coding would force a code change for every new market.
**Consequence:** Stage IDs are UUIDs (not human-readable). The frontend reads labels from the lookup table. Country templates seed common chains for new tenants in one click.

## ADR-007 — TanStack Table over MUI X DataGrid (free)

**Status:** Accepted, 2026-05-14.
**Decision:** The main Students list uses TanStack Table v8 with `@tanstack/react-virtual`. MUI X DataGrid is reserved for short sub-tables inside the detail view.
**Why:** Free MUI X lacks row grouping, aggregation, and column pinning — all expected for power-user workflows. TanStack Table is unopinionated and integrates cleanly with our MD3 token layer.
**Consequence:** A bit more glue (saved views, virtualisation, server-side filtering) is hand-written. Worth it for the scale we are targeting.

## ADR-008 — RFC 7807 Problem Details

**Status:** Accepted, 2026-05-14.
**Decision:** Every error response is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, `errors[]`, and `request_id`.
**Why:** Standard, widely-supported by clients (axios + frontend ApiError class), surfaces structured field errors without bespoke wrapping.
**Consequence:** All controllers throw `HttpError` variants; the global error middleware emits the canonical shape. Clients can rely on the contract.

---

Add new ADRs below.
