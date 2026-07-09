# syntax=docker/dockerfile:1.6

# ----- Stage 1: build client (Vite) -----
FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY index.html shopee-test.html shopee-products.html parse-issues.html ./
COPY vite.config.ts tsconfig.json tailwind.config.js postcss.config.js ./
COPY src ./src
RUN npx vite build

# ----- Stage 2: build server (Express + SQLite) -----
FROM node:22-alpine AS server-build
WORKDIR /app/server
RUN apk add --no-cache python3 make g++
COPY server/package.json server/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build

# ----- Stage 3: runtime -----
FROM node:22-alpine AS runtime
WORKDIR /app
RUN apk add --no-cache tini libstdc++ libgcc tar gzip curl rclone

# Production server deps (better-sqlite3 needs native build)
COPY server/package.json server/package-lock.json* ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
  && npm install --omit=dev --no-audit --no-fund \
  && npm cache clean --force \
  && apk del .build-deps

# Compiled server
COPY --from=server-build /app/server/dist ./dist

# Catálogo builtin do picker de emoji (server/assets/emojis) — estático, servido em /emoji-assets
COPY server/assets ./assets

# Vite client build → served as static
COPY --from=client-build /app/client/dist ./public

# Script de backup (chamado via Dokploy Schedule)
COPY scripts/backup-to-drive.sh /usr/local/bin/backup-to-drive
RUN chmod +x /usr/local/bin/backup-to-drive

ENV NODE_ENV=production
ENV PORT=3030
ENV DATA_DIR=/data
EXPOSE 3030
VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
