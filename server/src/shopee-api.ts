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

function assertShopeeOk<T extends Record<string, unknown>>(data: ShopeeApiResponse<T>, context: string): T {
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
  })
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
  offset?: number
}

export async function getMessageList(params: MessageListParams): Promise<ShopeeApiResponse> {
  return shopApiGet('/api/v2/sellerchat/get_message', {
    conversation_id: params.conversationId,
    page_size: params.pageSize ?? 20,
    offset: params.offset ?? 0,
  })
}
