# Planilha Pro — contexto pra Claude Code

App de gestão de pedidos colaborativo. Sucessor do `univer-coolify`. Veja `memory/MEMORY.md` pra contexto completo.

## Stack
- Frontend: Vite + TypeScript + Tailwind, grid renderizada com DOM puro (sem React)
- Backend: Express + better-sqlite3 (WAL) em `server/`
- Auth: cookie de sessão (UI) + `API_KEY` na env (Bearer / X-API-Key) pra automações
- Deploy: Dockerfile multi-stage → Dokploy (Contabo VPS), volume `/data` persistente
- Sync: polling 8s, merge por `(workbook_id, id)`. Polling pausado durante PATCHes em lote (`withPollingPaused`)

## Modelo de dados (multi-workbook desde 2026-05-27)

```
workbooks (id, name, created_at, updated_at, column_widths)
orders    (workbook_id, id, ...)  PK (workbook_id, id) FK CASCADE
images    (workbook_id, order_id, col, ...)  PK e FK compostos
```

Migration automática no boot converte DBs legados single-workbook. Backup em `/data/planilha.db.pre-multiworkbook.bak`.

## Estrutura fixa da planilha (10 colunas — não inverter)

`A=ID do pedido | B=Nome do Produto | C=Modelo (filtro) | D=Qnt. (centralizada) | E=Nome de usuário (copiar) | F=Status (dropdown + filtro, 2-click pra editar) | G=Nome do destinatário (sort) | H=Foto | I=Foto 2 | J=+ Fotos`

Colunas K-O (10-14) são livres pra anotações. Grid expande até `O`.

## API (automações)

Toda rota `/api/*` aceita cookie de sessão OU `Authorization: Bearer $API_KEY` / `X-API-Key: $API_KEY`.

Endpoints chave:
- `GET /workbooks` — lista
- `GET /workbooks/:wb/orders?status=&sheetDate=` — filtros (substitui zoho_fila)
- `POST /workbooks/:wb/orders` — criar (row inteira ok)
- `PATCH /workbooks/:wb/orders` — bulk update SÓ status: `[{id, status}]`
- `DELETE /workbooks/:wb/orders?sheetDate=DD-MM-YYYY` — apaga todos os pedidos da data
- `POST/GET/DELETE /workbooks/:wb/images/:orderId/:col` — fotos

**Restrições por design (não readicionar)**: via API só dá pra mudar status e foto em pedido existente. Etiquetas são MANUAIS na UI. Demais campos só na criação. README da raiz tem exemplos curl.

## Produção (em 2026-05-28)
- URLs (ambas servem tudo — UI + API):
  - https://planilha.guilhermesales.com (canonical, desde 2026-05-28)
  - https://planilha-pro.144-91-112-68.sslip.io (legado sslip)
- Repo: https://github.com/gsalesx/planilha-pro (público)
- Dokploy app: `wlWGFdMbDH8BKdDyPtFJE` — autodeploy via webhook **NÃO funciona**, sempre disparar via `mcp__dokploy-mcp__application-deploy`
- Login/API key: ver `memory/reference-planilha-pro-prod.md` e `memory/reference-planilha-pro-api.md`
- **Backup diário** pra Google Drive (`Joao e Maria:planilha-pro-backups/`) via Schedule Dokploy `qHAjmxrhg-BbH34kgn7_r` (cron `0 3 * * *` BRT). Mantém os 3 mais recentes. Script: `/usr/local/bin/backup-to-drive` (de `scripts/backup-to-drive.sh`).

## Comandos comuns

```bash
# Dev local (precisa ter rodado npm install em raiz e em server/)
cd server && npm run dev    # backend na :3030
npm run dev                  # frontend Vite na :5174 (proxy /api → :3030)

# Build prod
docker compose up -d --build

# Type-check antes de push
./node_modules/.bin/tsc --noEmit
cd server && ./node_modules/.bin/tsc --noEmit
```

## Convenções
- Não criar `Data` como coluna (usuário rejeitou) — data fica no campo `sheet_date` da row, mostrada via `<select>` no header
- Datas no banco salvas como `DD-MM-YYYY` (parser normaliza `YYYY_MM_DD` legado)
- Imagens em disco em `/data/images`, JPG q=0.85 (cliente converte antes do upload)
- Não usar S3/MinIO — usuário confirmou 1GB cabe no volume
- Atualizar Planilha (XLSX) = **merge por ID do pedido**, preserva status/etiqueta/foto, marca sumidos em laranja
- Atualizar Fotos (XLSX) = só fotos das colunas 7/8/9, match por ID, ignora IDs sem match
- `+ Nova planilha` SEMPRE via upload XLSX (nunca cria vazia)
- Duplicar planilha copia também os arquivos de imagem em disco
- Status popover só abre no 2º click (1º só seleciona) — mesmo padrão das fotos vazias
- Etiquetas (`styles.bg`) são SÓ manuais na UI — não expor via API
- Antes de operações em lote (etiqueta, cell change em massa), use `withPollingPaused` pra não correr com o refresh
- Numeração de linha (`row-num`) é por filtro: posição no `visibleOrder + 1`, não índice absoluto
- Apagar data = `DELETE /workbooks/:wb/orders?sheetDate=X` (deleta orders + arquivos de imagem). Data some do `<select>` sozinha quando perde todos os orders
- Diálogos modais (confirm/prompt) vivem em `src/dialog.ts` — não duplicar a função
