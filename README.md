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
3. Env vars: `AUTH_USERNAME`, `AUTH_PASSWORD`, `SESSION_SECRET`, `CORS_ORIGIN`, `API_KEY` (opcional, para automações)
4. Porta: 3030 (mapear pra domínio com HTTPS automático)

## API (automações)

Toda rota `/api/*` aceita 2 modos de autenticação:

- **Cookie de sessão** (login pela UI) — uso humano.
- **API key** (env `API_KEY`) — uso programático. Passe via `Authorization: Bearer <key>` ou `X-API-Key: <key>`.

Gere uma key forte com `openssl rand -hex 32` e coloque em `API_KEY=<gerada>` no Dokploy.

### Layout do pedido

Cada `row` é um array de 10 colunas:

```
[0] ID do pedido      [5] Status            (Pronto, Separado, ...)
[1] Nome do Produto   [6] Nome destinatário
[2] Modelo            [7] Foto
[3] Qnt.              [8] Foto 2
[4] Nome de usuário   [9] + Fotos
```

### Endpoints

```bash
BASE=https://planilha-pro.144-91-112-68.sslip.io/api
KEY=$API_KEY
H="Authorization: Bearer $KEY"

# Listar planilhas
curl -H "$H" "$BASE/workbooks"

# Listar pedidos com filtros (vira o substituto do zoho_fila)
curl -H "$H" "$BASE/workbooks/<wbId>/orders?status=Separado&sheetDate=27-05-2026"

# Criar pedido novo
curl -H "$H" -H "Content-Type: application/json" \
  -d '{"id":"P001","row":["P001","Pijama X","Adulto","1","joao","Separado","Joao Silva",null,null,null],"sheetDate":"27-05-2026"}' \
  "$BASE/workbooks/<wbId>/orders"

# Atualizar apenas o status (col 5) — merge de células
curl -X POST -H "$H" -H "Content-Type: application/json" \
  -d '{"5":"Pronto"}' \
  "$BASE/workbooks/<wbId>/orders/P001/cells"

# Bulk update (várias linhas numa request)
curl -X PATCH -H "$H" -H "Content-Type: application/json" \
  -d '[{"id":"P001","cells":{"5":"Pronto"}},{"id":"P002","cells":{"5":"Pronto"}}]' \
  "$BASE/workbooks/<wbId>/orders"

# Subir foto (col 7=Foto, 8=Foto 2, 9=+Fotos)
curl -X POST -H "$H" \
  -F "image=@./foto.jpg" \
  "$BASE/workbooks/<wbId>/images/P001/7"

# Ler foto
curl -H "$H" "$BASE/workbooks/<wbId>/images/P001/7" -o foto.jpg

# Deletar foto
curl -X DELETE -H "$H" "$BASE/workbooks/<wbId>/images/P001/7"
```
