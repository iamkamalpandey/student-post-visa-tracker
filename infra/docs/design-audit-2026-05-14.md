# Design audit — 2026-05-14

A holistic visual polish pass after the TextField legend strikethrough patch
landed in `apps/frontend/theme/theme.ts` (`legend { font-size: 0.75em; padding: 0 }`).
The brief: make every screen look like one product.

## Phase 1 — audit

### Canonical tokens (apps/frontend/theme/{tokens,theme}.ts)

- **Brand seed:** `#1A73E8` (primary), `#7E57C2` (tertiary accent).
- **Typography:** Roboto Flex; MD3 type scale; `h4 = headline.small (24/32, 500)`;
  `h6 = title.medium (16/24, 500)`; body1 = body.large.
- **Spacing:** 8 px base. Page Stack rhythm = 3 (24 px).
- **Shape:** `xs 4 / sm 8 / md 12 / lg 16 / xl 28 / full 999`. Theme `borderRadius`
  is set to `shape.md` (12). `MuiButton` defaults to `shape.lg` (16). Cards default
  to `shape.md`.
- **Surface roles:** MD3 `outlineVariant` is exposed via `palette.divider` so
  outlined cards already get the soft border (no harsh hairline).
- **Motion:** MD3 standard easing `cubic-bezier(0.2,0,0,1)`. Already wired into
  `MuiButton` root override (`transition: background-color … standard`) and
  `MuiCard` (`box-shadow … standard`). Verified — no further change needed.

### Canonical components

| Component | Observation |
| --- | --- |
| `ListPageShell` | Defines the canonical page header (`h4 600 letterSpacing -0.2` + `body1 secondary`), filter bar (Paper outlined, 16 px padding, radius 2), table card (Card outlined radius 2), outer Stack `spacing={3}`. |
| `PageHeader` | Older variant using `h5 700`. Only used by detail pages, so left untouched. |
| `EmptyState` / `ErrorState` / `LoadingSkeleton` | Already consistent. |
| `DataTable` | Used by privacy + DSAR + sub-processor tables. Head cells were `fontWeight 700` (no caps). Tightened to MD3 column-label style. |
| `ConfirmDialog` | Typed-confirmation; uses h6-equivalent title weight 700, error contained primary, outlined cancel. |

### Route-level deviations

Most routes adopt `ListPageShell` and look uniform out of the box. Outliers:

- **`students/Client.tsx`** — inlines its own table head with `fontWeight 600`
  bold cells (no caps).
- **`stages/Client.tsx`** — inlines a delete dialog rather than using
  `ConfirmDialog`; head cells without typographic styling.
- **`audit/Client.tsx`**, **`breach-incidents/page.tsx`**, **`dsar/page.tsx`**,
  **`sub-processors/page.tsx`**, **`users/Client.tsx`** — `ForbiddenState`
  forks render `h4 600` *without* `letterSpacing -0.2`, so headings look
  fractionally different from the canonical pages.
- **`DashboardClient.tsx`** — already greatly improved into a full hero +
  4-card KPI + 2-column body using `Grid spacing={3}`. KPI numbers were neutral
  black; should pop with brand colour.

### Dialog deviations

Most agent-built dialogs hand-rolled their own DialogTitle/Actions, leading to
many small mismatches:

- **Title weight:** `StudentQuickCreate` & `AdvanceStageDialog` use h6 600;
  `FormDialog` uses h6 700; `CreateUser/Institution/Program/NewExport/StageEdit`
  use the bare DialogTitle default (no override).
- **Close icon:** present on `StudentQuickCreate`, `AdvanceStageDialog`,
  `FormDialog`. Absent on the others.
- **Subtitle:** sporadically present.
- **Cancel button:** sometimes plain text, sometimes `color="inherit"`;
  never `outlined`.
- **Padding:** `DialogActions` mostly `{ px: 3, py: 2 }`, but `StageEditDialog`
  used the bare default.

## Phase 2 — polish

### New canonical wrapper

`apps/frontend/components/AppDialog.tsx` (new). Wraps `Dialog` with:

- `DialogTitle` = h6 weight 600 + optional body2 secondary subtitle, top-right
  Close icon.
- `Divider` separating title from body.
- `DialogContent` with consistent padding + inline `Alert` for non-field errors.
- `DialogActions` with cancel **outlined** `color="inherit"` and primary
  **contained** with built-in `CircularProgress` loading state.
- `primaryAction` accepts either a `formId` (submits the matching `<form>`) or
  an imperative `onClick` — covers both the submit-via-form and direct-click
  patterns existing dialogs use.

`features/students/sectionShared.tsx#FormDialog` was rewritten to delegate to
`AppDialog`, so all student-section nested-resource dialogs inherit the new
chrome for free.

### Dialogs migrated

