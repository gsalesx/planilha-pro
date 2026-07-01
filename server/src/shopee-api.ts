import { createHmac } from 'node:crypto'

import { env, type ShopeeRuntimeEnv } from './env.js'
import { loadShopeeAuth, saveShopeeAuth, type ShopeeAuthRecord } from './shopee-store.js'

export interface ShopeeApiResponse<T = unknown> {
  error?: string
  message?: string
  request_id?: string
  response?: T
  [key: string]: unknown
}

const HOSTS: Record<ShopeeRuntimeEnv, string> = {
  sandbox: 'https://openplatform.sandbox.test-stable.shopee.sg',
  production: 'https://partner.shopeemobile.com',
}

export function shopeeHost(): string {
  return HOSTS[env.shopeeEnv]
}

function signBase(partnerId: string, path: string, timestamp: number, tail = ''): string {
  return `${partnerId}${path}${timestamp}${tail}`
}

export function hmacSign(base: string): string {
  return createHmac('sha256', env.shopeePartnerKey).update(base).digest('hex')
}

export function signPublic(path: string, timestamp: number): string {
  return hmacSign(signBase(env.shopeePartnerId, path, timestamp))
}

export function signShop(path: string, timestamp: number, accessToken: string, shopId: number): string {
  return hmacSign(signBase(env.shopeePartnerId, path, timestamp, `${accessToken}${shopId}`))
}

function buildSignedUrl(path: string, sign: string, timestamp: number, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams({
    partner_id: env.shopeePartnerId,
    timestamp: String(timestamp),
    sign,
  })
  for (const [key, value] of Object.entries(extra)) {
    params.set(key, String(value))
  }
  return `${shopeeHost()}${path}?${params.toString()}`
}

async function parseShopeeJson<T>(response: Response): Promise<ShopeeApiResponse<T>> {
  const text = await response.text()
  try {
    return JSON.parse(text) as ShopeeApiResponse<T>
  } catch {
    throw new Error(`Resposta inválida da Shopee (${response.status}): ${text.slice(0, 300)}`)
  }
}

function hasShopeeError(data: ShopeeApiResponse): boolean {
  return Boolean(data.error && data.error !== '')
}

function unwrapShopeeResponse<T extends Record<string, unknown>>(
  data: ShopeeApiResponse<T>,
  context: string,
): T {
  if (hasShopeeError(data)) {
    throw new Error(`${context}: ${data.error}${data.message ? ` — ${data.message}` : ''}`)
  }
  if (data.response != null && typeof data.response === 'object') {
    return data.response as T
  }
  const meta = new Set(['error', 'message', 'request_id'])
  const flat = Object.fromEntries(Object.entries(data).filter(([k]) => !meta.has(k))) as T
  if (Object.keys(flat).length === 0) {
    throw new Error(`${context}: resposta vazia — ${JSON.stringify(data).slice(0, 300)}`)
  }
  return flat
}

export function assertShopeeOk<T extends Record<string, unknown>>(data: ShopeeApiResponse<T>, context: string): T {
  return unwrapShopeeResponse(data, context)
}

type TokenPayload = Record<string, unknown> & {
  access_token?: string
  refresh_token?: string
  expire_in?: number
  expires_in?: number
  shop_id?: number
}

function tokenExpireSeconds(payload: TokenPayload): number {
  return payload.expire_in ?? payload.expires_in ?? 4 * 3600
}

export function buildAuthPartnerUrl(): string {
  const path = '/api/v2/shop/auth_partner'
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signPublic(path, timestamp)
  const redirect = encodeURIComponent(env.shopeeRedirectUrl)
  return `${shopeeHost()}${path}?partner_id=${env.shopeePartnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${redirect}`
}

export async function exchangeAuthCode(code: string, shopId: number): Promise<ShopeeAuthRecord> {
  const path = '/api/v2/auth/token/get'
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signPublic(path, timestamp)
  const url = buildSignedUrl(path, sign, timestamp)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      shop_id: shopId,
      partner_id: Number(env.shopeePartnerId),
    }),
  })
  const data = await parseShopeeJson<TokenPayload>(response)
  const payload = assertShopeeOk(data, 'token/get')
  if (!payload.access_token || !payload.refresh_token) {
    throw new Error(`token/get: resposta incompleta — ${JSON.stringify(data).slice(0, 300)}`)
  }
  const now = Date.now()
  const record: ShopeeAuthRecord = {
    shopId: payload.shop_id ?? shopId,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessExpireAt: now + tokenExpireSeconds(payload) * 1000,
    updatedAt: now,
  }
  saveShopeeAuth(record)
  return record
}

