import { db, nowMs } from './db.js'
import {
  assertShopeeOk,
  fetchOrderListPage,
  getOrderDetail,
  type ShopeeApiResponse,
} from './shopee-api.js'
import {
  emptyShopeeRow,
  SHOPEE_COL_MODEL,
  SHOPEE_COL_INTERNAL_STATUS,
  SHOPEE_COL_ORDER_ID,
  SHOPEE_COL_PRODUCT,
  SHOPEE_COL_QTY,
  SHOPEE_COL_RECIPIENT,
  SHOPEE_COL_SHOPEE_STATUS,
  SHOPEE_COL_USERNAME,
  SHOPEE_ROW_COLS,
  SHOPEE_INTERNAL_STATUS_CANCELLED,
} from './shopee-columns.js'
import { ensureShopeeWorkbook, SHOPEE_WORKBOOK_ID } from './shopee-workbook.js'

interface ShopeeItemRow {
  item_name?: string
  item_sku?: string
  model_name?: string
  model_sku?: string
  model_quantity_purchased?: number
}

interface ShopeeOrderDetail {
  order_sn?: string
  order_status?: string
  buyer_username?: string
  create_time?: number
  /** Prazo para despachar — data prevista de envio no painel Shopee. */
  ship_by_date?: number
  recipient_address?: { name?: string }
  item_list?: ShopeeItemRow[]
}

export interface ShopeeSyncResult {
  listed: number
  created: number
  updated: number
  errors: string[]
}

/**
 * O container roda em UTC (sem TZ setada). Um ship_by_date perto da virada do dia em BRT
 * (ex.: 23h de sexta em SP = 02h de sábado em UTC) formatado com Date.getDate() local vira
 * sábado no nosso banco enquanto o painel Shopee (BRT) ainda mostra sexta. Formatar explicitamente
 * em America/Sao_Paulo em vez de depender do TZ do processo evita esse desvio de 1 dia.
 */
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

/**
 * Aba própria pra pedidos sem ship_by_date resolvido ainda — fica visível no seletor de data
 * (em vez de sumir com sheet_date vazio) e é reconsultada a cada poll de 2h (resyncPendingDateOrders).
 */
export const SHOPEE_PENDING_DATE_LABEL = 'Sem data de envio'

/**
 * Data do `<select>` no header — prevista de envio (ship_by_date), não data da compra.
 * `strictShipDate` (usado pelo workbook alimentado por webhook): NÃO cai pro create_time
 * quando ship_by_date ainda não veio — força SHOPEE_PENDING_DATE_LABEL de propósito, pra cair
 * na aba "Sem data de envio" e ser reconferido depois, em vez de misturar data de compra com
 * data de envio (o push às vezes chega antes da Shopee calcular o prazo).
 */
function resolveSheetDate(order: ShopeeOrderDetail, strictShipDate = false): string {
  // `||` (não `??`): a Shopee manda ship_by_date=0 (não null/undefined) quando ainda não calculou
  // o prazo — precisa cair pro create_time nesse caso (exceto em strictShipDate).
  const ts = strictShipDate ? order.ship_by_date : order.ship_by_date || order.create_time
  return ts ? formatSheetDate(ts) : SHOPEE_PENDING_DATE_LABEL
}

function joinField(values: string[]): string {
  return values.filter(Boolean).join('; ')
}

function itemSku(item: ShopeeItemRow): string {
  return (item.model_sku ?? item.item_sku ?? '').trim()
}

/** Col F — espelha status terminal da Shopee no fluxo interno. PROCESSED
 * NÃO vira "Concluído" automático (decisão do usuário 2026-07-14) — esse
 * status só é setado manualmente na UI, o fluxo de produção não deve ser
 * sobrescrito por um webhook. */
function applyInternalStatusFromShopee(row: string[], shopeeStatus: string): void {
  const status = shopeeStatus.trim().toUpperCase()
  if (status === 'CANCELLED') {
    row[SHOPEE_COL_INTERNAL_STATUS] = SHOPEE_INTERNAL_STATUS_CANCELLED
  }
}

