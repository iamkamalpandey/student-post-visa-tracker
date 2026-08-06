# SPVT — What the next version should be

**Date:** 2026-08-06 · **Method:** every version number and date below was read from a primary source (npm registry, nodejs/Release `schedule.json`, `nextjs.org/support-policy`, Prisma upgrade docs) or from this repository's own files. Nothing is recalled from memory. Where something could not be established from evidence, it is listed in §7 as an open question rather than assumed.

---

## 1. The finding that sets the agenda

**Production runs an end-of-life Node.js.**

- `.nvmrc` → `20`
- `package.json` → `"engines": { "node": ">=20.10.0" }`
- `apps/backend/Dockerfile:12,36` and `apps/frontend/Dockerfile:2,27` → `FROM node:20-bookworm-slim`
- All three CI workflows resolve their Node version from `.nvmrc`

Per `nodejs/Release/schedule.json`, Node 20 (Iron) ended **2026-04-30**. nodejs.org's release table now lists v20 as `EOL` outright. That was over three months ago. The runtime serving customer data receives no security patches, and neither does CI.

This is not a "should upgrade eventually" item. It is a live, dated exposure, and it is the root of the dependency chain in §3.

---

## 2. Verified version drift

| Component | This repo pins | Current | Support status (primary source) |
|---|---|---|---|
| **Node.js** | 20 (`.nvmrc`, both Dockerfiles, engines) | 22 · 24 | **v20 EOL 2026-04-30 — passed.** v22 EOL 2027-04-30, v24 EOL 2028-04-30 |
| **Next.js** | 15.5.21 | 16.3.0 | 15.x is **Maintenance LTS**; 2 years from 2024-10-21 → **EOL ≈ 2026-10-21 (~11 weeks)** |
| **React** | 18.3.1 | 19.2.8 | Next 16 requires react/react-dom **≥ 19** |
| **MUI** | ^5.16.7 | 9.3.0 | **4 majors behind.** v9 peer allows React ^17 ‖ ^18 ‖ ^19 |
| **Prisma** | ^5.22.0 | 7.9.1 | v6 line still receives security patches; v5 does not |
| **Express** | ^4.21.0 | 5.2.1 | v4 fixes are discretionary, not a commitment |
| **TypeScript** | ^5.6.2 | 7.0.2 | major jump — evaluate separately (§6) |
| **Vitest** | 2.1.x | 4.1.10 | 2 majors |
| **Zod** | ^3.23.8 | 4.4.3 | 1 major |
| **pino** | ^9.5.0 | 10.3.1 | 1 major |
| **jose** | ^5.9.6 | 6.2.8 | 1 major |
| **TanStack Query** | ^5.59.0 | 5.101.4 | same major — patch only |
| **PostgreSQL** | 16 (prod `.do/app.yaml`, dev compose, CI) | — | **supported to Nov 2028 — no action** |

Two things worth stating plainly. PostgreSQL is consistent across production, development and CI, and is good for another two years: **do not touch it.** And TanStack Query is only patches behind: also nothing to do. Everything else has moved.

---

## 3. The critical path — why this is one chain, not a list

The frontend upgrades cannot be picked à la carte:

```
Next 15 EOL (21 Oct 2026)
   └─ requires → Next 16
        └─ requires → React ≥ 19
             └─ forces → MUI ≥ 6   (realistically → 9)
```

React 19 changed how React elements are identified, and MUI ships `react-is` matched to its own line. MUI's own installation docs warn that a mismatched `react-is` causes **runtime errors in prop-type checks** — not a compile error you would catch in CI, a runtime failure in the browser. So React 19 is not adoptable while MUI stays on v5.

**MUI 5 → 9 is therefore the single largest piece of work in the whole plan**, and it is forced by a date the team does not control.

The backend chain is **independent** and can proceed in parallel with a different owner:

```
Node 20 EOL (passed)
   └─ Node 22 or 24
        ├─ Prisma 7   (ESM + driver adapter)
        └─ Express 5
```

---

## 4. Repo-specific migration risks

These are the things that will actually bite in *this* codebase, as opposed to generic upgrade advice.

**4.1 Prisma 7 mandates a driver adapter, and the pool defaults change underneath you.**
Prisma 7 requires `@prisma/adapter-pg`. Per Prisma's own docs, driver adapters take their pool settings from the underlying `pg` driver — and **`pg` defaults to no connection timeout (0), where Prisma v6 used 5 seconds.** The reliability audit already established that this repo sets `connection_limit` nowhere and instantiates **two** PrismaClients (`prisma` + `prismaAdmin`). Migrating without setting pool configuration explicitly converts a latent problem into a stall with no timeout to break it. Pool sizing must be decided *as part of* this upgrade, not after.