export async function refreshShopAccessToken(record: ShopeeAuthRecord): Promise<ShopeeAuthRecord> {
  const path = '/api/v2/auth/access_token/get'
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signPublic(path, timestamp)
  const url = buildSignedUrl(path, sign, timestamp)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shop_id: record.shopId,
      refresh_token: record.refreshToken,
      partner_id: Number(env.shopeePartnerId),
    }),
  })
  const data = await parseShopeeJson<TokenPayload>(response)
  const payload = assertShopeeOk(data, 'access_token/get')
  if (!payload.access_token || !payload.refresh_token) {
    throw new Error(`access_token/get: resposta incompleta — ${JSON.stringify(data).slice(0, 300)}`)
  }
  const now = Date.now()
  const updated: ShopeeAuthRecord = {
    shopId: payload.shop_id ?? record.shopId,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessExpireAt: now + tokenExpireSeconds(payload) * 1000,
    updatedAt: now,
  }
  saveShopeeAuth(updated)
  return updated
}

export async function ensureShopAuth(): Promise<ShopeeAuthRecord> {
  let record = loadShopeeAuth()
  if (!record) throw new Error('Loja não autorizada. Use o link de autorização no painel Shopee.')
  if (Date.now() >= record.accessExpireAt - 5 * 60 * 1000) {
    record = await refreshShopAccessToken(record)
  }
  return record
}

async function shopApiGet(path: string, query: Record<string, string | number> = {}): Promise<ShopeeApiResponse> {
  const auth = await ensureShopAuth()
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signShop(path, timestamp, auth.accessToken, auth.shopId)
  const url = buildSignedUrl(path, sign, timestamp, {
    access_token: auth.accessToken,
    shop_id: auth.shopId,
    ...query,
  })
  const response = await fetch(url, { method: 'GET' })
  return parseShopeeJson(response)
}

async function shopApiPost(
  path: string,
  body: unknown,
  query: Record<string, string | number> = {},
): Promise<ShopeeApiResponse> {
  const auth = await ensureShopAuth()
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signShop(path, timestamp, auth.accessToken, auth.shopId)
  const url = buildSignedUrl(path, sign, timestamp, {
    access_token: auth.accessToken,
    shop_id: auth.shopId,
    ...query,
  })
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return parseShopeeJson(response)
}

export interface OrderListParams {
  timeFrom: number
  timeTo: number
  orderStatus?: string
  pageSize?: number
  cursor?: string
  timeRangeField?: 'create_time' | 'update_time'
}

export async function getOrderList(params: OrderListParams): Promise<ShopeeApiResponse> {
  const query: Record<string, string | number> = {
    time_range_field: params.timeRangeField ?? 'create_time',
    time_from: params.timeFrom,
    time_to: params.timeTo,
    page_size: params.pageSize ?? 50,
    response_optional_fields: 'order_status',
  }
  if (params.orderStatus) query.order_status = params.orderStatus
  if (params.cursor) query.cursor = params.cursor
  return shopApiGet('/api/v2/order/get_order_list', query)
}

const ORDER_DETAIL_FIELDS =
  'buyer_username,recipient_address,item_list,order_status,create_time,ship_by_date'

export async function getOrderDetail(
  orderSnList: string[],
  optionalFields: string = ORDER_DETAIL_FIELDS,
): Promise<ShopeeApiResponse> {
  if (!orderSnList.length) throw new Error('orderSnList obrigatório')
  return shopApiGet('/api/v2/order/get_order_detail', {
    order_sn_list: orderSnList.slice(0, 50).join(','),
    response_optional_fields: optionalFields,
  })
}

export const ORDER_BUYER_FIELDS = 'buyer_user_id,buyer_username'

/** Único status consultado no poll/import automático (get_order_list). */
export const SHOPEE_SYNC_ORDER_STATUS = 'RETRY_SHIP'

export interface OrderListPage {
  orderSnList: string[]
  more: boolean
  nextCursor: string
}

export async function fetchOrderListPage(params: OrderListParams): Promise<OrderListPage> {
  const data = await getOrderList(params)
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_order_list') as {
    order_list?: Array<{ order_sn?: string }>
    more?: boolean
    next_cursor?: string
  }
  const orderSnList = (body.order_list ?? [])
    .map((o) => o.order_sn)
    .filter((sn): sn is string => Boolean(sn))
  return {
    orderSnList,
    more: Boolean(body.more),
    nextCursor: body.next_cursor ?? '',
  }
}

