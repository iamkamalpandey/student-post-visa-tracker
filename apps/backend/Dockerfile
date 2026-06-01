# Multi-stage Docker build for the backend service.
#
# SVT-SUPPLY-CHAIN-2026-05 — base image SHOULD be pinned to a SHA digest in
# prod builds (supply-chain immutability + reproducibility for SOC2 evidence):
#   FROM node:20-bookworm-slim@sha256:<digest> AS deps
# Pull the current digest before each release:
#   docker pull node:20-bookworm-slim \
#     && docker inspect --format='{{index .RepoDigests 0}}' node:20-bookworm-slim
# Bump via Renovate/Dependabot weekly.
#
# Stage 1 — build pnpm workspace (only the packages backend depends on).
FROM node:20-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json .npmrc* ./
COPY apps/backend/package.json apps/backend/
COPY packages/api-types/package.json packages/api-types/
COPY packages/zod-schemas/package.json packages/zod-schemas/
COPY packages/utils/package.json packages/utils/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/eslint-config/package.json packages/eslint-config/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
COPY packages packages
COPY apps/backend apps/backend
RUN pnpm --filter @spv/tsconfig --filter @spv/eslint-config --filter @spv/utils --filter @spv/zod-schemas --filter @spv/api-types build
RUN pnpm --filter backend prisma:generate
RUN pnpm --filter backend build

# Stage 2 — runtime.
# We deliberately do NOT use distroless: the Prisma binary engine
# (engineType=binary in schema.prisma) dlopens libssl3 + libcrypto3 + libgcc, none of
# which ship in distroless. node:20-bookworm-slim is ~70MB compressed and has them.
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=4000
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 1001 spv \
 && useradd --system --uid 1001 --gid spv spv

COPY --from=build --chown=spv:spv /repo/apps/backend/dist ./dist
COPY --from=build --chown=spv:spv /repo/apps/backend/node_modules ./node_modules
COPY --from=build --chown=spv:spv /repo/apps/backend/prisma ./prisma
COPY --from=build --chown=spv:spv /repo/apps/backend/package.json ./package.json
COPY --from=build --chown=spv:spv /repo/packages/api-types/dist ./node_modules/@spv/api-types/dist
COPY --from=build --chown=spv:spv /repo/packages/api-types/package.json ./node_modules/@spv/api-types/package.json
COPY --from=build --chown=spv:spv /repo/packages/zod-schemas/dist ./node_modules/@spv/zod-schemas/dist
COPY --from=build --chown=spv:spv /repo/packages/zod-schemas/package.json ./node_modules/@spv/zod-schemas/package.json
COPY --from=build --chown=spv:spv /repo/packages/utils/dist ./node_modules/@spv/utils/dist
COPY --from=build --chown=spv:spv /repo/packages/utils/package.json ./node_modules/@spv/utils/package.json

USER spv
EXPOSE 4000
# Liveness probe — backend serves /api/v1/health/livez (no auth, no DB ping).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health/livez',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
# SVT-DEPLOY-2026-05 — migrations are NOT run by the runtime container.
# Running `prisma migrate deploy` here creates a race when N replicas start
# simultaneously (advisory lock on _prisma_migrations) and blocks readiness
# on long migrations. Ship migrations via a one-shot pre-deploy task:
#
#   k8s Job (helm.sh/hook: pre-upgrade,pre-install, hook-weight: -5)
#     OR
#   ECS RunTask gated in the CI pipeline before the service update.
#
# Both use the SAME image with command override:
#   ["node", "node_modules/prisma/build/index.js", "migrate", "deploy"]
# and DATABASE_URL set to DATABASE_MIGRATE_URL (owner role `spv`, not the
# runtime `spv_app`). The service deploys only after the job exits 0.
# Runtime containers run server.js only and use spv_app under RLS.
CMD ["node", "dist/server.js"]
