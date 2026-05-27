# Planilha Pro

Planilha colaborativa de pedidos, web app self-hosted.

- Frontend: Vite + TypeScript + grid renderizada do zero (sem libs pesadas)
- Backend: Node + Express + SQLite (better-sqlite3, WAL)
- Auth: login compartilhado, HttpOnly cookie, rate-limited
- Imagens: armazenadas em disco no volume persistente
- Sync: polling 8s, last-write-wins por linha (ID do pedido)

## Configurando

Copie `server/.env.example` para `server/.env` e ajuste:

```
AUTH_USERNAME=admin
AUTH_PASSWORD=<senha-forte>
SESSION_SECRET=<32+ chars>
```

## Rodando local

```bash
# Backend
cd server
npm install
npm run dev  # tsx watch — port 3030

# Frontend (outra aba)
npm install
npm run dev  # vite — port 5174
```

Vite tem proxy `/api → :3030`, então não precisa CORS local.

## Deploy

Imagem Docker single-stage que serve client + API:

```bash
docker compose up -d --build
```

Acesse: `http://localhost:3030`

### Dokploy

1. Aplicação tipo Application (Docker Compose ou Dockerfile)
2. Volume persistente: `planilha-data` → `/data`
3. Env vars: `AUTH_USERNAME`, `AUTH_PASSWORD`, `SESSION_SECRET`, `CORS_ORIGIN`
4. Porta: 3030 (mapear pra domínio com HTTPS automático)