export async function getShopInfo(): Promise<ShopeeApiResponse> {
  return shopApiGet('/api/v2/shop/get_shop_info')
}

export interface ItemListParams {
  offset?: number
  pageSize?: number
  itemStatus?: string
  updateTimeFrom?: number
  updateTimeTo?: number
}

export async function getItemList(params: ItemListParams = {}): Promise<ShopeeApiResponse> {
  const query: Record<string, string | number> = {
    offset: params.offset ?? 0,
    page_size: params.pageSize ?? 20,
    item_status: params.itemStatus ?? 'NORMAL',
  }
  if (params.updateTimeFrom != null) query.update_time_from = params.updateTimeFrom
  if (params.updateTimeTo != null) query.update_time_to = params.updateTimeTo
  return shopApiGet('/api/v2/product/get_item_list', query)
}

export async function getItemBaseInfo(itemIds: number[]): Promise<ShopeeApiResponse> {
  if (!itemIds.length) throw new Error('itemIds obrigatório')
  return shopApiGet('/api/v2/product/get_item_base_info', {
    item_id_list: itemIds.join(','),
    need_tax_info: 'false',
    need_complaint_policy: 'false',
  })
}

export async function getModelList(itemId: number): Promise<ShopeeApiResponse> {
  return shopApiGet('/api/v2/product/get_model_list', { item_id: itemId })
}

export async function updateItemSku(itemId: number, itemSku: string): Promise<ShopeeApiResponse> {
  return shopApiPost('/api/v2/product/update_item', {
    item_id: itemId,
    item_sku: itemSku,
  })
}

export async function updateModelSkus(
  itemId: number,
  models: Array<{ model_id: number; model_sku: string }>,
): Promise<ShopeeApiResponse> {
  if (!models.length) throw new Error('model list vazia')
  return shopApiPost('/api/v2/product/update_model', {
    item_id: itemId,
    model: models,
  })
}

export const SHOPEE_ITEM_LIST_STATUSES = ['NORMAL', 'UNLIST'] as const

export async function fetchAllItemIds(statuses = SHOPEE_ITEM_LIST_STATUSES): Promise<number[]> {
  const seen = new Set<number>()
  for (const itemStatus of statuses) {
    let offset = 0
    const pageSize = 100
    while (true) {
      const data = await getItemList({ offset, pageSize, itemStatus })
      const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_item_list') as {
        item?: Array<{ item_id?: number }>
        has_next_page?: boolean
        next_offset?: number
      }
      const batch = (body.item ?? [])
        .map((row) => row.item_id)
        .filter((id): id is number => typeof id === 'number' && id > 0)
      for (const id of batch) seen.add(id)
      if (!body.has_next_page || batch.length === 0) break
      offset = body.next_offset ?? offset + pageSize
    }
  }
  return [...seen]
}

export interface ConversationListParams {
  direction?: 'latest' | 'oldest'
  type?: 'all' | 'pinned' | 'unread'
  pageSize?: number
  nextTimestamp?: number
}

export async function getConversationList(params: ConversationListParams = {}): Promise<ShopeeApiResponse> {
  const query: Record<string, string | number> = {
    direction: params.direction ?? 'latest',
    type: params.type ?? 'all',
    page_size: params.pageSize ?? 20,
  }
  if (params.nextTimestamp != null) query.next_timestamp_nano = params.nextTimestamp
  return shopApiGet('/api/v2/sellerchat/get_conversation_list', query)
}

export interface MessageListParams {
  conversationId: string
  pageSize?: number
  /** message_id cursor — omita ou '' para as mais recentes (padrão Shopee) */
  offset?: number | string
}

export async function getMessageList(params: MessageListParams): Promise<ShopeeApiResponse> {
  const query: Record<string, string | number> = {
    conversation_id: params.conversationId,
    page_size: params.pageSize ?? 20,
  }
  if (params.offset != null && params.offset !== '') {
    query.offset = params.offset
  } else {
    query.offset = ''
  }
  return shopApiGet('/api/v2/sellerchat/get_message', query)
}

export interface ShopeeConversationEntry {
  conversationId: string
  toId: number
  toName: string
}

