# syntax=docker/dockerfile:1.6

# ----- Stage 1: build client (Vite) -----
FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY index.html ./
COPY vite.config.ts tsconfig.json tailwind.config.js postcss.config.js ./
COPY src ./src
COPY public ./public
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
RUN apk add --no-cache tini python3 make g++

# Production server deps (better-sqlite3 needs native build)
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

# Remove compilers after install (image stays small)
RUN apk del python3 make g++

# Compiled server
COPY --from=server-build /app/server/dist ./dist

# Vite client build → served as static
COPY --from=client-build /app/client/dist ./public

ENV NODE_ENV=production
ENV PORT=3030
ENV DATA_DIR=/data
EXPOSE 3030
VOLUME ["/data"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/index.js"]