**4.2 The good news: ESM is already done.**
Prisma 7 is ESM-only and requires `"type": "module"`. `apps/backend/package.json:5` already sets it. The most commonly painful part of this migration does not apply here.

**4.3 `$extends` survives — the tenant isolation design is safe.**
Client extensions remain fully supported in v7 and are now the recommended replacement for the removed middleware API. `middlewares/tenantContext.ts` is built on `$extends`, so the architecture holds. The `set_config` + transaction pattern for RLS is still the documented approach — but it must be **re-verified against the adapter**, because the GUC is per-connection and the adapter manages pooling differently from the old query engine.

**4.4 Prisma 7 moves the datasource URL to `prisma.config.ts` — fix the existing bug at the same time.**
The `url` field in the datasource block is deprecated in favour of `prisma.config.ts`. The reliability audit found that `prisma migrate deploy` reads `DATABASE_URL` and never `DATABASE_MIGRATE_URL`, so the same key needs two different values in two components with nothing documenting it. That contract has to be touched anyway during this migration — fix it once, properly, rather than twice.

**4.5 Express 5 retires a whole class of latent bug.**
Express 5 forwards rejected promises from async handlers to error middleware automatically. The architecture audit flagged that there is no `no-floating-promises` lint rule and that `server.ts` exits the process on any unhandled rejection — meaning the discipline is held by code review alone. Express 5 converts part of that risk into ordinary error handling.

**4.6 ESLint was broken and blocked the whole plan — now fixed.**
`packages/eslint-config/index.js` was legacy eslintrc format while ESLint 9 requires flat config, so `pnpm --filter backend lint` failed repo-wide and any upgrade of this size would have been done blind. Migrated to flat config (`eslint.config.mjs` in the four linted packages); backend lint now exits 0. Re-enabling it surfaced 14 real errors, all fixed rather than downgraded — chiefly ten `as any` casts on dynamically built Prisma `where` objects, now typed as the proper `Prisma.*WhereInput`. 33 warnings remain as visible debt.

One deliberate gap: `eslint:recommended` is not applied, because its flat equivalent lives in `@eslint/js`, which is not a declared dependency of the config package. Adding it is a small follow-up.

---

## 5. Recommended shape: three releases, in this order

### v-next.0 — "Make the upgrade survivable" *(prerequisite, days)*
Do not begin a platform migration with no error tracking, no alerting and no tested restore. From `SPVT-MATURITY-ROADMAP.md` §1:

- Install `@sentry/node` — it is referenced throughout and **present in neither `package.json` nor the lockfile**, so every `captureException` is currently a no-op.
- Add DigitalOcean `alerts:` + `log_destinations:`.
- Uncomment the backup cron in `db-backup.yml` and perform **one real restore**.
- ~~Migrate `packages/eslint-config` to flat config~~ — done; add `@eslint/js` so `eslint:recommended` applies again.

Rationale: if the Prisma or MUI migration breaks something subtly in production, today there is no mechanism by which anyone would find out, and no verified way back.

### v-next.1 — "Supported platform: backend" *(2–3 weeks, backend owner)*
No feature work. Runtime currency only.

- Node 20 → **24** (`.nvmrc`, both Dockerfiles, `engines`). Choosing 24 over 22 buys until 2028-04-30 instead of 2027-04-30, for the same effort.
- Prisma 5 → 7: driver adapter, `prisma.config.ts`, explicit pool config (§4.1), re-verify RLS GUC behaviour under the adapter (§4.3), fix the migrate-URL contract (§4.4).
- Express 4 → 5.
- pino 9 → 10, jose 5 → 6, vitest 2 → 4.

**Gate:** the RLS integration test must pass against a real Postgres before this merges. Given §4.3, that test is the entire safety argument for this release.

### v-next.2 — "Supported platform: frontend" *(4–6 weeks, must land before 21 Oct 2026)*
- MUI 5 → 9 (the bulk of the work).
- React 18 → 19.
- Next 15 → 16. Note Next 16 removes the Pages Router entirely and drops Babel; this repo is already App Router with 47 `page.tsx` and zero `'use client'` at page level, so that specific breaking change should be low-cost — but verify before committing to the estimate.

