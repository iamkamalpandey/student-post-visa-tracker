# SVT Deep Audit — Prioritized Backlog (2026-06-02)

Source: 9-dimension multi-agent audit (RBAC, security, a11y, i18n, UX, correctness, API, perf, GDPR) + lead synthesis. 62 raw findings → 31 deduped, ranked items. Full per-item evidence/fix/acceptance in the workflow run output (`woem8d4ai`).

Severity legend: 🔴 high · 🟠 medium · 🟡 low. Status: ☐ todo · ⏳ in-progress · ✅ done.

## Pre-audit fixes (already shipped, baseline `81c2f17`)
- CSP report-uri + `style-src-attr` (frontend middleware)
- `/auth/refresh` dedicated rate limiter (no more 5/min spurious logout)
- shared single-flight refresh (no token-family race logout)
- `server.on('error')` handler
- `redis` dependency (cross-replica MFA replay)
- programs tab title → "Courses"

## Wave 1 — Security / Authorization / Data-integrity (HIGH)
| # | Sev | Item | Status |
|---|-----|------|--------|
| 1 | 🔴 | Resend webhook HMAC always 401s in prod (global `express.json` eats raw body) | ✅ |
| 2 | 🔴 | Cross-counsellor PII IDOR: ~15 child `GET /:id` reads not ownership-gated | ✅ |
| 3 | 🔴 | User lifecycle (create/role-change/deactivate/pw-reset/revoke) writes NO audit | ✅ |
| 4 | 🔴 | Comms thread LIST leaks last-message body tenant-wide to any counsellor | ✅ |
| 5 | 🔴 | GDPR Art.17 erasure non-atomic (status COMPLETED before erase, unguarded) | ✅ |
| 6 | 🔴 | `completeRefund`/`voidPayment` double-reversal race (no idempotency/status guard) | ✅ |
| 7 | 🔴 | GDPR Art.17 erasure incomplete (address/travel/employment/etc. survive) | ✅ |
| 15 | 🟠 | `failRefund` missing MFA step-up + Idempotency-Key (siblings have them) | ✅ |
| 16 | 🟠 | DSAR status update has no status guard (concurrent PATCH runs erasure twice) | ✅ |

## Wave 2 — Data-integrity / GDPR (MEDIUM)
| # | Sev | Item | Status |
|---|-----|------|--------|
| 10 | 🟠 | Institutions + Programs mutations (incl. fee changes) write no audit | ☐ |
| 11 | 🟠 | `redact_pii=true` export still leaks full name, DOB, gender | ☐ |
| 12 | 🟠 | Export artifacts + DSAR plaintext bundles never deleted (no storage-limitation) | ☐ |

## Wave 3 — API contract
| # | Sev | Item | Status |
|---|-----|------|--------|
| 13 | 🟠 | Super-agents (~18 eps) + outbox-admin absent from OpenAPI; drift test is fake | ☐ |
| 14 | 🟠 | Pagination: cursor accepted but never returned (travel/accommodation); threads capped 200 | ☐ |
| 23 | 🟡 | Breach DELETE returns 405 as `application/json` not problem+json | ☐ |

## Wave 4 — Accessibility / i18n / UX
| # | Sev | Item | Status |
|---|-----|------|--------|
| 9 | 🔴 | Form errors not linked to inputs (no `aria-describedby`) — shared `LabeledField` | ☐ |
| 21 | 🟡 | Error toasts `aria-live=polite` not assertive | ☐ |
| 24 | 🟡 | Cmd-K palette lacks combobox/listbox ARIA | ☐ |
| 19 | 🟡 | Notification-bell badge undercounts reminders (capped 10, wrong scope) | ☐ |
| 22 | 🟡 | Bell + Admin hub not internationalized; raw `/reminders` link text | ☐ |
| 8 | 🔴 | ar/ne locale catalogs are 100% English placeholders | ☐ |
| 31a | 🟡 | hi.json unreachable dead catalog | ☐ |

## Wave 5 — Correctness / Performance (LOW, scale-time)
| # | Sev | Item | Status |
|---|-----|------|--------|
| 17 | 🟠 | Super-agent commission FX mismatch (labels SA currency, computes tuition basis) | ☐ |
| 18 | 🟡 | FinanceItem update ignores If-Match `expected` version (lost-update) | ☐ |
| 20 | 🟡 | Per-tenant rate limiter defined but never mounted | ☐ |
| 25 | 🟡 | Student BillingTab: no error state, non-standard loading, duplicate fee fetches | ☐ |
| 26 | 🟡 | Student Profile tab eagerly fires all 6 section queries on mount | ☐ |
| 27 | 🟡 | DSAR SLA watchdog: unbounded cross-tenant scan + per-row loop | ☐ |
| 28 | 🟡 | Student code via COUNT(*) under advisory lock (O(n) + soft-delete skew) | ☐ |
| 29 | 🟡 | Commission invoice-number generation not transactional (collision) | ☐ |
| 30 | 🟡 | reminderScanner commission due-date uses local TZ not UTC (off-by-one) | ☐ |
| 31b | 🟡 | admin MFA-disable uses non-strict requireMfa | ☐ |
| 31c | 🟡 | CSP report sink logs unbounded attacker-controlled fields | ☐ |

Each fix lands as its own git commit with a regression test where the acceptance criterion calls for one.
