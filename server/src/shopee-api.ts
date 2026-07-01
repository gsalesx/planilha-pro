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
  /** latest = aceito; oldest/newest = só para teste no Shopee Test */
  direction?: 'latest' | 'oldest' | 'newest' | string
  type?: 'all' | 'pinned' | 'unread'
  pageSize?: number
  /**
   * Paginação — request usa next_timestamp_nano (string; nanos não cabem em Number seguro).
   * Com direction=latest a API começa no passado e avança em direção ao presente via next_timestamp_nano.
   */
  nextTimestampNano?: string
}

export async function getConversationList(params: ConversationListParams = {}): Promise<ShopeeApiResponse> {
  const query: Record<string, string | number> = {
    direction: params.direction ?? 'latest',
    type: params.type ?? 'all',
    page_size: params.pageSize ?? 20,
  }
  if (params.nextTimestampNano) query.next_timestamp_nano = params.nextTimestampNano
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

export interface SendChatMessageParams {
  toId: number
  text: string
  /** Só obrigatório se business_type ≠ 0 */
  conversationId?: string
  businessType?: number
}

export async function sendChatMessage(params: SendChatMessageParams): Promise<ShopeeApiResponse> {
  const toId = Number(params.toId)
  if (!toId || toId <= 0) throw new Error('toId obrigatório')
  const text = params.text.trim()
  if (!text) throw new Error('texto da mensagem obrigatório')
  const body: Record<string, unknown> = {
    to_id: toId,
    message_type: 'text',
    content: { text },
  }
  const businessType = params.businessType ?? 0
  if (businessType > 0) {
    body.business_type = businessType
    if (!params.conversationId?.trim()) {
      throw new Error('conversation_id obrigatório quando business_type ≠ 0')
    }
    body.conversation_id = params.conversationId.trim()
  }
  return shopApiPost('/api/v2/sellerchat/send_message', body)
}

export interface ShopeeConversationEntry {
  conversationId: string
  toId: number
  toName: string
}

/** Quantos chats varrer no vínculo (get_conversation_list). */
export const SHOPEE_CONVERSATION_SCAN_MAX = 200_000

export interface ConversationPageMetric {
  page: number
  chatsOnPage: number
  indexedOnPage: number
  scannedTotal: number
  newestOnPage: string | null
  oldestOnPage: string | null
  /** Cursor enviado nesta requisição (vazio na 1ª página). */
  inputTimestampNano: string | null
  /** Cursor para pedir a página seguinte — use em startTimestampNano para retomar. */
  nextTimestampNano: string | null
}

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
  if (!conversationId || !toName) return null
  return { conversationId, toId, toName }
}

/** Campos de username que a Shopee pode devolver num chat (para debug / vínculo). */
export function conversationUsernameFields(row: Record<string, unknown>): Record<string, string | null> {
  const toUserInfo =
    row.to_user_info && typeof row.to_user_info === 'object'
      ? (row.to_user_info as Record<string, unknown>)
      : undefined
  const pick = (v: unknown): string | null => {
    const s = String(v ?? '').trim()
    return s || null
  }
  return {
    to_name: pick(row.to_name),
    to_user_name: pick(row.to_user_name),
    username: pick(row.username),
    buyer_username: pick(row.buyer_username),
    to_user_info_name: pick(toUserInfo?.name),
    to_user_info_user_name: pick(toUserInfo?.user_name),
    parsed_for_link: parseConversationRow(row)?.toName ?? null,
  }
}