- `StudentQuickCreate` — title becomes h6 600 + subtitle, footer matches.
- `AdvanceStageDialog` — same.
- `StageEditDialog` — added subtitle; footer now uses outlined cancel.
- `CreateInstitutionDialog` — added subtitle; standardised footer.
- `CreateProgramDialog` — added subtitle; standardised footer.
- `CreateUserDialog` — added subtitle; standardised footer.
- `NewExportDialog` — added subtitle; standardised footer.
- `ComposeMessageDialog` — already used `FormDialog`, which now flows through
  `AppDialog`; no per-file edit needed.

Multi-step / specialised dialogs (`Stages` reorder warnings, `Imports/new`
wizard, `IdentifierDialog`, `RequirementDialog`, etc.) intentionally left alone
to honour the brief.

### Page-level polish

- **`app/(app)/DashboardClient.tsx`** — KPI value typography now uses
  `color: 'primary.main'` and `tabularNums` so the numbers pop as the only
  saturated element on a neutral surface.
- **`app/(app)/users/Client.tsx`**, **`audit/Client.tsx`**,
  **`breach-incidents/page.tsx`**, **`dsar/page.tsx`**,
  **`sub-processors/page.tsx`** — `ForbiddenState` h4 now carries
  `letterSpacing: -0.2` to match the canonical header.
- **`app/(app)/stages/Client.tsx`** — replaced the inline delete `Dialog` with
  `ConfirmDialog` (typed-confirmation by stage key, error variant, loading
  state, Stack-clean code path); head row adopted the new column-label style.
- **`app/(app)/students/Client.tsx`** — head row migrated to the same MD3
  column-label style: 12 px, weight 600, uppercase, 0.4 tracking, `text.secondary`,
  with subtle action-hover background and matched top + bottom 1 px dividers.

### Theme verification

- `MuiCard` outlined already uses `roles.outlineVariant` (mapped to
  `palette.divider`). Confirmed.
- `MuiButton` root already includes
  `transition: background-color 200ms cubic-bezier(0.2, 0, 0, 1)`. Confirmed.
- `MuiCard` defaults to `borderRadius: shape.md` (12). Spot checks across
  Stage/Users/Institutions/Programs etc. show no per-card override.
- Default MUI hover on TableRow remains in place; `DataTable` rows are clickable
  with a soft action-hover background.

## Per-file edit log

| File | Note |
| --- | --- |
| `apps/frontend/components/AppDialog.tsx` | **NEW** — canonical form-dialog wrapper. |
| `apps/frontend/components/DataTable.tsx` | Head cells: 12 px small-caps, secondary colour, top + bottom dividers, hover background. |
| `apps/frontend/features/students/StudentQuickCreate.tsx` | Migrated to `AppDialog`; removed bespoke title/footer. |
| `apps/frontend/features/students/AdvanceStageDialog.tsx` | Migrated to `AppDialog`. |
| `apps/frontend/features/students/sectionShared.tsx` | `FormDialog` now delegates to `AppDialog`; cleaned imports. |
| `apps/frontend/features/stages/StageEditDialog.tsx` | Migrated to `AppDialog`; added subtitle. |
| `apps/frontend/features/institutions/CreateInstitutionDialog.tsx` | Migrated to `AppDialog`. |
| `apps/frontend/features/programs/CreateProgramDialog.tsx` | Migrated to `AppDialog`. |
| `apps/frontend/features/users/CreateUserDialog.tsx` | Migrated to `AppDialog`. |
| `apps/frontend/features/io/NewExportDialog.tsx` | Migrated to `AppDialog`. |
| `apps/frontend/app/(app)/DashboardClient.tsx` | KPI value uses brand `primary.main` + tabular nums. |
| `apps/frontend/app/(app)/students/Client.tsx` | Head row → MD3 column-label style. |
| `apps/frontend/app/(app)/stages/Client.tsx` | Replaced inline delete dialog with `ConfirmDialog`; head row → MD3 column-label style; pruned unused imports. |
| `apps/frontend/app/(app)/users/Client.tsx` | `ForbiddenState` heading aligned to canonical letter-spacing. |
| `apps/frontend/app/(app)/audit/Client.tsx` | Same. |
| `apps/frontend/app/(app)/breach-incidents/page.tsx` | Same. |
| `apps/frontend/app/(app)/dsar/page.tsx` | Same. |
| `apps/frontend/app/(app)/sub-processors/page.tsx` | Same. |

## Quality bar — checks

- Spacing rhythm: every list page uses `Stack spacing={3}` (Dashboard included).
- Typography: every page heading is `h4 600 letterSpacing -0.2`. Every dialog
  title is `h6 600`. Section headings are `h6 600`.
- Colour: brand `primary.main` is the only saturated colour on neutral surfaces
  (Dashboard KPIs, primary actions, focus state). Status / role / stage chips
  remain quiet.
- Buttons: primary contained inherits `borderRadius: shape.lg`, `disableElevation`,
  no override anywhere.
- Chips: `MuiChip` keeps `borderRadius: shape.sm`, weight 500 — small and quiet.
- TypeScript: `tsc --noEmit` is clean for `apps/frontend`.