/** Quantos chats recentes varrer no vínculo (get_conversation_list). */
export const SHOPEE_CONVERSATION_SCAN_MAX = 1000

function parseConversationRow(row: Record<string, unknown>): ShopeeConversationEntry | null {
  const toUserInfo =
    row.to_user_info && typeof row.to_user_info === 'object'
      ? (row.to_user_info as Record<string, unknown>)
      : undefined
  const toId = Number(
    row.to_id ??
      row.to_user_id ??
      row.buyer_user_id ??
      row.buyer_id ??
      row.user_id ??
      toUserInfo?.user_id ??
      toUserInfo?.to_id ??
      0,
  )
  const conversationId = String(row.conversation_id ?? row.id ?? row.latest_conversation_id ?? '').trim()
  const toName = String(
    row.to_name ??
      row.to_user_name ??
      row.username ??
      row.buyer_username ??
      toUserInfo?.name ??
      toUserInfo?.user_name ??
      '',
  ).trim()
  if (!toId || !conversationId) return null
  return { conversationId, toId, toName }
}

function conversationListFromBody(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw =
    body.conversations ??
    body.conversation_list ??
    body.list ??
    body.conversation ??
    body.items
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
}

function resolveNextConversationCursor(
  body: Record<string, unknown>,
  list: Array<Record<string, unknown>>,
): number | undefined {
  const pageResult =
    body.page_result && typeof body.page_result === 'object'
      ? (body.page_result as Record<string, unknown>)
      : undefined
  const more = pageResult?.more ?? body.more
  const rawNext =
    pageResult?.next_timestamp_nano ??
    body.next_timestamp_nano ??
    pageResult?.next_cursor ??
    body.next_cursor ??
    pageResult?.cursor ??
    body.cursor

  if (rawNext != null && rawNext !== '' && rawNext !== 0) {
    const n = Number(rawNext)
    if (!Number.isNaN(n) && n > 0) return n
  }

  if (more === true || more === 'true' || more === 1) {
    const last = list[list.length - 1]
    if (last) {
      const ts =
        last.latest_message_timestamp_nano ??
        last.last_message_timestamp_nano ??
        last.latest_message_timestamp ??
        last.last_message_timestamp ??
        last.last_message_time ??
        last.update_time
      if (ts != null && ts !== '') {
        const n = Number(ts)
        if (!Number.isNaN(n) && n > 0) return n
      }
    }
  }

  return undefined
}

/** Pagina get_conversation_list — até maxConversations ou achar todos os to_id pedidos. */
export async function fetchConversationMap(
  targetBuyerIds?: Set<number>,
  options: { maxConversations?: number } = {},
): Promise<{
  byBuyerId: Map<number, ShopeeConversationEntry>
  byUsername: Map<string, ShopeeConversationEntry>
  scanned: number
  indexed: number
  pages: number
}> {
  const byBuyerId = new Map<number, ShopeeConversationEntry>()
  const byUsername = new Map<string, ShopeeConversationEntry>()
  const maxConversations = Math.min(Math.max(options.maxConversations ?? SHOPEE_CONVERSATION_SCAN_MAX, 50), 5000)
  let nextTimestamp: number | undefined
  let scanned = 0
  let indexed = 0
  let pages = 0
  let prevCursor: number | undefined

  const allFound = (): boolean => {
    if (!targetBuyerIds || targetBuyerIds.size === 0) return false
    for (const id of targetBuyerIds) {
      if (!byBuyerId.has(id)) return false
    }
    return true
  }

  while (scanned < maxConversations) {
    const pageSize = Math.min(50, maxConversations - scanned)
    const data = await getConversationList({
      direction: 'latest',
      type: 'all',
      pageSize,
      nextTimestamp,
    })
    const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_conversation_list') as Record<
      string,
      unknown
    >
    const list = conversationListFromBody(body)
    pages++
    if (list.length === 0) break

    for (const row of list) {
      scanned++
      const entry = parseConversationRow(row)
      if (!entry) continue
      indexed++
      byBuyerId.set(entry.toId, entry)
      if (entry.toName) byUsername.set(entry.toName.toLowerCase(), entry)
    }

    if (allFound() || scanned >= maxConversations) break

    const next = resolveNextConversationCursor(body, list)
    if (next == null || next === prevCursor) break
    prevCursor = nextTimestamp
    nextTimestamp = next
  }

  return { byBuyerId, byUsername, scanned, indexed, pages }
}