export function mapShopeeOrderToRow(order: ShopeeOrderDetail): string[] {
  const row = emptyShopeeRow()
  const items = order.item_list ?? []
  row[SHOPEE_COL_ORDER_ID] = order.order_sn ?? ''
  row[SHOPEE_COL_PRODUCT] = joinField(items.map(itemSku))
  row[SHOPEE_COL_MODEL] = joinField(items.map((i) => i.model_name ?? ''))
  row[SHOPEE_COL_QTY] = String(
    items.reduce((sum, i) => sum + (i.model_quantity_purchased ?? 0), 0) || '',
  )
  row[SHOPEE_COL_USERNAME] = order.buyer_username ?? ''
  row[SHOPEE_COL_RECIPIENT] = order.recipient_address?.name ?? ''
  row[SHOPEE_COL_SHOPEE_STATUS] = order.order_status ?? ''
  return row
}

/** 1 linha por item (export Shopee / planilha manual). */
export function mapShopeeOrderToItemRows(order: ShopeeOrderDetail): string[][] {
  const items = order.item_list ?? []
  if (items.length === 0) return [mapShopeeOrderToRow(order)]
  return items.map((item) => {
    const row = emptyShopeeRow()
    row[SHOPEE_COL_ORDER_ID] = order.order_sn ?? ''
    row[SHOPEE_COL_PRODUCT] = itemSku(item)
    row[SHOPEE_COL_MODEL] = item.model_name ?? ''
    row[SHOPEE_COL_QTY] = String(item.model_quantity_purchased ?? '')
    row[SHOPEE_COL_USERNAME] = order.buyer_username ?? ''
    row[SHOPEE_COL_RECIPIENT] = order.recipient_address?.name ?? ''
    row[SHOPEE_COL_SHOPEE_STATUS] = order.order_status ?? ''
    return row
  })
}

export function parseShopeeOrderDetail(data: ShopeeApiResponse): ShopeeOrderDetail[] {
  return parseOrderList(data)
}

function parseOrderList(data: ShopeeApiResponse): ShopeeOrderDetail[] {
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_order_detail') as {
    order_list?: ShopeeOrderDetail[]
  }
  return body.order_list ?? []
}

/** Mesma regra do XLSX: 1ª linha = id; demais = data__id__ocorrência. */
function shopeeOrderKey(sheetDate: string, orderSn: string, occurrence: number): string {
  if (occurrence === 1) return orderSn
  return `${sheetDate || 'sem-data'}__${orderSn}__${occurrence}`
}

interface ExistingOrderRow {
  order_key: string
  row_json: string
  sheet_date: string
}

function findOrderByKey(orderKey: string, workbookId: string = SHOPEE_WORKBOOK_ID): ExistingOrderRow | undefined {
  return db
    .prepare('SELECT order_key, row_json, sheet_date FROM orders WHERE workbook_id = ? AND order_key = ?')
    .get(workbookId, orderKey) as ExistingOrderRow | undefined
}

function findOrdersBySn(orderSn: string, workbookId: string = SHOPEE_WORKBOOK_ID): ExistingOrderRow[] {
  return db
    .prepare(
      'SELECT order_key, row_json, sheet_date FROM orders WHERE workbook_id = ? AND id = ? ORDER BY order_key ASC',
    )
    .all(workbookId, orderSn) as ExistingOrderRow[]
}

export function shopeeOrderExists(orderSn: string, workbookId: string = SHOPEE_WORKBOOK_ID): boolean {
  return findOrdersBySn(orderSn.trim(), workbookId).length > 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Busca detalhe na API e cria/atualiza linha — retries porque o push pode chegar antes da API indexar o pedido. */
export async function importShopeeOrderBySn(
  orderSn: string,
  fallbackStatus?: string,
  workbookId: string = SHOPEE_WORKBOOK_ID,
  strictShipDate = false,
): Promise<'created' | 'updated' | 'unchanged' | 'failed'> {
  const sn = orderSn.trim()
  if (!sn) return 'failed'

  const retryDelaysMs = [0, 3000, 10000]
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) await sleep(retryDelaysMs[attempt])
    try {
      const data = await getOrderDetail([sn])
      const orders = parseOrderList(data)
      const order = orders.find((o) => o.order_sn === sn) ?? orders[0]
      if (!order?.order_sn) {
        console.warn(`[shopee-push] get_order_detail vazio (tentativa ${attempt + 1}/${retryDelaysMs.length})`, sn)
        continue
      }
      if (fallbackStatus && !order.order_status) order.order_status = fallbackStatus
      return upsertShopeeOrder(order, workbookId, strictShipDate)
    } catch (error) {
      console.warn(
        `[shopee-push] get_order_detail erro (tentativa ${attempt + 1}/${retryDelaysMs.length})`,
        sn,
        error instanceof Error ? error.message : error,
      )
    }
  }
  return 'failed'
}

