/**
 * Sincronização de pedidos Mercado Livre → planilha wb_mercadolivre.
 * Espelha tiktok-order-sync, usando o upsert compartilhado.
 */
import { type AuditSource } from './audit.js'
import { ensureMarketplaceWorkbooks, MERCADOLIVRE_WORKBOOK_ID } from './marketplace.js'
import {
  MP_COL_INTERNAL_STATUS,
  MP_COL_ORDER_ID,
  MP_COL_PRODUCT,
  MP_COL_MODEL,
  MP_COL_QTY,
  MP_COL_USERNAME,
  MP_COL_RECIPIENT,
  MP_COL_MARKETPLACE_STATUS,
  MP_INTERNAL_STATUS_CANCELLED,
  MP_INTERNAL_STATUS_SHIPPED,
  emptyMarketplaceRow,
} from './marketplace-columns.js'
import { marketplaceUpsertOrder } from './marketplace-order-upsert.js'
import {
  getOrder,
  getShipment,
  searchOrders,
  type MlOrder,
  type MlShipment,
} from './mercadolivre-api.js'
import { loadMercadoLivreAuth } from './mercadolivre-store.js'

const BRAZIL_TZ = 'America/Sao_Paulo'

function formatSheetDate(isoOrMs: string | number): string {
  const d = typeof isoOrMs === 'number' ? new Date(isoOrMs) : new Date(isoOrMs)
  if (isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BRAZIL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('day')}-${get('month')}-${get('year')}`
}

export const ML_PENDING_DATE_LABEL = 'Sem data de envio'

function resolveSheetDate(order: MlOrder, shipment?: MlShipment | null): string {
  const handlingDate = shipment?.shipping_option?.estimated_handling_limit?.date
  if (handlingDate) return formatSheetDate(handlingDate)
  const readyToShip = shipment?.status_history?.date_ready_to_ship
  if (readyToShip) return formatSheetDate(readyToShip)
  if (order.date_created) return formatSheetDate(order.date_created)
  return ML_PENDING_DATE_LABEL
}

function resolveMarketplaceStatus(order: MlOrder, shipment?: MlShipment | null): string {
  if (shipment?.status) {
    return `${order.status ?? ''}/${shipment.status}`
  }
  return order.status ?? ''
}

function applyInternalStatus(row: string[], marketplaceStatus: string): void {
  const s = marketplaceStatus.toLowerCase()
  if (s.includes('cancelled')) {
    row[MP_COL_INTERNAL_STATUS] = MP_INTERNAL_STATUS_CANCELLED
  } else if (s.includes('shipped') || s.includes('delivered')) {
    row[MP_COL_INTERNAL_STATUS] = MP_INTERNAL_STATUS_SHIPPED
  }
}

export function mapMlOrderToUnitRows(
  order: MlOrder,
  shipment?: MlShipment | null,
): { unitRows: string[][]; productImageUrls: (string | undefined)[] } {
  const items = order.order_items ?? []
  const recipientName =
    shipment?.receiver_address?.receiver_name ??
    [order.buyer?.first_name, order.buyer?.last_name].filter(Boolean).join(' ') ??
    ''
  const buyerNickname = order.buyer?.nickname ?? ''
  const mktStatus = resolveMarketplaceStatus(order, shipment)
  const orderId = String(order.id ?? '')

  if (items.length === 0) {
    const row = emptyMarketplaceRow()
    row[MP_COL_ORDER_ID] = orderId
    row[MP_COL_USERNAME] = buyerNickname
    row[MP_COL_RECIPIENT] = recipientName
    row[MP_COL_MARKETPLACE_STATUS] = mktStatus
    return { unitRows: [row], productImageUrls: [undefined] }
  }

  const unitRows: string[][] = []
  const productImageUrls: (string | undefined)[] = []

  for (const item of items) {
    const qty = Math.max(1, item.quantity ?? 1)
    for (let u = 0; u < qty; u++) {
      const row = emptyMarketplaceRow()
      row[MP_COL_ORDER_ID] = orderId
      row[MP_COL_PRODUCT] = item.item?.seller_sku || item.item?.id || ''
      row[MP_COL_MODEL] = item.item?.title ?? ''
      row[MP_COL_QTY] = '1'
      row[MP_COL_USERNAME] = buyerNickname
      row[MP_COL_RECIPIENT] = recipientName
      row[MP_COL_MARKETPLACE_STATUS] = mktStatus
      unitRows.push(row)
      productImageUrls.push(undefined)
    }
  }
  return { unitRows, productImageUrls }
}

export interface MlSyncResult {
  listed: number
  created: number
  updated: number
  errors: string[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchShipmentSafe(shippingId: number | undefined): Promise<MlShipment | null> {
  if (!shippingId) return null
  try {
    return await getShipment(shippingId)
  } catch {
    return null
  }
}

export async function importMercadoLivreOrderById(
  orderId: number,
  ctx: { source?: AuditSource; runId?: string | null; rotina?: string } = {},
): Promise<'created' | 'updated' | 'unchanged' | 'failed'> {
  if (!orderId) return 'failed'
  const retries = [0, 3000, 10000]
  for (let attempt = 0; attempt < retries.length; attempt++) {
    if (retries[attempt] > 0) await sleep(retries[attempt])
    try {
      const order = await getOrder(orderId)
      if (!order?.id) {
        console.warn(`[ml-sync] detalhe vazio tentativa ${attempt + 1}/${retries.length}`, orderId)
        continue
      }
      const shipment = await fetchShipmentSafe(order.shipping?.id)
      const { unitRows, productImageUrls } = mapMlOrderToUnitRows(order, shipment)
      return marketplaceUpsertOrder({
        workbookId: MERCADOLIVRE_WORKBOOK_ID,
        orderId: String(order.id),
        sheetDate: resolveSheetDate(order, shipment),
        unitRows,
        productImageUrls,
        applyInternalStatus,
        ...ctx,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[ml-sync] erro tentativa ${attempt + 1}/${retries.length}`, orderId, msg)
    }
  }
  return 'failed'
}

