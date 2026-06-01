# Contributing

## Branching

- `main` is the integration branch. It is always deployable. Do not commit directly.
- Feature branches are short-lived: `feat/<topic>`, `fix/<topic>`, `chore/<topic>`. Rebase onto `main` before opening a PR.
- Releases are tagged per app: `backend-vX.Y.Z`, `frontend-vX.Y.Z`. Use Changesets if multiple packages need coordinated bumps.

## Commits

Conventional Commits. The type prefix maps onto the area touched:

- `feat(students): add bulk archive endpoint`
- `fix(auth): refresh token rotation race`
- `chore(deps): bump prisma 5.22.0`
- `docs(readme): document seed flow`
- `refactor(documents): extract storage interface`
- `test(audit): cover hash-chain break`

Breaking changes use `!` (`feat(api)!: drop legacy /students-v0`).

Avoid bundling unrelated changes. Squash on merge so `main` reads clean; the PR description is the canonical change log entry.

## Pull requests

Every PR includes:

1. **What** — one paragraph explaining the change and the user-visible effect.
2. **Why** — a link to the issue, plan section, or incident. If the answer is "tech debt", say so.
3. **How tested** — commands run, automated checks added, screenshots for UI work.
4. **Risk** — DB migrations, breaking changes, performance characteristics, security surface.

Required checks: typecheck, lint, unit tests, prisma schema diff, security scan. CI is the gate; do not request review until green.

## Database migrations

- Prisma migrations are immutable once merged to `main`. Do not edit existing migration directories.
- Use the **expand-then-contract** pattern. Adding a column is one migration; switching reads is the next; dropping the old column is the third — usually across separate releases.
- Long-running migrations (large index builds, backfills) run as separate scripts under `infra/scripts/`, not as part of the migration transaction.
- Always test the migration against a staging dump before merging.

## Code style

- TypeScript strict mode everywhere. No `any` without a comment explaining the boundary.
- Prefer pure functions in `shared/` and `utils/`. Side effects live in `services/`.
- Throw typed `HttpError` variants; the error middleware emits RFC 7807.
- Validate every request with Zod (`.strict()` on objects). Never read directly from `req.body` after validation.
- Log with the request-scoped Pino instance; never `console.log` outside boot.
- Money is always integer minor units plus an ISO 4217 code; phones are E.164.

## Security review

Any PR that touches authentication, authorisation, encryption, file uploads, or data export requires a second reviewer. PRs that introduce a new third-party dependency must include the OSV-scanner output in the description.
