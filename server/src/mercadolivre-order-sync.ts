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
import { marketplaceDeleteOrdersById, marketplaceUpsertOrder } from './marketplace-order-upsert.js'
import {
  fetchMlItemImageUrl,
  getOrder,
  getPack,
  getShipment,
  getShipmentSla,
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

/**
 * Dia de calendário escrito pelo ML (o YYYY-MM-DD da string), sem converter fuso.
 * buffering vem como meia-noite UTC (`2026-09-22T00:00:00.000Z`). Converter pra
 * America/Sao_Paulo joga esse dia pra trás. O painel usa o dia que está escrito.
 */
function calendarDay(iso: string | null | undefined): string | null {
  const match = String(iso ?? '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!match) return null
  return `${match[3]}-${match[2]}-${match[1]}`
}

/**
 * Data do `<select>` — prazo de despacho do vendedor, NUNCA data da venda.
 *
 * Pedido já liberado (`ready_to_ship`): o painel mostra "Enviar hoje" no dia de
 * `pay_before` (ou do buffering, se a etiqueta acabou de liberar). O SLA
 * `expected_date` nesse momento é o dia seguinte às 23:59 — tolerância
 * `same_day_or_<dia seguinte>` do horário de despacho — e não o dia que o ML cobra.
 * Gravar o SLA atrasa a planilha 1 dia e o pedido estoura no painel.
 *
 * Ainda em preparação (`buffered`): SLA e buffering caem no mesmo dia. Segue o SLA.
 * Sem prazo → "Sem data de envio".
 */
function resolveSheetDate(
  shipment?: MlShipment | null,
  slaExpectedDate?: string | null,
  manufacturingEndingDate?: string | null,
): string {
  if (shipment?.status === 'ready_to_ship') {
    const dispatchDay =
      calendarDay(shipment.shipping_option?.estimated_delivery_time?.pay_before) ??
      calendarDay(shipment.shipping_option?.buffering?.date)
    if (dispatchDay) return dispatchDay
  }
  if (slaExpectedDate) return formatSheetDate(slaExpectedDate)
  if (manufacturingEndingDate) return formatSheetDate(manufacturingEndingDate)
  const schedule = shipment?.shipping_option?.estimated_schedule_limit?.date
  if (schedule) return formatSheetDate(schedule)
  const legacy = shipment?.shipping_option?.estimated_handling_limit?.date
  if (legacy) return formatSheetDate(legacy)
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

type MlOrderItem = NonNullable<MlOrder['order_items']>[number]

function mlItemSku(item: MlOrderItem): string {
  return String(item.item?.seller_sku || item.item?.seller_custom_field || '').trim()
}

function mlItemSize(item: MlOrderItem): string {
  const attrs = item.item?.variation_attributes ?? []
  const size = attrs.find((a) => a.id === 'SIZE' || /^tamanho$/i.test(String(a.name ?? '')))
  return String(size?.value_name ?? '').trim()
}

function mlNorm(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toUpperCase().trim()
}

/** Gênero só do SKU ML — não altera o parser da Shopee. */
function mlGenderLabel(sku: string): 'Masculino' | 'Feminino' | null {
  const s = mlNorm(sku)
  if (s.includes('FEMININO') || /(^|[-_\s])FEM($|[-_\s])/.test(s)) return 'Feminino'
  if (s.includes('MASCULINO') || /(^|[-_\s])MASC($|[-_\s])/.test(s)) return 'Masculino'
  if (s.includes('CUECA')) return 'Masculino'
  return null
}

function mlSizeFromSku(sku: string): string {
  const stripped = mlNorm(sku).replace(/[-_\s]+(FEMININO|MASCULINO|FEM|MASC)$/, '').trim()
  const parts = stripped.split(/[-_]/).map((t) => t.trim()).filter(Boolean)
  const last = parts[parts.length - 1] ?? ''
  if (/^(P|M|G|GG)$/.test(last)) return last
  if (parts.length >= 2 && last === 'ANOS' && /^\d{1,2}$/.test(parts[parts.length - 2])) {
    return `${Number(parts[parts.length - 2])} anos`
  }
  return ''
}

function mlIsCamisolaOnly(sku: string): boolean {
  const s = mlNorm(sku)
  return s.includes('CAMISOLA') && !s.includes('SHORT') && !s.includes('CONJ')
}

/**
 * Col C no formato que o parser da Shopee já entende.
 * Camisola: "P". Short/conjunto: "P,Feminino" / "GG,Masculino".
 */
function mlShopeeModel(item: MlOrderItem): string {
  const sku = mlItemSku(item)
  const size = mlItemSize(item) || mlSizeFromSku(sku)
  if (!size) return ''
  if (mlIsCamisolaOnly(sku)) return size
  const gender = mlGenderLabel(sku)
  if (gender) return `${size},${gender}`
  return size
}

async function mlItemImageUrl(
  item: MlOrderItem,
  cache: Map<string, string | undefined>,
): Promise<string | undefined> {
  const itemId = String(item.item?.id ?? '').trim()
  if (!itemId) return undefined
  const key = `${itemId}:${item.item?.variation_id ?? ''}`
  if (cache.has(key)) return cache.get(key)
  try {
    const url = await fetchMlItemImageUrl(itemId, item.item?.variation_id)
    cache.set(key, url)
    return url
  } catch {
    cache.set(key, undefined)
    return undefined
  }
}

export async function mapMlOrderToUnitRows(
  order: MlOrder,
  shipment?: MlShipment | null,
  sheetOrderId?: string,
  imageCache: Map<string, string | undefined> = new Map(),
): Promise<{ unitRows: string[][]; productImageUrls: (string | undefined)[] }> {
  const items = order.order_items ?? []
  const recipientName =
    shipment?.receiver_address?.receiver_name ??
    [order.buyer?.first_name, order.buyer?.last_name].filter(Boolean).join(' ') ??
    ''
  const buyerNickname = order.buyer?.nickname ?? ''
  const mktStatus = resolveMarketplaceStatus(order, shipment)
  const orderId = sheetOrderId || String(order.id ?? '')

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
    const imageUrl = await mlItemImageUrl(item, imageCache)
    const qty = Math.max(1, item.quantity ?? 1)
    for (let u = 0; u < qty; u++) {
      const row = emptyMarketplaceRow()
      row[MP_COL_ORDER_ID] = orderId
      row[MP_COL_PRODUCT] = mlItemSku(item)
      row[MP_COL_MODEL] = mlShopeeModel(item)
      row[MP_COL_QTY] = '1'
      row[MP_COL_USERNAME] = buyerNickname
      row[MP_COL_RECIPIENT] = recipientName
      row[MP_COL_MARKETPLACE_STATUS] = mktStatus
      unitRows.push(row)
      productImageUrls.push(imageUrl)
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

async function fetchShipmentSlaExpectedDate(shippingId: number | undefined): Promise<string | null> {
  if (!shippingId) return null
  try {
    const sla = await getShipmentSla(shippingId)
    return sla.expected_date ?? null
  } catch {
    return null
  }
}

function isOrderNotFound(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error)
  return msg.includes('404') || msg.includes('order_not_found')
}

function packMemberIds(pack: { orders?: Array<{ id?: number }> }): number[] {
  return (pack.orders ?? []).map((o) => Number(o.id)).filter((n) => Number.isFinite(n) && n > 0)
}

type PackMemberCache = Map<string, number[]>

async function memberIdsForOrder(order: MlOrder, cache: PackMemberCache): Promise<number[]> {
  const self = Number(order.id)
  if (!Number.isFinite(self) || self <= 0) return []
  if (!order.pack_id) return [self]
  const key = String(order.pack_id)
  if (!cache.has(key)) {
    try {
      const ids = packMemberIds(await getPack(order.pack_id))
      cache.set(key, ids.length > 0 ? ids : [self])
    } catch {
      cache.set(key, [self])
    }
  }
  return cache.get(key) ?? [self]
}

function sheetIdForMembers(order: MlOrder, memberIds: number[]): string {
  if (memberIds.length >= 2 && order.pack_id) return String(order.pack_id)
  return String(order.id ?? '')
}

async function loadOrdersByIds(ids: number[]): Promise<MlOrder[]> {
  const out: MlOrder[] = []
  for (const id of ids) {
    try {
      const order = await getOrder(id)
      if (order?.id) out.push(order)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn('[ml-sync] getOrder membro falhou', id, msg)
    }
  }
  return out
}

async function upsertMlSale(
  seed: MlOrder,
  ctx: { source?: AuditSource; runId?: string | null; rotina?: string },
  cache: PackMemberCache,
): Promise<'created' | 'updated' | 'unchanged' | 'failed'> {
  if (!seed.id) return 'failed'
  const memberIds = await memberIdsForOrder(seed, cache)
  const sheetId = sheetIdForMembers(seed, memberIds)
  const orders = memberIds.length > 1 ? await loadOrdersByIds(memberIds) : [seed]
  if (orders.length === 0) return 'failed'

  const unitRows: string[][] = []
  const productImageUrls: (string | undefined)[] = []
  const imageCache = new Map<string, string | undefined>()
  let sheetDate = ML_PENDING_DATE_LABEL

  for (const order of orders) {
    const shippingId = order.shipping?.id
    const [shipment, slaExpectedDate] = await Promise.all([
      fetchShipmentSafe(shippingId),
      fetchShipmentSlaExpectedDate(shippingId),
    ])
    const mapped = await mapMlOrderToUnitRows(order, shipment, sheetId, imageCache)
    unitRows.push(...mapped.unitRows)
    productImageUrls.push(...mapped.productImageUrls)
    const nextDate = resolveSheetDate(shipment, slaExpectedDate, order.manufacturing_ending_date)
    if (sheetDate === ML_PENDING_DATE_LABEL) sheetDate = nextDate
  }

  if (unitRows.length === 0) return 'failed'

  const action = marketplaceUpsertOrder({
    workbookId: MERCADOLIVRE_WORKBOOK_ID,
    orderId: sheetId,
    sheetDate,
    unitRows,
    productImageUrls,
    applyInternalStatus,
    overwriteProductFields: true,
    ...ctx,
  })

  if (memberIds.length >= 2) {
    for (const id of memberIds) {
      if (String(id) !== sheetId) marketplaceDeleteOrdersById(MERCADOLIVRE_WORKBOOK_ID, String(id))
    }
  }

  return action
}

async function importSingleMlOrder(
  orderId: number,
  ctx: { source?: AuditSource; runId?: string | null; rotina?: string } = {},
  cache: PackMemberCache = new Map(),
): Promise<'created' | 'updated' | 'unchanged' | 'failed'> {
  const retries = [0, 3000, 10000]
  for (let attempt = 0; attempt < retries.length; attempt++) {
    if (retries[attempt] > 0) await sleep(retries[attempt])
    try {
      const order = await getOrder(orderId)
      if (!order?.id) {
        console.warn(`[ml-sync] detalhe vazio tentativa ${attempt + 1}/${retries.length}`, orderId)
        continue
      }
      return upsertMlSale(order, ctx, cache)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(`[ml-sync] erro tentativa ${attempt + 1}/${retries.length}`, orderId, msg)
    }
  }
  return 'failed'
}

/** Aceita order.id ou pack_id (número da venda no painel do ML). Pack com 2+ pedidos vira 1 linha-pai + filhas. */
export async function importMercadoLivreOrderById(
  orderId: number,
  ctx: { source?: AuditSource; runId?: string | null; rotina?: string } = {},
): Promise<'created' | 'updated' | 'unchanged' | 'failed'> {
  if (!orderId) return 'failed'
  const cache: PackMemberCache = new Map()
  try {
    const order = await getOrder(orderId)
    if (order?.id) return importSingleMlOrder(orderId, ctx, cache)
  } catch (error) {
    if (!isOrderNotFound(error)) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn('[ml-sync] resolve falhou', orderId, msg)
      return 'failed'
    }
  }
  try {
    const pack = await getPack(orderId)
    const ids = packMemberIds(pack)
    if (ids.length === 0) throw new Error(`Pack ${orderId} sem pedidos`)
    cache.set(String(pack.id ?? orderId), ids)
    return importSingleMlOrder(ids[0], ctx, cache)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[ml-sync] resolve falhou', orderId, msg)
    return 'failed'
  }
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
  const packCache: PackMemberCache = new Map()
  const processedSheets = new Set<string>()

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
          if (!order.id) continue
          const memberIds = await memberIdsForOrder(order, packCache)
          const sheetId = sheetIdForMembers(order, memberIds)
          if (processedSheets.has(sheetId)) continue
          processedSheets.add(sheetId)
          const action = await upsertMlSale(order, {
            source: options.ctx?.source ?? 'poll',
            runId: options.ctx?.runId ?? null,
            rotina: 'syncRecentMercadoLivreOrders',
          }, packCache)
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