/**
 * 1 linha por item; reimport atualiza só G+H (preserva F e demais colunas). Não escreve nada
 * (nem toca updated_at) quando a linha já está idêntica — evita "atualizado" fantasma nas
 * rotinas de reconferência (resyncPendingDateOrders/resyncReadyToShipDates) que rodam de novo
 * sobre pedidos que já estavam certos.
 */
export function upsertShopeeOrder(
  order: ShopeeOrderDetail,
  workbookId: string = SHOPEE_WORKBOOK_ID,
  strictShipDate = false,
): 'created' | 'updated' | 'unchanged' {
  const orderSn = order.order_sn?.trim()
  if (!orderSn) throw new Error('order_sn ausente')

  const sheetDate = resolveSheetDate(order, strictShipDate)
  const itemRows = mapShopeeOrderToItemRows(order)
  const shopeeStatus = order.order_status ?? ''
  const recipient = order.recipient_address?.name ?? ''
  const now = nowMs()
  let anyCreated = false
  let anyChanged = false

  let nextPos =
    (db
      .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM orders WHERE workbook_id = ?')
      .get(workbookId) as { m: number }).m + 1

  const updateStmt = db.prepare(
    'UPDATE orders SET row_json = ?, sheet_date = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?',
  )
  const insertStmt = db.prepare(
    `INSERT INTO orders (workbook_id, order_key, id, row_json, styles_json, disappeared, sheet_date, position, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (let i = 0; i < itemRows.length; i++) {
    const occurrence = i + 1
    const orderKey = shopeeOrderKey(sheetDate, orderSn, occurrence)
    let existing = findOrderByKey(orderKey, workbookId)
    if (!existing && occurrence === 1) {
      const legacy = findOrdersBySn(orderSn, workbookId)
      if (legacy.length === 1) existing = legacy[0]
    }

    const row = itemRows[i]
    row[SHOPEE_COL_RECIPIENT] = recipient
    row[SHOPEE_COL_SHOPEE_STATUS] = shopeeStatus

    if (existing) {
      const prev = JSON.parse(existing.row_json) as string[]
      while (prev.length < SHOPEE_ROW_COLS) prev.push('')
      row[SHOPEE_COL_INTERNAL_STATUS] = prev[SHOPEE_COL_INTERNAL_STATUS]
      row[SHOPEE_COL_ORDER_ID] = prev[SHOPEE_COL_ORDER_ID] || row[SHOPEE_COL_ORDER_ID]
      row[SHOPEE_COL_PRODUCT] = prev[SHOPEE_COL_PRODUCT]
      row[SHOPEE_COL_MODEL] = prev[SHOPEE_COL_MODEL]
      row[SHOPEE_COL_QTY] = prev[SHOPEE_COL_QTY]
      row[SHOPEE_COL_USERNAME] = prev[SHOPEE_COL_USERNAME]
      applyInternalStatusFromShopee(row, shopeeStatus)
      const rowJson = JSON.stringify(row)
      if (rowJson !== existing.row_json || sheetDate !== existing.sheet_date) {
        updateStmt.run(rowJson, sheetDate, now, workbookId, existing.order_key)
        anyChanged = true
      }
    } else {
      applyInternalStatusFromShopee(row, shopeeStatus)
      anyCreated = true
      anyChanged = true
      insertStmt.run(
        workbookId,
        orderKey,
        orderSn,
        JSON.stringify(row),
        '{}',
        0,
        sheetDate,
        nextPos++,
        now,
      )
    }
  }

  if (anyChanged) {
    db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  }
  return anyCreated ? 'created' : anyChanged ? 'updated' : 'unchanged'
}

/** Atualiza Status Shopee (col H) em todas as linhas do pedido — push code 3. */
export function updateShopeeOrderStatus(
  orderSn: string,
  shopeeStatus: string,
  workbookId: string = SHOPEE_WORKBOOK_ID,
): 'updated' | 'missing' {
  const rows = findOrdersBySn(orderSn.trim(), workbookId)
  if (rows.length === 0) return 'missing'
  const now = nowMs()
  const updateStmt = db.prepare(
    'UPDATE orders SET row_json = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?',
  )
  for (const existing of rows) {
    const row = JSON.parse(existing.row_json) as string[]
    while (row.length < SHOPEE_ROW_COLS) row.push('')
    row[SHOPEE_COL_SHOPEE_STATUS] = shopeeStatus
    applyInternalStatusFromShopee(row, shopeeStatus)
    updateStmt.run(JSON.stringify(row), now, workbookId, existing.order_key)
  }
  db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  return 'updated'
}

async function collectOrderSnsPage(
  timeFrom: number,
  timeTo: number,
  orderStatus: string | undefined,
  timeRangeField: 'create_time' | 'update_time' = 'create_time',
): Promise<string[]> {
  const sns: string[] = []
  let cursor = ''
  let more = true
  while (more) {
    const page = await fetchOrderListPage({
      timeFrom,
      timeTo,
      orderStatus,
      pageSize: 100,
      cursor: cursor || undefined,
      timeRangeField,
    })
    sns.push(...page.orderSnList)
    more = page.more
    cursor = page.nextCursor
    if (more && !cursor) break
  }
  return sns
}

/** Lista pedidos de todos os status na janela (poll e import manual) — order_status omitido = sem filtro. */
async function collectOrderSns(
  timeFrom: number,
  timeTo: number,
  errors?: string[],
  timeRangeField: 'create_time' | 'update_time' = 'create_time',
): Promise<string[]> {
  try {
    return collectOrderSnsPage(timeFrom, timeTo, undefined, timeRangeField)
  } catch (error) {
    const msg = `get_order_list: ${error instanceof Error ? error.message : String(error)}`
    console.warn('[shopee-sync] get_order_list falhou —', msg)
    errors?.push(msg)
    return []
  }
}

/** Janela de busca — 20h com poll a cada 2h garante sobreposição ampla se uma execução falhar. */
export const SHOPEE_POLL_LOOKBACK_HOURS = 20

/** Busca detalhe em lotes de 50 e faz upsert — usado por todas as rotinas de sync abaixo. */
async function upsertOrderSnsBatched(
  orderSns: string[],
  preErrors: string[] = [],
  workbookId: string = SHOPEE_WORKBOOK_ID,
  strictShipDate = false,
): Promise<ShopeeSyncResult> {
  const result: ShopeeSyncResult = { listed: orderSns.length, created: 0, updated: 0, errors: [...preErrors] }

  for (let i = 0; i < orderSns.length; i += 50) {
    const batch = orderSns.slice(i, i + 50)
    try {
      const data = await getOrderDetail(batch)
      const orders = parseOrderList(data)
      for (const order of orders) {
        try {
          const action = upsertShopeeOrder(order, workbookId, strictShipDate)
          if (action === 'created') result.created++
          else if (action === 'updated') result.updated++
        } catch (error) {
          result.errors.push(
            `${order.order_sn ?? '?'}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
      }
    } catch (error) {
      result.errors.push(
        `batch ${Math.floor(i / 50) + 1}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  return result
}

/** Importa pedidos recentes via API — todos os status (push desativado; poll é a única via). */
export async function syncRecentShopeeOrders(options: {
  hours?: number
} = {}): Promise<ShopeeSyncResult> {
  ensureShopeeWorkbook()
  const hours = Math.min(Math.max(options.hours ?? SHOPEE_POLL_LOOKBACK_HOURS, 1), 168)
  const timeTo = Math.floor(Date.now() / 1000)
  const timeFrom = timeTo - hours * 3600

  const errors: string[] = []
  const orderSns = await collectOrderSns(timeFrom, timeTo, errors)
  return upsertOrderSnsBatched(orderSns, errors)
}

/**
 * Reconsulta por `update_time` em vez de `create_time` — cobre pedido ANTIGO que só mudou de
 * status (ex.: pago dias depois de criado) dentro da janela. `syncRecentShopeeOrders` (create_time)
 * só pega pedido CRIADO na janela; um pedido criado há 9 dias e pago hoje nunca aparecia em
 * nenhum resync (não é "recente" pra criação, não é "Sem data", e resyncReadyToShipDates só
 * pega quem JÁ está READY_TO_SHIP no nosso banco — UNPAID ficava órfão pra sempre). Ver memória
 * `bug-shopee-unpaid-nunca-resincroniza-2026-07-15`.
 */
export async function syncRecentlyUpdatedShopeeOrders(options: {
  hours?: number
} = {}): Promise<ShopeeSyncResult> {
  ensureShopeeWorkbook()
  const hours = Math.min(Math.max(options.hours ?? SHOPEE_POLL_LOOKBACK_HOURS, 1), 168)
  const timeTo = Math.floor(Date.now() / 1000)
  const timeFrom = timeTo - hours * 3600

  const errors: string[] = []
  const orderSns = await collectOrderSns(timeFrom, timeTo, errors, 'update_time')
  return upsertOrderSnsBatched(orderSns, errors)
}

function findOrderSnsPendingDate(workbookId: string = SHOPEE_WORKBOOK_ID): string[] {
  const rows = db
    .prepare('SELECT DISTINCT id FROM orders WHERE workbook_id = ? AND sheet_date IN (?, ?)')
    .all(workbookId, SHOPEE_PENDING_DATE_LABEL, '') as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/**
 * Reconsulta pedidos presos na aba "Sem data de envio" (ship_by_date ainda não calculado
 * pela Shopee na 1ª importação) — roda junto do poll de 2h, sem depender da janela de tempo,
 * já que um pedido pode ficar dias parado antes do prazo de envio aparecer. Também cobre
 * `sheet_date=''` (pedidos que caíram antes do fix, sem o rótulo novo) — autocorrige sozinho.
 * `strictShipDate` propaga pro upsert — usado pelo workbook do webhook (ver
 * SHOPEE_WEBHOOK_WORKBOOK_ID) pra não voltar a cair no fallback create_time.
 */
export async function resyncPendingDateOrders(
  workbookId: string = SHOPEE_WORKBOOK_ID,
  strictShipDate = false,
): Promise<ShopeeSyncResult> {
  ensureShopeeWorkbook()
  return upsertOrderSnsBatched(findOrderSnsPendingDate(workbookId), [], workbookId, strictShipDate)
}

function findOrderSnsReadyToShip(workbookId: string = SHOPEE_WORKBOOK_ID): string[] {
  const rows = db
    .prepare('SELECT id, row_json FROM orders WHERE workbook_id = ?')
    .all(workbookId) as Array<{ id: string; row_json: string }>
  const orderSns = new Set<string>()
  for (const row of rows) {
    let cells: string[]
    try {
      cells = JSON.parse(row.row_json) as string[]
    } catch {
      continue
    }
    if (cells[SHOPEE_COL_SHOPEE_STATUS] === 'READY_TO_SHIP') orderSns.add(row.id)
  }
  return [...orderSns]
}

/**
 * Reconfere a data de TODO pedido hoje em READY_TO_SHIP, mesmo os que já têm data — corrige
 * pedidos que vieram com data errada antes do fix do `resolveSheetDate`, e cobre o caso da
 * Shopee às vezes empurrar o ship_by_date +1 dia depois (bug do lado deles) já visto na prática.
 */
export async function resyncReadyToShipDates(workbookId: string = SHOPEE_WORKBOOK_ID): Promise<ShopeeSyncResult> {
  ensureShopeeWorkbook()
  return upsertOrderSnsBatched(findOrderSnsReadyToShip(workbookId), [], workbookId)
}

async function collectAllOrderSns(timeFrom: number, timeTo: number, errors?: string[]): Promise<string[]> {
  return collectOrderSns(timeFrom, timeTo, errors)
}

export async function syncShopeeWorkbookOrders(options: {
  days?: number
  /** Dias atrás em que termina a janela (0 = agora). Com days=1 e offsetDays=1 → ontem. */
  offsetDays?: number
} = {}): Promise<ShopeeSyncResult> {
  ensureShopeeWorkbook()
  const days = Math.min(Math.max(options.days ?? 90, 1), 365)
  const offsetDays = Math.max(options.offsetDays ?? 0, 0)
  const timeTo = Math.floor(Date.now() / 1000) - offsetDays * 86400
  const timeFrom = timeTo - days * 86400

  const errors: string[] = []
  const orderSns = await collectAllOrderSns(timeFrom, timeTo, errors)
  return upsertOrderSnsBatched(orderSns, errors)
}
