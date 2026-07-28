import { newRunId, recordAudit } from './audit.js'
import { maybeGreetOnReadyToShip } from './shopee-auto-greet.js'
import { linkBuyerChatFromWebchatMessage } from './shopee-link-conversations.js'
import { importShopeeOrderBySn, shopeeOrderExists } from './shopee-order-sync.js'
import { SHOPEE_WORKBOOK_ID } from './shopee-workbook.js'
import { recordWebchatPushAttempt } from './shopee-webchat-push.js'

function pushCode(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== 'object') return null
  const code = (parsed as { code?: unknown }).code
  if (typeof code === 'number') return code
  if (typeof code === 'string' && code.trim() !== '') return Number(code)
  return null
}

function extractOrderSn(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  const row = data as { ordersn?: string; order_sn?: string }
  return (row.ordersn ?? row.order_sn ?? '').trim()
}

function extractStatus(data: unknown): string {
  if (!data || typeof data !== 'object') return ''
  return String((data as { status?: string }).status ?? '')
}

/**
 * Code 3 — order_status_push: toda mudança de status (inclui UNPAID ao criar o pedido).
 * Escreve em wb_shopee (única planilha) — complementa o poll de 2h, cobrindo pedido em tempo
 * real e casos que o poll não alcança (pedido antigo, mudança de status fora da janela).
 * Sempre busca o detalhe completo (importShopeeOrderBySn → upsertShopeeOrder), pedido novo ou
 * já existente — o push só manda orderSn+status, sem data de envio nem nome do destinatário;
 * pra manter esses 2 campos frescos (junto com o status) é preciso o detalhe completo, não dá
 * pra só gravar o status isolado (2026-07-15: cron e webhook devem poder atualizar dia de envio,
 * status Shopee E nome do cliente, sempre). Se a Shopee ainda não calculou o ship_by_date, o
 * pedido cai na aba "Sem data de envio" (resolveSheetDate NUNCA usa create_time como fallback) —
 * resyncPendingDateOrders no poll de 2h fica reconferindo até a Shopee calcular de verdade.
 */
async function handleOrderStatusPush(data: unknown, runId: string): Promise<void> {
  const orderSn = extractOrderSn(data)
  const status = extractStatus(data)
  if (!orderSn) {
    console.warn('[shopee-push] code 3 sem ordersn')
    recordAudit({ source: 'push', runId, event: 'push.ignorado', level: 'warn', detail: { code: 3, motivo: 'sem ordersn', data } })
    return
  }

  const action = await importShopeeOrderBySn(orderSn, status, SHOPEE_WORKBOOK_ID, {
    source: 'push',
    runId,
    rotina: 'handleOrderStatusPush',
  })
  if (action === 'failed') {
    console.error('[shopee-push] falha ao importar/atualizar pedido', { orderSn, status })
    recordAudit({ source: 'push', runId, orderSn, event: 'push.falhou', level: 'error', detail: { code: 3, status } })
    return
  }
  console.log('[shopee-push] pedido atualizado (code 3)', { orderSn, status, action })
  recordAudit({ source: 'push', runId, orderSn, event: 'push.processado', detail: { code: 3, status, action } })
}

/** Code 8 — reserved_stock_change_push com action place_order (compra feita, antes do status push). */
async function handlePlaceOrderPush(data: unknown, runId: string): Promise<void> {
  if (!data || typeof data !== 'object') return
  const row = data as { action?: string }
  if (row.action !== 'place_order') {
    recordAudit({ source: 'push', runId, event: 'push.ignorado', detail: { code: 8, motivo: 'action != place_order', action: row.action } })
    return
  }

  const orderSn = extractOrderSn(data)
  if (!orderSn) {
    recordAudit({ source: 'push', runId, event: 'push.ignorado', level: 'warn', detail: { code: 8, motivo: 'sem ordersn', data } })
    return
  }
  if (shopeeOrderExists(orderSn, SHOPEE_WORKBOOK_ID)) {
    recordAudit({ source: 'push', runId, orderSn, event: 'push.ignorado', detail: { code: 8, motivo: 'pedido já existe' } })
    return
  }

  const action = await importShopeeOrderBySn(orderSn, 'UNPAID', SHOPEE_WORKBOOK_ID, {
    source: 'push',
    runId,
    rotina: 'handlePlaceOrderPush',
  })
  console.log('[shopee-push] pedido importado (code 8 place_order)', { orderSn, action })
  recordAudit({
    source: 'push',
    runId,
    orderSn,
    event: action === 'failed' ? 'push.falhou' : 'push.processado',
    level: action === 'failed' ? 'error' : 'info',
    detail: { code: 8, action },
  })
}

interface WebchatMessageContent {
  from_id?: number | string
  from_user_name?: string
  conversation_id?: string
}