export const ML_POLL_LOOKBACK_HOURS = 48

export async function syncRecentMercadoLivreOrders(options: {
  hours?: number
  ctx?: { source?: AuditSource; runId?: string | null }
} = {}): Promise<MlSyncResult> {
  ensureMarketplaceWorkbooks()
  const auth = loadMercadoLivreAuth()
  if (!auth?.userId) throw new Error('ML não autenticado')

  const result: MlSyncResult = { listed: 0, created: 0, updated: 0, errors: [] }
  let offset = 0
  const limit = 50

  try {
    let hasMore = true
    while (hasMore) {
      const page = await searchOrders({
        seller: auth.userId,
        offset,
        limit,
      })
      const orders = page.results ?? []
      result.listed += orders.length

      for (const order of orders) {
        try {
          const shipment = await fetchShipmentSafe(order.shipping?.id)
          const { unitRows, productImageUrls } = mapMlOrderToUnitRows(order, shipment)
          const action = marketplaceUpsertOrder({
            workbookId: MERCADOLIVRE_WORKBOOK_ID,
            orderId: String(order.id ?? ''),
            sheetDate: resolveSheetDate(order, shipment),
            unitRows,
            productImageUrls,
            applyInternalStatus,
            source: options.ctx?.source ?? 'poll',
            runId: options.ctx?.runId ?? null,
            rotina: 'syncRecentMercadoLivreOrders',
          })
          if (action === 'created') result.created++
          else if (action === 'updated') result.updated++
        } catch (error) {
          result.errors.push(`${order.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      offset += orders.length
      hasMore = orders.length >= limit && offset < (page.paging?.total ?? 0)
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    result.errors.push(msg)
    console.warn('[ml-sync] searchOrders falhou', msg)
  }

  return result
}
