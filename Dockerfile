# One image for api, worker, receiver and the migrate/seed job; the dashboard gets its own
# nginx stage. The whole workspace is built once so workspace packages (@lab/shared, @lab/db)
# resolve exactly as they do locally.
#
# NOTE: written without access to Docker on the authoring machine; see docs/verification.md.

FROM node:22.18-bookworm-slim AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.34.7 --activate
WORKDIR /app

# Manifests first so the dependency layer is cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/receiver/package.json apps/receiver/
COPY apps/web/package.json apps/web/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY tests/package.json tests/
# .npmrc points the store at a Windows path; override it inside the container.
RUN pnpm install --frozen-lockfile --store-dir /pnpm/store

COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN pnpm --filter @lab/shared --filter @lab/db --filter @lab/api --filter @lab/worker \
      --filter @lab/receiver --filter @lab/web --workspace-concurrency=1 build

# ---- runtime for the Node services (api | worker | receiver | migrate) ----
FROM node:22.18-bookworm-slim AS app
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
# Overridden per service in docker-compose.yml.
CMD ["node", "apps/api/dist/main.js"]

# ---- static dashboard behind nginx (proxies /api to the api service) ----
FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
