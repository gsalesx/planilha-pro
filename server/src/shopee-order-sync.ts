import { db, nowMs } from './db.js'
import {
  assertShopeeOk,
  fetchOrderListPage,
  getOrderDetail,
  SHOPEE_LIST_ORDER_STATUSES,
  type ShopeeApiResponse,
} from './shopee-api.js'
import {
  emptyShopeeRow,
  SHOPEE_COL_MODEL,
  SHOPEE_COL_ORDER_ID,
  SHOPEE_COL_PRODUCT,
  SHOPEE_COL_QTY,
  SHOPEE_COL_RECIPIENT,
  SHOPEE_COL_SHOPEE_STATUS,
  SHOPEE_COL_USERNAME,
  SHOPEE_ROW_COLS,
} from './shopee-columns.js'
import { ensureShopeeWorkbook, SHOPEE_WORKBOOK_ID } from './shopee-workbook.js'

interface ShopeeItemRow {
  item_name?: string
  model_name?: string
  model_quantity_purchased?: number
}

interface ShopeeOrderDetail {
  order_sn?: string
  order_status?: string
  buyer_username?: string
  create_time?: number
  recipient_address?: { name?: string }
  item_list?: ShopeeItemRow[]
}

export interface ShopeeSyncResult {
  listed: number
  created: number
  updated: number
  errors: string[]
}

function formatSheetDate(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${dd}-${mm}-${yyyy}`
}

function joinField(values: string[]): string {
  return values.filter(Boolean).join('; ')
}

export function mapShopeeOrderToRow(order: ShopeeOrderDetail): string[] {
  const row = emptyShopeeRow()
  const items = order.item_list ?? []
  row[SHOPEE_COL_ORDER_ID] = order.order_sn ?? ''
  row[SHOPEE_COL_PRODUCT] = joinField(items.map((i) => i.item_name ?? ''))
  row[SHOPEE_COL_MODEL] = joinField(items.map((i) => i.model_name ?? ''))
  row[SHOPEE_COL_QTY] = String(
    items.reduce((sum, i) => sum + (i.model_quantity_purchased ?? 0), 0) || '',
  )
  row[SHOPEE_COL_USERNAME] = order.buyer_username ?? ''
  row[SHOPEE_COL_RECIPIENT] = order.recipient_address?.name ?? ''
  row[SHOPEE_COL_SHOPEE_STATUS] = order.order_status ?? ''
  return row
}

function parseOrderList(data: ShopeeApiResponse): ShopeeOrderDetail[] {
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_order_detail') as {
    order_list?: ShopeeOrderDetail[]
  }
  return body.order_list ?? []
}

function findOrderBySn(orderSn: string): { order_key: string; row_json: string } | undefined {
  return db
    .prepare('SELECT order_key, row_json FROM orders WHERE workbook_id = ? AND id = ?')
    .get(SHOPEE_WORKBOOK_ID, orderSn) as { order_key: string; row_json: string } | undefined
}

/** Cria linha completa ou, se já existir, atualiza só coluna H (Status Shopee). */
export function upsertShopeeOrder(order: ShopeeOrderDetail): 'created' | 'updated' {
  const orderSn = order.order_sn?.trim()
  if (!orderSn) throw new Error('order_sn ausente')

  const existing = findOrderBySn(orderSn)
  const now = nowMs()
  const shopeeStatus = order.order_status ?? ''

  if (existing) {
    const row = JSON.parse(existing.row_json) as string[]
    while (row.length < SHOPEE_ROW_COLS) row.push('')
    row[SHOPEE_COL_SHOPEE_STATUS] = shopeeStatus
    db.prepare(
      'UPDATE orders SET row_json = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?',
    ).run(JSON.stringify(row), now, SHOPEE_WORKBOOK_ID, existing.order_key)
    db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, SHOPEE_WORKBOOK_ID)
    return 'updated'
  }

  const row = mapShopeeOrderToRow(order)
  const sheetDate = order.create_time ? formatSheetDate(order.create_time) : ''
  const maxPos = (
    db
      .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM orders WHERE workbook_id = ?')
      .get(SHOPEE_WORKBOOK_ID) as { m: number }
  ).m

  db.prepare(
    `INSERT INTO orders (workbook_id, order_key, id, row_json, styles_json, disappeared, sheet_date, position, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    SHOPEE_WORKBOOK_ID,
    orderSn,
    orderSn,
    JSON.stringify(row),
    '{}',
    0,
    sheetDate,
    maxPos + 1,
    now,
  )
  db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, SHOPEE_WORKBOOK_ID)
  return 'created'
}

/** Atualiza só Status Shopee (col H) — usado pelo push code 3. */
export function updateShopeeOrderStatus(orderSn: string, shopeeStatus: string): 'updated' | 'missing' {
  const existing = findOrderBySn(orderSn)
  if (!existing) return 'missing'
  const row = JSON.parse(existing.row_json) as string[]
  while (row.length < SHOPEE_ROW_COLS) row.push('')
  row[SHOPEE_COL_SHOPEE_STATUS] = shopeeStatus
  const now = nowMs()
  db.prepare(
    'UPDATE orders SET row_json = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?',
  ).run(JSON.stringify(row), now, SHOPEE_WORKBOOK_ID, existing.order_key)
  db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, SHOPEE_WORKBOOK_ID)
  return 'updated'
}

async function collectAllOrderSns(timeFrom: number, timeTo: number): Promise<string[]> {
  const seen = new Set<string>()
  for (const orderStatus of SHOPEE_LIST_ORDER_STATUSES) {
    let cursor = ''
    let more = true
    while (more) {
      const page = await fetchOrderListPage({
        timeFrom,
        timeTo,
        orderStatus,
        pageSize: 100,
        cursor: cursor || undefined,
        timeRangeField: 'create_time',
      })
      for (const sn of page.orderSnList) seen.add(sn)
      more = page.more
      cursor = page.nextCursor
      if (more && !cursor) break
    }
  }
  return [...seen]
}

export async function syncShopeeWorkbookOrders(options: {
  days?: number
} = {}): Promise<ShopeeSyncResult> {
  ensureShopeeWorkbook()
  const days = Math.min(Math.max(options.days ?? 90, 1), 365)
  const timeTo = Math.floor(Date.now() / 1000)
  const timeFrom = timeTo - days * 24 * 3600

  const result: ShopeeSyncResult = { listed: 0, created: 0, updated: 0, errors: [] }
  const orderSns = await collectAllOrderSns(timeFrom, timeTo)
  result.listed = orderSns.length

  for (let i = 0; i < orderSns.length; i += 50) {
    const batch = orderSns.slice(i, i + 50)
    try {
      const data = await getOrderDetail(batch)
      const orders = parseOrderList(data)
      for (const order of orders) {
        try {
          const action = upsertShopeeOrder(order)
          if (action === 'created') result.created++
          else result.updated++
        } catch (error) {
          result.errors.push(
            `${order.order_sn ?? '?'}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    } catch (error) {
      result.errors.push(
        `batch ${i / 50 + 1}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return result
}