interface WebchatPushEnvelope {
  type?: string
  content?: WebchatMessageContent
}

/**
 * Code 10 — webchat_push, data.type "message": mensagem nova no chat. from_id/from_user_name
 * é sempre quem mandou a mensagem (comprador, nas amostras reais vistas em produção);
 * conversation_id já vem pronto, sem precisar varrer get_conversation_list. Roda sempre
 * (não depende de PUSH_PROCESSING_ENABLED, que só trata do fluxo de pedidos).
 */
function handleWebchatMessagePush(data: unknown, runId: string): void {
  if (!data || typeof data !== 'object') return
  const envelope = data as WebchatPushEnvelope
  if (envelope.type !== 'message' || !envelope.content) {
    recordAudit({ source: 'push', runId, event: 'push.ignorado', detail: { code: 10, motivo: 'não é mensagem', tipo: envelope.type } })
    return
  }

  const buyerUserId = Number(envelope.content.from_id) || 0
  const buyerUsername = String(envelope.content.from_user_name ?? '').trim()
  const conversationId = String(envelope.content.conversation_id ?? '').trim()
  if (!buyerUserId || !buyerUsername || !conversationId) {
    recordAudit({
      source: 'push',
      runId,
      event: 'push.ignorado',
      level: 'warn',
      detail: { code: 10, motivo: 'campos incompletos', buyerUserId, buyerUsername, conversationId },
    })
    return
  }

  try {
    const result = linkBuyerChatFromWebchatMessage({ buyerUserId, buyerUsername, conversationId })
    if (result === 'linked') {
      console.log('[shopee-push] vínculo automático via webchat_push', { buyerUsername, conversationId })
    }
    recordAudit({ source: 'push', runId, event: 'push.chat_vinculado', detail: { code: 10, buyerUsername, conversationId, result } })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[shopee-push] falha ao vincular via webchat_push', error)
    recordAudit({ source: 'push', runId, event: 'push.falhou', level: 'error', detail: { code: 10, buyerUsername, erro: msg } })
  }
}

/**
 * Reativado em 2026-07-15 (era `false` desde 2026-07-03 — o push chegava com o pedido ainda sem
 * ship_by_date calculado). Escreve direto em wb_shopee, junto com o poll de 2h — as duas vias
 * complementam uma à outra (poll cobre janelas amplas + resync por status; push cobre tempo real
 * e pedido antigo que o poll não alcança). O problema original (ship_by_date zerado) foi
 * resolvido em `resolveSheetDate`, não aqui: ela nunca usa create_time como fallback, pedido sem
 * ship_by_date cai em "Sem data de envio" e resyncPendingDateOrders no poll de 2h fica
 * reconferindo até a Shopee calcular de verdade. O vínculo automático de chat (code 10) NÃO
 * depende desta flag — roda sempre, ver handleWebchatMessagePush.
 */
const PUSH_PROCESSING_ENABLED = true

/** Processa pushes de pedido — chamar após responder 200 à Shopee. */
export async function processShopeePush(parsed: unknown, runIdIn?: string): Promise<void> {
  const runId = runIdIn ?? newRunId('push')
  const code = pushCode(parsed)
  if (code == null) {
    recordAudit({ source: 'push', runId, event: 'push.ignorado', level: 'warn', detail: { motivo: 'sem code', parsed } })
    return
  }
  if (!parsed || typeof parsed !== 'object') return
  const data = (parsed as { data?: unknown }).data

  // Captura diagnóstica de qualquer código que não seja os já conhecidos (3/8) — roda mesmo
  // com PUSH_PROCESSING_ENABLED=false, já que é só leitura/log, não mexe em pedidos/planilha.
  // Com o console Shopee configurado pra mandar só webchat agora, isso deve ser o webchat_push.
  if (code !== 3 && code !== 8) {
    try {
      recordWebchatPushAttempt(code, data)
      console.log('[shopee-push] push desconhecido capturado (possível webchat_push)', { code })
    } catch (error) {
      console.warn('[shopee-push] falha ao capturar push desconhecido', error)
    }
  }

  if (code === 10) {
    handleWebchatMessagePush(data, runId)
  }

  if (!PUSH_PROCESSING_ENABLED) {
    recordAudit({ source: 'push', runId, event: 'push.ignorado', level: 'warn', detail: { code, motivo: 'PUSH_PROCESSING_ENABLED=false' } })
    return
  }

  if (code === 3) {
    await handleOrderStatusPush(data, runId)
    await maybeGreetOnReadyToShip(extractOrderSn(data), extractStatus(data))
    return
  }
  if (code === 8) {
    await handlePlaceOrderPush(data, runId)
  }
}

/** @deprecated use processShopeePush */
export async function processShopeeOrderStatusPush(parsed: unknown): Promise<void> {
  await processShopeePush(parsed)
}