**Natural pairing:** the accessibility work from the maturity roadmap (contrast tokens, RTL decision, tabpanel ARIA) touches the same component layer as the MUI migration. Doing them together costs meaningfully less than doing them separately, because both require re-testing every screen.

---

## 6. Deliberately excluded from v-next

- **PostgreSQL** — 16 is supported to Nov 2028 and is consistent across all three environments. Changing it would add risk for zero benefit.
- **TanStack Query** — patch-level drift only.
- **TypeScript 5.6 → 7.0** — a major rewrite of the compiler. It should be evaluated on its own merits with its own rollback plan, not bundled into a release whose purpose is to restore supportability. Bundling it would make any regression impossible to attribute.
- **Zod 3 → 4** — a major with a wide blast radius across `packages/zod-schemas`, which every request boundary depends on. Worth doing, but not while two other majors are in flight.

---

## 7. Open questions — flagged rather than assumed

1. **Is there any EU customer exposure?** This matters because the European Accessibility Act has been enforceable since **28 June 2025**, with EN 301 549 (WCAG 2.1 AA today; draft 4.1.1 expected 2026 raising it to WCAG 2.2 AA) as the presumed-compliance standard, and member-state penalties running from roughly €10k–€300k per violation. Accessibility documentation (VPAT) is now routinely required in EU public-sector and education procurement.

   The evidence *in this repo* points away from the EU: `V2_INGEST_DEFAULT_CURRENCY=NPR` in both `.env.example` and `.do/app.yaml`, and shipped locales of `en`/`ar`/`hi`/`ne`. That reads as South Asia and the Gulf. **I cannot determine the customer geography from code**, so I am not going to rank EAA as a forcing function. If any EU institution is a customer or a prospect, it becomes one immediately and v-next.2's accessibility scope should expand accordingly.

2. **Node 22 or 24?** I recommend 24 (EOL 2028-04-30 vs 2027-04-30). If a production dependency turns out to lack a prebuilt binary for 24, 22 is the fallback — `sharp` and `argon2` are the two to check first, since both ship native code.

3. **Is the DigitalOcean managed database actually on PG 16?** `.do/app.yaml` declares `version: "16"`, but the reliability audit noted the deployment path is not fully verified. Confirm against the live cluster before planning around it.

---

## 8. Sequencing summary

| Release | Gate to start | Hard deadline | Verification that must pass |
|---|---|---|---|
| v-next.0 | none | none — but blocks everything | one successful restore drill; `pnpm lint` exits 0 |
| v-next.1 | v-next.0 done | none dated, but Node is already EOL | RLS integration test green against real Postgres |
| v-next.2 | v-next.0 done (can run parallel to .1) | **2026-10-21** (Next 15 EOL) | full suite + a11y pass on every screen |

The two platform releases are independent and can run concurrently with separate owners. Only v-next.0 is strictly serial, and it is the cheapest of the three.

---

## Sources

Primary sources consulted for the dates and versions in §2:

- [Node.js previous releases](https://nodejs.org/en/about/previous-releases) and [nodejs/Release schedule.json](https://raw.githubusercontent.com/nodejs/Release/main/schedule.json)
- [Next.js support policy](https://nextjs.org/support-policy) · [Next.js 16 release notes](https://nextjs.org/blog/next-16) · [Upgrading to version 16](https://nextjs.org/docs/app/guides/upgrading/version-16)
- [Upgrade to Prisma ORM 7](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7) · [Prisma 7 announcement](https://www.prisma.io/blog/announcing-prisma-orm-7-0-0) · [Prisma database drivers](https://www.prisma.io/docs/orm/overview/databases/database-drivers)
- [PostgreSQL versioning policy](https://www.postgresql.org/support/versioning)
- [Express 5 release coverage](https://www.infoq.com/news/2025/01/express-5-released/)
- [Material UI installation / peer versions](https://mui.com/material-ui/getting-started/installation/) · [Upgrade to MUI v7](https://mui.com/material-ui/migration/upgrade-to-v7/)
- npm registry `latest` for react, next, prisma, vitest, typescript, express, @tanstack/react-query, zod, pino, jose, @mui/material
- [European Accessibility Act enforcement](https://www.pivotalaccessibility.com/2025/09/eaa-enforcement-in-europe-following-the-june-2025-deadline/) · [EN 301 549 / EAA for SaaS](https://www.accessibility.works/blog/saas-eaa-compliance-european-accessibility-act-en-301-549-requirements/)
