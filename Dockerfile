# Multi-stage build -> small final image (Next.js "standalone" output only
# copies the files actually needed to run, not full node_modules/source).

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build-time env vars aren't needed here -- nothing in this app reads
# process.env at build time in a way that bakes secrets into the bundle,
# they're all read at request time. Real values are supplied at runtime
# via docker-compose's env_file.
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# Where the embedded SQLite clients database lives. Must be a persistent
# volume in Coolify (Storages tab, mounted at /app/data) -- the rest of the
# container filesystem is wiped on every redeploy. See docker-compose.yml.
ENV CLIENTS_DB_PATH=/app/data/clients.db

# Deliberately running as root here (dropped the non-root "nextjs" user this
# image used to run as) -- a mounted volume's ownership can override
# whatever a chown'd image layer set up underneath it, which would silently
# break writes to /app/data depending on how Coolify provisions the volume.
# Root sidesteps that permission class entirely. This is a small internal
# admin tool, not a public multi-tenant service, so the tradeoff favors
# operational simplicity here.
RUN mkdir -p /app/data

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static

EXPOSE 3000
CMD ["node", "server.js"]
