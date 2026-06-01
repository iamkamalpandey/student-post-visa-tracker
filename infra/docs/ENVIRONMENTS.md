# Environments

Three deployment environments. Same image, different configuration. **Never** rebuild for an environment — promote the build artifact instead.

## Matrix

| Concern | dev (local) | staging | production |
|---|---|---|---|
| Backend host | docker compose | Fly.io / Render / Hetzner | same as staging, separate region |
| Frontend host | `next dev` | Vercel `staging` | Vercel `production` |
| Postgres | docker postgres:16 | Neon branch / managed PG (small) | Neon main / managed PG (HA, PITR ≥ 7d) |
| Redis | docker redis | Upstash free | Upstash paid / Elasticache |
| Object storage | local `storage/` | R2/S3 `spv-staging` | R2/S3 `spv-prod` (versioning + Object Lock) |
| KMS | LocalKms (file KEK) | AWS KMS / GCP KMS / Vault dev | same as staging, prod key with rotation |
| Secrets | `.env` (gitignored) | Vercel/Fly secrets + Vault | Vault/SSM, no human read |
| Domain (BE) | localhost | `staging-api.spv.example` | `api.spv.example` |
| Domain (FE) | localhost | `staging.spv.example` | `app.spv.example` |
| Email/SMS | mailhog / console | provider sandbox | live providers |
| Logs | console pretty | Better Stack / Logtail | Better Stack with retention lock |
| Errors | console | Sentry (staging project) | Sentry (prod project, alerts on) |
| Data | seed only | seed + scrubbed prod sample | real |

## Promotion

`dev → PR (preview env) → staging (auto on merge to main) → prod (manual one-click promote of the staging image)`.

## Required environment variables (per app)

See `apps/backend/.env.example` and `apps/frontend/.env.example`. Anything new must be:

1. Added to the example file with a comment.
2. Added to the Zod env schema (`apps/backend/src/config/env.ts`) so the process refuses to start with bad config.
3. Set in every environment's secret store before the next deploy.

## DR & retention

- **Postgres** — managed PITR enabled; nightly logical dump shipped to a separate object-store account; quarterly restore drill (see `runbooks/db-restore.md`).
- **Object storage** — versioning + Object Lock on prod bucket; cross-region replication for prod; staging bucket has 30-day lifecycle.
- **Logs** — 90 days minimum on prod with retention lock; 7 days on staging; 1 day on dev.
- **Audit log** — append-only with hash chain (DB triggers); daily Merkle root anchored to a separate WORM bucket.

## Scaling pointers

- BE statelessness: refresh token store and rate-limit are in Postgres / Redis, not in-process. New replica spins up with no warmup.
- FE statelessness: Next.js standalone output, no server-side session.
- DB connection pooling: PgBouncer in front of prod Postgres; Prisma `connection_limit` set per replica based on `pool_size / replicas`.

## Cost-bound starter stack (~$40–80/mo)

- BE: Fly.io 2 small machines (~$10–20).
- FE: Vercel Pro ($20).
- DB: Neon Scale ($19) — branching gives ephemeral PR DBs.
- Redis: Upstash pay-as-you-go.
- Storage: Cloudflare R2 (no egress fees).
- KMS: AWS KMS ($1/key) or Cloudflare KMS-as-code.
- Logs: Better Stack Free or self-hosted Loki on the BE host.
- Sentry: Team ($26).
