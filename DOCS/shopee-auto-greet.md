# Shopee — disparo único de saudação (teste de chat frio)

Testa se dá pra **iniciar** uma conversa no chat da Shopee com um comprador que **nunca abriu chat** (chat frio). A Shopee tem regra anti-spam que costuma bloquear isso; este disparo confirma na conta real se ela **aceita** ou **bloqueia**.

Adicionado em 2026-07-01 (commit `cee9606`).

## Como funciona

No push de status da Shopee (**code 3**, `order_status_push`), quando um pedido vira `READY_TO_SHIP` **e** o disparo está armado:

1. Consome o "armado" de forma atômica → dispara para **exatamente a próxima** compra `READY_TO_SHIP` (mesmo com pushes simultâneos, só um vence).
2. Busca o `buyer_user_id` do pedido via `get_order_detail` (campos `buyer_user_id,buyer_username`).
3. Envia `send_message` com `to_id` = comprador, `business_type=0` (não precisa de `conversation_id`), texto = *"Olá, pode enviar aqui as artes para personalização"*.
4. Registra o resultado (`sent`/`failed` + resposta/erro cru da Shopee) na tabela `shopee_auto_greet_log`.

Depende do push code 3 estar configurado no console da Shopee (ver `SHOPEE_PUSH_CALLBACK_URL` em `GET /api/shopee/status`).

## Endpoints (auth: cookie de sessão ou API key)

| Método | Caminho | O que faz |
|---|---|---|
| GET | `/api/shopee/auto-greet` | Estado (`armed`, `message`) + últimos 20 disparos (`log`) |
| POST | `/api/shopee/auto-greet/arm` | Arma para a próxima venda READY_TO_SHIP. Body opcional `{"message":"..."}` (vazio usa a padrão) |
| POST | `/api/shopee/auto-greet/disarm` | Cancela o disparo armado |

## Uso

Armar:
```bash
curl -X POST -b cookies.txt https://planilha.guilhermesales.com/api/shopee/auto-greet/arm
```

Conferir o resultado depois de cair uma venda:
```bash
curl -b cookies.txt https://planilha.guilhermesales.com/api/shopee/auto-greet
```

Leitura do `log[0].status`:
- `sent` → Shopee **deixou** iniciar o chat frio (dá pra automatizar de verdade).
- `failed` → Shopee **bloqueou**; o erro exato fica em `log[0].detail`.
- `log` vazio + `armed:true` → ainda não caiu nenhuma venda `READY_TO_SHIP`.

Dispara **uma vez só**: após a tentativa (sucesso ou falha) desarma sozinho. Para repetir, arme de novo.

## Arquivos

- `server/src/shopee-auto-greet.ts` — lógica (arm/disarm/estado/log/`maybeGreetOnReadyToShip`).
- `server/src/shopee-push-process.ts` — gancho no push code 3.
- `server/src/db.ts` — tabelas `shopee_auto_greet` (estado, 1 linha) e `shopee_auto_greet_log`.
- `server/src/routes/shopee-test.ts` — rotas HTTP.
