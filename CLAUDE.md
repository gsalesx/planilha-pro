# Planilha Pro — contexto pra Claude Code

App de gestão de pedidos colaborativo. Sucessor do `univer-coolify`. Veja `memory/MEMORY.md` pra contexto completo.

## Stack
- Frontend: Vite + TypeScript + Tailwind, grid renderizada com DOM puro (sem React)
- Backend: Express + better-sqlite3 (WAL) em `server/`
- Auth: login compartilhado (HttpOnly cookie), rate-limited
- Deploy: Dockerfile multi-stage → Dokploy (Contabo VPS), volume `/data` persistente
- Sync: polling 8s, merge por ID do pedido

## Estrutura fixa da planilha (10 colunas — não inverter)
`A=ID do pedido | B=Nome do Produto | C=Modelo (filtro) | D=Qnt. (centralizada) | E=Nome de usuário (copiar) | F=Status (dropdown) | G=Nome do destinatário (sort) | H=Foto | I=Foto 2 | J=+ Fotos`

Colunas K-O (10-14) são livres pra anotações. Grid expande até `O`.

## Produção (em 2026-05-27)
- URL: https://planilha-pro.144-91-112-68.sslip.io
- Repo: https://github.com/gsalesx/planilha-pro (público, autodeploy on push to main)
- Login: ver `memory/reference-planilha-pro-prod.md` (não comitar credenciais)
- Dokploy app: `wlWGFdMbDH8BKdDyPtFJE`

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

## Status atual (ler antes de continuar)
Veja `memory/project-pending-issues.md`. Resumo: deploy `ae11026` retornando **502 Bad Gateway** — provavelmente migration `ALTER TABLE orders ADD COLUMN sheet_date` ou native module do better-sqlite3 no Alpine. **Próxima ação**: abrir UI do Dokploy → ver logs do container.

## Convenções
- Não criar `Data` como coluna (usuário rejeitou)
- Imagens em disco no `/data/images`, JPG q=0.85 (cliente converte antes do upload)
- Não usar S3/MinIO — usuário confirmou 1GB cabe no volume
- Atualizar Planilha = **merge por ID do pedido**, preserva status/etiqueta/foto, marca sumidos em laranja
