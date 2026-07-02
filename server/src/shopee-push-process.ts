import { maybeGreetOnReadyToShip } from './shopee-auto-greet.js'
import {
  importShopeeOrderBySn,
  shopeeOrderExists,
  updateShopeeOrderStatus,
} from './shopee-order-sync.js'
import { ensureShopeeWorkbook } from './shopee-workbook.js'
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

/** Code 3 — order_status_push: toda mudança de status (inclui UNPAID ao criar o pedido). */
async function handleOrderStatusPush(data: unknown): Promise<void> {
  const orderSn = extractOrderSn(data)
  const status = extractStatus(data)
  if (!orderSn) {
    console.warn('[shopee-push] code 3 sem ordersn')
    return
  }

  if (shopeeOrderExists(orderSn)) {
    updateShopeeOrderStatus(orderSn, status)
    console.log('[shopee-push] status atualizado', { orderSn, status })
    return
  }

  const action = await importShopeeOrderBySn(orderSn, status)
  if (action === 'failed') {
    console.error('[shopee-push] falha ao importar pedido novo', { orderSn, status })
    return
  }
  console.log('[shopee-push] pedido importado (code 3)', { orderSn, status, action })
}

/** Code 8 — reserved_stock_change_push com action place_order (compra feita, antes do status push). */
async function handlePlaceOrderPush(data: unknown): Promise<void> {
  if (!data || typeof data !== 'object') return
  const row = data as { action?: string }
  if (row.action !== 'place_order') return

  const orderSn = extractOrderSn(data)
  if (!orderSn) return
  if (shopeeOrderExists(orderSn)) return

  const action = await importShopeeOrderBySn(orderSn, 'UNPAID')
  console.log('[shopee-push] pedido importado (code 8 place_order)', { orderSn, action })
}

/**
 * Desativado em 2026-07-03: importação/atualização de pedidos e a saudação automática passam a
 * vir só do poll de 8h (ver syncRecentShopeeOrders/resyncPendingDateOrders em index.ts) — o push
 * estava chegando com o pedido ainda sem ship_by_date calculado. O endpoint /api/shopee/push
 * continua respondendo 200 normalmente (handleShopeePushPost) pra não invalidar a assinatura na
 * Shopee; só o processamento fica parado aqui. Reativar: virar `true` de novo (ex.: quando entrar
 * o gancho de "comprador mandou mensagem primeiro" no code de chat).
 */
const PUSH_PROCESSING_ENABLED = false

/** Processa pushes de pedido — chamar após responder 200 à Shopee. */
export async function processShopeePush(parsed: unknown): Promise<void> {
  const code = pushCode(parsed)
  if (code == null) return
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

  if (!PUSH_PROCESSING_ENABLED) return

  ensureShopeeWorkbook()

  if (code === 3) {
    await handleOrderStatusPush(data)
    await maybeGreetOnReadyToShip(extractOrderSn(data), extractStatus(data))
    return
  }
  if (code === 8) {
    await handlePlaceOrderPush(data)
  }
}

/** @deprecated use processShopeePush */
export async function processShopeeOrderStatusPush(parsed: unknown): Promise<void> {
  await processShopeePush(parsed)
}
