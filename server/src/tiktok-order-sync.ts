/**
 * Sincronização de pedidos TikTok Shop → planilha wb_tiktok.
 * Espelha a lógica do shopee-order-sync, usando o upsert compartilhado.
 */
import { type AuditSource } from './audit.js'
import { ensureMarketplaceWorkbooks, TIKTOK_WORKBOOK_ID } from './marketplace.js'
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
  getOrderDetails,
  listOrders,
  type TikTokOrderDetail,
} from './tiktok-api.js'

const BRAZIL_TZ = 'America/Sao_Paulo'

function formatSheetDate(unixSec: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BRAZIL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(unixSec * 1000))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('day')}-${get('month')}-${get('year')}`
}

export const TIKTOK_PENDING_DATE_LABEL = 'Sem data de envio'

function resolveSheetDate(order: TikTokOrderDetail): string {
  const ts =
    order.delivery_option_required_delivery_by ||
    order.shipping_due_time ||
    0
  return ts ? formatSheetDate(ts) : TIKTOK_PENDING_DATE_LABEL
}

function applyInternalStatus(row: string[], tiktokStatus: string): void {
  const s = tiktokStatus.trim().toUpperCase()
  if (s === 'CANCELLED' || s === 'CANCEL') {
    row[MP_COL_INTERNAL_STATUS] = MP_INTERNAL_STATUS_CANCELLED
  } else if (s === 'DELIVERED' || s === 'COMPLETED') {
    row[MP_COL_INTERNAL_STATUS] = MP_INTERNAL_STATUS_SHIPPED
  }
}

/** Explode qty: 1 linha por unidade, Qnt=1. */
export function mapTikTokOrderToUnitRows(
  order: TikTokOrderDetail,
): { unitRows: string[][]; productImageUrls: (string | undefined)[] } {
  const items = order.line_items ?? []
  if (items.length === 0) {
    const row = emptyMarketplaceRow()
    row[MP_COL_ORDER_ID] = order.id ?? ''
    row[MP_COL_USERNAME] = order.buyer_uid ?? ''
    row[MP_COL_RECIPIENT] = order.recipient_address?.name ?? ''
    row[MP_COL_MARKETPLACE_STATUS] = order.status ?? ''
    return { unitRows: [row], productImageUrls: [undefined] }
  }

  const unitRows: string[][] = []
  const productImageUrls: (string | undefined)[] = []

  for (const item of items) {
    const qty = Math.max(1, item.quantity ?? 1)
    for (let u = 0; u < qty; u++) {
      const row = emptyMarketplaceRow()
      row[MP_COL_ORDER_ID] = order.id ?? ''
      row[MP_COL_PRODUCT] = item.seller_sku ?? ''
      row[MP_COL_MODEL] = item.sku_name ?? item.product_name ?? ''
      row[MP_COL_QTY] = '1'
      row[MP_COL_USERNAME] = order.buyer_uid ?? ''
      row[MP_COL_RECIPIENT] = order.recipient_address?.name ?? ''
      row[MP_COL_MARKETPLACE_STATUS] = order.status ?? ''
      unitRows.push(row)
      productImageUrls.push(item.sku_image?.url)
    }
  }
  return { unitRows, productImageUrls }
}

export interface TikTokSyncResult {
  listed: number
  created: number
  updated: number
  errors: string[]
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function importTikTokOrderById(
  orderId: string,
  ctx: { source?: AuditSource; runId?: string | null; rotina?: string } = {},
): Promise<'created' | 'updated' | 'unchanged' | 'failed'> {
  const id = orderId.trim()
  if (!id) return 'failed'
  const retries = [0, 3000, 10000]
  for (let attempt = 0; attempt < retries.length; attempt++) {
    if (retries[attempt] > 0) await sleep(retries[attempt])
    try {
      const orders = await getOrderDetails([id])
      const order = orders.find((o) => o.id === id) ?? orders[0]
      if (!order?.id) {
        console.warn(`[tiktok-sync] detalhe vazio tentativa ${attempt + 1}/${retries.length}`, id)
        continue
      }
      const { unitRows, productImageUrls } = mapTikTokOrderToUnitRows(order)
      return marketplaceUpsertOrder({
        workbookId: TIKTOK_WORKBOOK_ID,
        orderId: order.id,
        sheetDate: resolveSheetDate(order),
        unitRows,
        productImageUrls,
        applyInternalStatus,
        ...ctx,
      })
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[tiktok-sync] erro tentativa ${attempt + 1}/${retries.length}`, id, msg)
    }
  }
  return 'failed'
}

export const TIKTOK_POLL_LOOKBACK_HOURS = 24

export async function syncRecentTikTokOrders(options: {
  hours?: number
  ctx?: { source?: AuditSource; runId?: string | null }
} = {}): Promise<TikTokSyncResult> {
  ensureMarketplaceWorkbooks()
  const hours = Math.min(Math.max(options.hours ?? TIKTOK_POLL_LOOKBACK_HOURS, 1), 168)
  const timeTo = Math.floor(Date.now() / 1000)
  const timeFrom = timeTo - hours * 3600
  const result: TikTokSyncResult = { listed: 0, created: 0, updated: 0, errors: [] }

  const allIds: string[] = []
  let pageToken = ''
  try {
    do {
      const page = await listOrders({
        pageSize: 50,
        pageToken: pageToken || undefined,
        createTimeGe: timeFrom,
        createTimeLt: timeTo,
      })
      allIds.push(...page.orderIds)
      pageToken = page.nextPageToken
    } while (pageToken)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    result.errors.push(msg)
    console.warn('[tiktok-sync] listOrders falhou', msg)
  }

  result.listed = allIds.length
  for (let i = 0; i < allIds.length; i += 20) {
    const batch = allIds.slice(i, i + 20)
    try {
      const orders = await getOrderDetails(batch)
      for (const order of orders) {
        try {
          const { unitRows, productImageUrls } = mapTikTokOrderToUnitRows(order)
          const action = marketplaceUpsertOrder({
            workbookId: TIKTOK_WORKBOOK_ID,
            orderId: order.id ?? '',
            sheetDate: resolveSheetDate(order),
            unitRows,
            productImageUrls,
            applyInternalStatus,
            source: options.ctx?.source ?? 'poll',
            runId: options.ctx?.runId ?? null,
            rotina: 'syncRecentTikTokOrders',
          })
          if (action === 'created') result.created++
          else if (action === 'updated') result.updated++
        } catch (error) {
          result.errors.push(`${order.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } catch (error) {
      result.errors.push(`batch: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return result
}
