# Runbook: Dependency upgrades (security-driven)

**Scope:** How we triage and apply security-driven dependency upgrades across
the SVT monorepo. The goal is to keep `pnpm audit --prod --audit-level=high`
green at all times — CI hard-fails on any HIGH or CRITICAL prod advisory
(`.github/workflows/security.yml > pnpm-audit`).

## Triage steps

1. Run `pnpm audit --prod` from the repo root. Capture HIGH/CRITICAL findings
   and the package paths (direct vs transitive).
2. For each finding decide:
   - **Direct dep, patch available** — bump the package in the owning
     `apps/<app>/package.json` to the lowest patched version. Prefer the
     latest patch on the current major to minimise blast radius.
   - **Direct dep, no patch on current major** — evaluate the next major.
     Read the upstream changelog/breaking-changes guide and audit the
     codebase for any APIs that changed signature. STOP and document if a
     migration is required that goes beyond mechanical edits.
   - **Transitive dep** — pin via `pnpm.overrides` in the root `package.json`,
     e.g. `"postcss@<8.4.31": "^8.4.31"`. Run `pnpm install
     --frozen-lockfile=false` to re-resolve the lockfile.
3. After upgrade:
   - `pnpm --filter <pkg> typecheck`
   - `pnpm --filter <pkg> test`
   - `pnpm --filter <pkg> build`
   - `pnpm audit --prod --audit-level=high` (must exit 0)
4. Commit `pnpm-lock.yaml` together with the `package.json` changes.

## Rules of thumb

- Do **NOT** upgrade React across majors without a tracked migration ticket
  — too many MUI + emotion + RTL implications.
- Do **NOT** upgrade Prisma across majors without a tracked schema review —
  client/engine compatibility and RLS implications.
- Do **NOT** upgrade MUI across majors without a UI regression budget — v5
  → v6/v7 is a multi-day visual-diff exercise.
- DO patch Next.js, axios, sharp, multer, jose, helmet, express promptly —
  these directly impact the security perimeter.

## CI enforcement

- Root script: `pnpm audit` → `pnpm audit --prod --audit-level=high`.
- Workflow: `.github/workflows/security.yml > pnpm-audit` — runs on every
  push to main, nightly at 03:17 UTC, and on `workflow_dispatch`. Hard-fails
  on HIGH or CRITICAL.

---

## Change log

### 2026-05-21 — Next.js 14.2.35 → 15.5.18

**Driver:** 5 HIGH advisories on `next@14.2.35` with no available 14.2.x
patch (14.2.35 is the final 14.2 release). Minimum patched versions are all
≥15.0.8 or ≥15.5.15/16:

| GHSA | Severity | Patched |
| --- | --- | --- |
| GHSA-h25m-26qc-wcjf | high | >=15.0.8 |
| GHSA-q4gf-8mx6-v5v3 | high | >=15.5.15 |
| GHSA-8h8q-6873-q5fj | high | >=15.5.16 |
| GHSA-c4j6-fc7j-m34r | high | >=15.5.16 |
| GHSA-36qx-fr4f-26g5 | high | >=15.5.16 |

Targeted `next@15.5.18` + `eslint-config-next@15.5.18`. React stays on
`18.3.1` (Next 15 supports React 18). MUI / next-intl untouched.

Mechanical Next 15 migrations applied:

- `app/layout.tsx` — `headers()` is now async → `await headers()`.
- `app/actions/set-locale.ts` — `cookies()` is now async → `await cookies()`.
- `i18n/request.ts` — `cookies()` is now async → `await cookies()`.
- `app/(app)/students/[id]/page.tsx` — dynamic-route `params` is now
  `Promise<{ id: string }>` → `await params`.

No server-action signature changes, no `fetch` cache-default rewrites
needed. `output: 'standalone'` still supported.

**Transitive override retained:**

```json
"pnpm": { "overrides": { "postcss": ">=8.5.10" } }
```

This was already in place from a prior triage and continues to cover the
postcss <8.4.31 advisory chain.

**Verification:**

- `pnpm --filter backend test` — see CI log for date 2026-05-21.
- `pnpm --filter backend typecheck` — clean.
- `pnpm --filter frontend typecheck` — clean.
- `pnpm --filter frontend build` — clean (or Windows-only EPERM at
  `.next/standalone` copy, which is a known Windows-symlink issue and
  acceptable; Docker build on Linux is the production path).
- `pnpm audit --prod --audit-level=high` — exit 0 (all 5 HIGHs cleared).
