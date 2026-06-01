# Quickstart

15-minute path from a clean clone to a running dev stack.

## Prerequisites

- Node 20.10+ (`nvm use` reads `.nvmrc`).
- pnpm 9+ (`corepack enable && corepack prepare pnpm@9.12.0 --activate`).
- Docker Desktop (for Postgres + Redis + ClamAV containers).
- A POSIX shell (Git Bash on Windows works fine).

## Steps

```bash
# 1. Install workspace dependencies (single lockfile, content-addressable store).
pnpm install

# 2. Copy env templates.
cp apps/backend/.env.example apps/backend/.env
cp apps/frontend/.env.example apps/frontend/.env.local
cp .env.example .env

# 3. Generate dev RSA keys for JWT signing and append to backend env.
bash infra/scripts/gen-jwt-keys.sh >> apps/backend/.env

# 4. Optional: generate a 32-byte KEK for the local KMS.
node -e "console.log('KMS_KEK_BASE64=' + require('crypto').randomBytes(32).toString('base64'))" >> apps/backend/.env

# 5. Bring up Postgres / Redis / ClamAV.
pnpm db:up

# 6. Generate Prisma client, run migrations, seed.
pnpm --filter backend prisma:generate
pnpm --filter backend prisma:migrate -- --name init
pnpm --filter backend prisma:seed

# 7. Start everything (backend on :4000, frontend on :3000).
pnpm dev
```

Open <http://localhost:3000>; sign in with the seeded admin (default `admin@example.com` / the password you set in `.env` as `SEED_ADMIN_PASSWORD`).

## Or use the helper

```bash
bash infra/scripts/start-dev.sh   # idempotent — re-run any time
pnpm dev
```

## Useful commands

| Command | Purpose |
|---|---|
| `pnpm dev` | Start backend + frontend in parallel via Turborepo. |
| `pnpm build` | Type-check + bundle all apps and shared packages. |
| `pnpm test` | Run unit + integration tests across the workspace. |
| `pnpm lint` | ESLint everywhere. |
| `pnpm typecheck` | Strict TypeScript across all projects. |
| `pnpm db:up` / `pnpm db:down` | Bring local containers up / down. |
| `pnpm prisma:studio` | Inspect the dev DB in the browser. |
| `pnpm prisma:reset` | Drop + recreate + seed the dev DB. |
| `bash infra/scripts/probe-providers.sh` | Smoke-test that providers respond. |

## Troubleshooting

- **`role "spv_app" does not exist`** — `pnpm db:down -v && pnpm db:up`. The `infra/docker/postgres-init/01-extensions.sql` script runs only on a fresh data volume.
- **JWT decode errors at startup** — re-run `bash infra/scripts/gen-jwt-keys.sh >> apps/backend/.env` and trim duplicate keys.
- **Prisma client out of date** — `pnpm --filter backend prisma:generate`.
- **Frontend cannot reach API** — check `NEXT_PUBLIC_API_BASE_URL` in `apps/frontend/.env.local` matches the backend port.