export function summarizeConversationPage(body: Record<string, unknown>): {
  count: number
  more: boolean | null
  nextTimestampNano: string | null
  rows: Array<{
    conversation_id: string | null
    to_id: number | null
    shop_id: number | null
    last_message_ts: string | null
    usernames: Record<string, string | null>
  }>
} {
  const list = conversationListFromBody(body)
  const pageResult =
    body.page_result && typeof body.page_result === 'object'
      ? (body.page_result as Record<string, unknown>)
      : undefined
  const moreRaw = pageResult?.more ?? body.more
  const more = moreRaw === true || moreRaw === 'true' || moreRaw === 1 ? true : moreRaw === false ? false : null
  return {
    count: list.length,
    more,
    nextTimestampNano: resolveNextConversationTimestamp(body, list) ?? null,
    rows: list.map((row) => ({
      conversation_id: String(row.conversation_id ?? '').trim() || null,
      to_id: Number(row.to_id ?? 0) || null,
      shop_id: Number(row.shop_id ?? 0) || null,
      last_message_ts: String(
        row.last_message_timestamp ?? row.latest_message_timestamp_nano ?? row.latest_message_timestamp ?? '',
      ).trim() || null,
      usernames: conversationUsernameFields(row),
    })),
  }
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

function parseMessageTimeNano(raw: unknown): bigint | undefined {
  if (raw == null || raw === '') return undefined
  try {
    const n = BigInt(String(raw))
    return n > 0n ? n : undefined
  } catch {
    return undefined
  }
}

function conversationMessageTimeNano(row: Record<string, unknown>): bigint | undefined {
  const raw =
    row.last_message_timestamp ??
    row.latest_message_timestamp ??
    row.last_message_timestamp_nano ??
    row.latest_message_timestamp_nano
  return parseMessageTimeNano(raw)
}

function pageMessageTimeRange(list: Array<Record<string, unknown>>): {
  newest: bigint | undefined
  oldest: bigint | undefined
} {
  let newest: bigint | undefined
  let oldest: bigint | undefined
  for (const row of list) {
    const ts = conversationMessageTimeNano(row)
    if (ts == null) continue
    if (newest == null || ts > newest) newest = ts
    if (oldest == null || ts < oldest) oldest = ts
  }
  return { newest, oldest }
}

function nanoBigIntToIso(nano: bigint): string {
  return new Date(Number(nano / 1_000_000n)).toISOString()
}

function resolveNextConversationTimestamp(
  body: Record<string, unknown>,
  list: Array<Record<string, unknown>>,
): string | undefined {
  const pageResult =
    body.page_result && typeof body.page_result === 'object'
      ? (body.page_result as Record<string, unknown>)
      : undefined
  const more = pageResult?.more ?? body.more
  if (more !== true && more !== 'true' && more !== 1) return undefined

  const rawNext = pageResult?.next_cursor ?? body.next_cursor
  if (typeof rawNext === 'object' && rawNext !== null) {
    const obj = rawNext as Record<string, unknown>
    const nano = parseMessageTimeNano(obj.next_message_time_nano ?? obj.next_timestamp_nano)
    if (nano != null) return nano.toString()
  }

  const flat = parseMessageTimeNano(pageResult?.next_timestamp_nano ?? body.next_timestamp_nano)
  if (flat != null) return flat.toString()

  if (typeof rawNext === 'string' || typeof rawNext === 'number') {
    const nano = parseMessageTimeNano(rawNext)
    if (nano != null) return nano.toString()
  }

  // fallback: último item da página (maior timestamp)
  const last = list[list.length - 1]
  const lastTs = last ? conversationMessageTimeNano(last) : undefined
  return lastTs?.toString()
}

/** Uma página de get_conversation_list (para varredura fragmentada). */
export async function fetchConversationPage(options: {
  nextTimestampNano?: string
  pageNumber: number
  scannedBefore: number
}): Promise<{
  pageMetric: ConversationPageMetric
  entries: ShopeeConversationEntry[]
  hasMore: boolean
  connectedShopId: number | null
}> {
  const auth = loadShopeeAuth()
  const inputTimestampNano = options.nextTimestampNano?.trim() || null
  const data = await getConversationList({
    direction: 'latest',
    type: 'all',
    pageSize: 50,
    nextTimestampNano: inputTimestampNano ?? undefined,
  })
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_conversation_list') as Record<
    string,
    unknown
  >
  const list = conversationListFromBody(body)
  const entries: ShopeeConversationEntry[] = []
  let indexedOnPage = 0
  let scanned = options.scannedBefore

  for (const row of list) {
    scanned++
    const entry = parseConversationRow(row)
    if (!entry) continue
    indexedOnPage++
    entries.push(entry)
  }

  const range = pageMessageTimeRange(list)
  const next = list.length > 0 ? resolveNextConversationTimestamp(body, list) ?? null : null
  const hasMore =
    list.length > 0 && next != null && next !== (inputTimestampNano ?? '')

  const pageMetric: ConversationPageMetric = {
    page: options.pageNumber,
    chatsOnPage: list.length,
    indexedOnPage,
    scannedTotal: scanned,
    newestOnPage: range.newest != null ? nanoBigIntToIso(range.newest) : null,
    oldestOnPage: range.oldest != null ? nanoBigIntToIso(range.oldest) : null,
    inputTimestampNano,
    nextTimestampNano: next,
  }

  return {
    pageMetric,
    entries,
    hasMore,
    connectedShopId: auth?.shopId ?? null,
  }
}

/** Pagina get_conversation_list — até maxConversations ou achar todos os to_name pedidos. */
export async function fetchConversationMap(
  options: {
    targetUsernames?: Set<string>
    maxConversations?: number
    /** Retomar varredura a partir deste next_timestamp_nano (copie do log de paginação). */
    startTimestampNano?: string
  } = {},
): Promise<{
  byUsername: Map<string, ShopeeConversationEntry>
  scanned: number
  indexed: number
  pages: number
  newestChatAt: string | null
  oldestScannedChatAt: string | null
  connectedShopId: number | null
  chatShopIds: number[]
  pageMetrics: ConversationPageMetric[]
  resumeCursor: string | null
}> {
  const auth = loadShopeeAuth()
  const chatShopIds = new Set<number>()
  const byUsername = new Map<string, ShopeeConversationEntry>()
  const pageMetrics: ConversationPageMetric[] = []
  const maxConversations = Math.min(
    Math.max(options.maxConversations ?? SHOPEE_CONVERSATION_SCAN_MAX, 50),
    SHOPEE_CONVERSATION_SCAN_MAX,
  )
  let nextTimestampNano: string | undefined = options.startTimestampNano?.trim() || undefined
  let scanned = 0
  let indexed = 0
  let pages = 0
  let prevTimestamp: string | undefined
  let newestTs: bigint | undefined
  let oldestTs: bigint | undefined
  let lastNextCursor: string | null = null

  const allFound = (): boolean => {
    if (!options.targetUsernames || options.targetUsernames.size === 0) return false
    for (const name of options.targetUsernames) {
      if (!byUsername.has(name)) return false
    }
    return true
  }

  while (scanned < maxConversations) {
    const inputTimestampNano = nextTimestampNano ?? null
    const pageSize = Math.min(50, maxConversations - scanned)
    const data = await getConversationList({
      direction: 'latest',
      type: 'all',
      pageSize,
      nextTimestampNano,
    })
    const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_conversation_list') as Record<
      string,
      unknown
    >
    const list = conversationListFromBody(body)
    pages++
    if (list.length === 0) {
      pageMetrics.push({
        page: pages,
        chatsOnPage: 0,
        indexedOnPage: 0,
        scannedTotal: scanned,
        newestOnPage: null,
        oldestOnPage: null,
        inputTimestampNano,
        nextTimestampNano: null,
      })
      break
    }

    let indexedOnPage = 0
    for (const row of list) {
      scanned++
      const shopId = Number(row.shop_id ?? 0)
      if (shopId > 0) chatShopIds.add(shopId)
      const entry = parseConversationRow(row)
      if (!entry) continue
      indexed++
      indexedOnPage++
      byUsername.set(entry.toName.toLowerCase(), entry)
      const ts = conversationMessageTimeNano(row)
      if (ts != null) {
        if (newestTs == null || ts > newestTs) newestTs = ts
        if (oldestTs == null || ts < oldestTs) oldestTs = ts
      }
    }

    const range = pageMessageTimeRange(list)
    const next = resolveNextConversationTimestamp(body, list) ?? null
    if (next) lastNextCursor = next
    pageMetrics.push({
      page: pages,
      chatsOnPage: list.length,
      indexedOnPage,
      scannedTotal: scanned,
      newestOnPage: range.newest != null ? nanoBigIntToIso(range.newest) : null,
      oldestOnPage: range.oldest != null ? nanoBigIntToIso(range.oldest) : null,
      inputTimestampNano,
      nextTimestampNano: next,
    })

    if (allFound() || scanned >= maxConversations) break

    if (next == null || next === prevTimestamp) break
    prevTimestamp = nextTimestampNano
    nextTimestampNano = next
  }

  const newestChatAt = newestTs != null ? nanoBigIntToIso(newestTs) : null
  const oldestScannedChatAt = oldestTs != null ? nanoBigIntToIso(oldestTs) : null

  return {
    byUsername,
    scanned,
    indexed,
    pages,
    newestChatAt,
    oldestScannedChatAt,
    connectedShopId: auth?.shopId ?? null,
    chatShopIds: [...chatShopIds],
    pageMetrics,
    resumeCursor: lastNextCursor,
  }
}

export interface ParsedChatMessage {
  id: string
  fromId: number
  toId: number
  type: string
  text: string
  imageUrl: string | null
  createdAt: number | null
  /** true = mensagem do comprador; false = loja/vendedor */
  fromBuyer: boolean
}

function messageListFromBody(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw =
    body.messages ??
    body.message_list ??
    (body.response && typeof body.response === 'object'
      ? (body.response as Record<string, unknown>).messages
      : undefined)
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
}

function messagePageNextOffset(body: Record<string, unknown>): string | null {
  const pageResult =
    body.page_result ??
    (body.response && typeof body.response === 'object'
      ? (body.response as Record<string, unknown>).page_result
      : undefined)
  if (!pageResult || typeof pageResult !== 'object') return null
  const next = (pageResult as Record<string, unknown>).next_offset
  if (next == null || next === '') return null
  return String(next)
}

function extractMessageImageUrl(msg: Record<string, unknown>, text: string): string | null {
  const content = msg.content
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>
    for (const key of ['url', 'image_url', 'thumb_url', 'imageUrl', 'thumbUrl']) {
      const raw = c[key]
      if (typeof raw === 'string' && /^https?:\/\//i.test(raw.trim())) return raw.trim()
    }
  }
  const type = String(msg.message_type ?? msg.type ?? '')
  if ((type === 'image' || type === 'sticker') && /^https?:\/\//i.test(text)) return text
  if (/^https?:\/\/img\.sp\.mms\.shopee/i.test(text)) return text
  return null
}

function extractMessageText(msg: Record<string, unknown>): string {
  const content = msg.content
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>
    if (typeof c.text === 'string' && c.text.trim()) return c.text.trim()
    if (typeof c.translation_text === 'string' && c.translation_text.trim()) return c.translation_text.trim()
    if (typeof c.url === 'string' && c.url.trim()) return c.url.trim()
  }
  const type = String(msg.message_type ?? msg.type ?? 'unknown')
  if (type === 'image' || type === 'sticker') return `[${type}]`
  if (type === 'text') return '(mensagem vazia)'
  return `[${type}]`
}

function parseMessageCreatedAt(msg: Record<string, unknown>): number | null {
  const raw =
    msg.created_timestamp ??
    msg.create_time ??
    msg.create_timestamp ??
    msg.message_timestamp ??
    msg.timestamp
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? n * 1000 : n
}

export function parseChatMessage(
  msg: Record<string, unknown>,
  buyerToId: number,
): ParsedChatMessage | null {
  const fromId = Number(msg.from_id ?? msg.sender_id ?? 0)
  const toId = Number(msg.to_id ?? 0)
  const id = String(msg.message_id ?? msg.id ?? '').trim()
  if (!id) return null
  const type = String(msg.message_type ?? msg.type ?? 'text')
  const text = extractMessageText(msg)
  return {
    id,
    fromId,
    toId,
    type,
    text,
    imageUrl: extractMessageImageUrl(msg, text),
    createdAt: parseMessageCreatedAt(msg),
    fromBuyer: fromId === buyerToId,
  }
}

/** Histórico completo — pagina get_message até acabar (ou maxPages). */
export async function fetchAllChatMessages(
  conversationId: string,
  buyerToId: number,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<{ messages: ParsedChatMessage[]; pages: number; truncated: boolean }> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 50)
  const maxPages = Math.min(Math.max(options.maxPages ?? 40, 1), 100)
  const byId = new Map<string, ParsedChatMessage>()
  let offset: string | undefined = ''
  let pages = 0

  while (pages < maxPages) {
    const data = await getMessageList({ conversationId, pageSize, offset })
    const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_message')
    const list = messageListFromBody(body)
    for (const row of list) {
      const parsed = parseChatMessage(row, buyerToId)
      if (parsed) byId.set(parsed.id, parsed)
    }
    pages++
    const next = messagePageNextOffset(body)
    if (!next || list.length === 0) break
    offset = next
  }

  const messages = [...byId.values()].sort((a, b) => {
    const ta = a.createdAt ?? 0
    const tb = b.createdAt ?? 0
    return ta - tb
  })
  return { messages, pages, truncated: pages >= maxPages }
}
