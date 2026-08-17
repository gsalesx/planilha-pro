# TikTok Shop API — Planilha Pro

Integração do workbook automático `wb_tiktok` (paridade Shopee: sync de pedidos + chat + peças/arte).

## Variáveis de ambiente (Dokploy)

| Variável | Obrigatória | Descrição |
|---|---|---|
| `TIKTOK_APP_KEY` | sim | App Key no Partner Center |
| `TIKTOK_APP_SECRET` | sim | App Secret |
| `TIKTOK_REDIRECT_URL` | sim | Callback OAuth — ex. `https://planilha.guilhermesales.com/api/tiktok/oauth/callback` |
| `TIKTOK_SHOP_CIPHER` | não | Cipher da loja (pode vir no token OAuth) |
| `TIKTOK_API_BASE` | não | Default `https://open-api.tiktokglobalshop.com` |

**Não alterar** as vars `SHOPEE_*`.

## Scopes sugeridos

- `seller.order.info` — listar/detalhar pedidos
- `seller.authorization.info` — shop / cipher
- `seller.customer_service` — conversas e mensagens (**pode exigir aprovação** no Partner Center)

## Callback / webhook

- OAuth: `GET /api/tiktok/oauth/start` → Partner Center → `GET /api/tiktok/oauth/callback`
- Push: cadastrar `https://planilha.guilhermesales.com/api/tiktok/push` no app (order status)

## Fluxo interno

1. Boot cria `wb_tiktok` se não existir.
2. Poll a cada 2h (`syncRecentTikTokOrders`) + webhook de status.
3. Chat: `GET /api/tiktok/chat-history?username=` (username = col E).
4. Peças/picker/arte: mesmos endpoints genéricos `(workbookId, orderKey)` — sem fork.

## Auth

Tokens em `/data/tiktok-auth.json` (volume persistente). Status: `GET /api/tiktok/status`.
