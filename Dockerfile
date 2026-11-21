# Knockback match server (#26): the Bun server, the viewer it bundles at startup, SQLite.
#   docker build -t knockback-server --build-arg KB_VERSION=$(git rev-parse --short HEAD) .
# Config comes from the environment (see deploy/.env.example and scripts/match-server.ts).
ARG BUN_VERSION=1.3.14

FROM oven/bun:${BUN_VERSION}-slim AS deps
WORKDIR /app
COPY package.json bun.lock ./
# runtime dependencies only (pixi.js for the viewer bundle, the deterministic Rapier build)
RUN bun install --production --frozen-lockfile --ignore-scripts

FROM oven/bun:${BUN_VERSION}-slim
ARG KB_VERSION=dev
# sqlite3: online backups (deploy/backup.sh runs `sqlite3 .backup` inside the container)
RUN apt-get update \
 && apt-get install -y --no-install-recommends sqlite3 \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /data/records /data/backups \
 && chown -R bun:bun /data
WORKDIR /app
COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock tsconfig.json index.html ./
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun souls ./souls
COPY --chown=bun:bun scripts ./scripts
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=5176 \
    KB_OUT=/data/records \
    KB_DB=/data/match-server.db \
    KB_VERSION=${KB_VERSION}
USER bun
VOLUME ["/data"]
EXPOSE 5176
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||5176)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["bun", "scripts/match-server.ts"]
