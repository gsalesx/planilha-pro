import {
  importShopeeOrderBySn,
  shopeeOrderExists,
  updateShopeeOrderStatus,
} from './shopee-order-sync.js'
import { ensureShopeeWorkbook } from './shopee-workbook.js'

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

/** Processa pushes de pedido — chamar após responder 200 à Shopee. */
export async function processShopeePush(parsed: unknown): Promise<void> {
  const code = pushCode(parsed)
  if (code == null) return
  if (!parsed || typeof parsed !== 'object') return

  ensureShopeeWorkbook()
  const data = (parsed as { data?: unknown }).data

  if (code === 3) {
    await handleOrderStatusPush(data)
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
