import { assertShopeeOk, getOrderDetail, type ShopeeApiResponse } from './shopee-api.js'
import { upsertShopeeOrder, updateShopeeOrderStatus } from './shopee-order-sync.js'
import { ensureShopeeWorkbook } from './shopee-workbook.js'

interface ShopeeOrderDetail {
  order_sn?: string
  order_status?: string
}

function pushCode(parsed: unknown): number | null {
  if (!parsed || typeof parsed !== 'object') return null
  const code = (parsed as { code?: unknown }).code
  if (typeof code === 'number') return code
  if (typeof code === 'string' && code.trim() !== '') return Number(code)
  return null
}

function parseOrderDetailList(data: ShopeeApiResponse): ShopeeOrderDetail[] {
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_order_detail') as {
    order_list?: ShopeeOrderDetail[]
  }
  return body.order_list ?? []
}

/** Processa push code 3 (order status) — chamar após responder 200 à Shopee. */
export async function processShopeeOrderStatusPush(parsed: unknown): Promise<void> {
  if (pushCode(parsed) !== 3) return
  if (!parsed || typeof parsed !== 'object') return
  const data = (parsed as { data?: unknown }).data
  if (!data || typeof data !== 'object') return

  const row = data as { ordersn?: string; order_sn?: string; status?: string }
  const orderSn = (row.ordersn ?? row.order_sn ?? '').trim()
  const status = row.status ?? ''
  if (!orderSn) {
    console.warn('[shopee-push] code 3 sem ordersn')
    return
  }

  ensureShopeeWorkbook()

  if (updateShopeeOrderStatus(orderSn, status) === 'updated') {
    console.log('[shopee-push] status atualizado', { orderSn, status })
    return
  }

  try {
    const detail = await getOrderDetail([orderSn])
    const orders = parseOrderDetailList(detail)
    const order = orders.find((o) => o.order_sn === orderSn) ?? orders[0]
    if (!order) {
      console.warn('[shopee-push] get_order_detail vazio para', orderSn)
      return
    }
    if (status && !order.order_status) order.order_status = status
    const action = upsertShopeeOrder(order)
    console.log('[shopee-push] pedido', action, { orderSn, status: order.order_status ?? status })
  } catch (error) {
    console.error('[shopee-push] falha ao sincronizar pedido', orderSn, error)
  }
}
