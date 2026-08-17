# Multi-stage Docker build for the Next.js frontend.
FROM node:26-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json .npmrc* ./
COPY apps/frontend/package.json apps/frontend/
COPY packages/api-types/package.json packages/api-types/
COPY packages/zod-schemas/package.json packages/zod-schemas/
COPY packages/utils/package.json packages/utils/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/eslint-config/package.json packages/eslint-config/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

FROM deps AS build
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_APP_NAME="Student Post-Visa Tracker"
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL
ENV NEXT_PUBLIC_APP_NAME=$NEXT_PUBLIC_APP_NAME
COPY packages packages
COPY apps/frontend apps/frontend
RUN pnpm --filter @spv/tsconfig --filter @spv/eslint-config --filter @spv/utils --filter @spv/zod-schemas --filter @spv/api-types build
# Emit .next/standalone for the runtime image (gated in next.config.mjs).
ENV NEXT_OUTPUT=standalone
RUN pnpm --filter frontend build

FROM node:26-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates dumb-init \
 && rm -rf /var/lib/apt/lists/*
RUN groupadd --system --gid 1001 next \
 && useradd --system --uid 1001 --gid next --create-home next
COPY --from=build --chown=next:next /repo/apps/frontend/.next/standalone ./
COPY --from=build --chown=next:next /repo/apps/frontend/.next/static ./apps/frontend/.next/static
COPY --from=build --chown=next:next /repo/apps/frontend/public ./apps/frontend/public
USER next
EXPOSE 3000
# Liveness probe — Next standalone server returns 200 on the root locale route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||3000)+'/',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/frontend/server.js"]
