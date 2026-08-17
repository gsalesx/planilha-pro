# Mercado Livre API — Planilha Pro

Integração do workbook automático `wb_mercadolivre` (paridade Shopee: sync de pedidos + mensageria pós-venda + peças/arte).

## Variáveis de ambiente (Dokploy)

| Variável | Alternativa | Descrição |
|---|---|---|
| `ML_APP_ID` | `MERCADOLIVRE_APP_ID` | App ID |
| `ML_CLIENT_SECRET` | `MERCADOLIVRE_CLIENT_SECRET` | Client secret |
| `ML_REDIRECT_URL` | `MERCADOLIVRE_REDIRECT_URL` | Callback — ex. `https://planilha.guilhermesales.com/api/mercadolivre/oauth/callback` |
| `ML_SITE_ID` | `MERCADOLIVRE_SITE_ID` | Default `MLB` (Brasil) |

**Não alterar** as vars `SHOPEE_*`.

## OAuth (BR)

1. `GET /api/mercadolivre/oauth/start` redireciona para `https://auth.mercadolivre.com.br/authorization`
2. Callback: `GET /api/mercadolivre/oauth/callback`
3. Tokens em `/data/mercadolivre-auth.json`

Scopes típicos: `read`, `write`, `offline_access` (refresh).

## Mensageria

Usa **pós-venda** (`tag=post_sale`), não perguntas do anúncio:

- `GET /messages/packs/{pack_id}/sellers/{seller_id}?tag=post_sale`
- `POST` no mesmo path para enviar texto

No BR, iniciar conversa pelo vendedor pode exigir *action guide* (motivo). Responder comprador que já escreveu funciona normalmente. `send-preview` / `start-conversation` podem retornar 501 se a API exigir fluxo especial — foto da conversa → peças continua via URL nas mensagens.

## Notifications (webhook)

Cadastrar URL: `https://planilha.guilhermesales.com/api/mercadolivre/push`

Topics úteis: `orders_v2`, `messages`. O handler busca o `resource` com o token e importa/atualiza o pedido ou o vínculo buyer↔pack.

## Fluxo interno

1. Boot cria `wb_mercadolivre`.
2. Poll 2h + webhook.
3. Chat UI: mesmo offcanvas; canal `mercadolivre` roteia `/api/mercadolivre/...`.
4. Col H = status ML (`paid`, `ready_to_ship`, `shipped`, …). Filtro default: `ready_to_ship`.
