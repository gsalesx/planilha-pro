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

function assertShopeeOk<T>(data: ShopeeApiResponse<T>, context: string): T {
  if (data.error) {
    throw new Error(`${context}: ${data.error}${data.message ? ` — ${data.message}` : ''}`)
  }
  return data.response as T
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
  const data = await parseShopeeJson<{
    access_token: string
    refresh_token: string
    expire_in: number
    shop_id: number
  }>(response)
  const payload = assertShopeeOk(data, 'token/get')
  const now = Date.now()
  const record: ShopeeAuthRecord = {
    shopId: payload.shop_id ?? shopId,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessExpireAt: now + (payload.expire_in ?? 4 * 3600) * 1000,
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
  const data = await parseShopeeJson<{
    access_token: string
    refresh_token: string
    expire_in: number
    shop_id: number
  }>(response)
  const payload = assertShopeeOk(data, 'access_token/get')
  const now = Date.now()
  const updated: ShopeeAuthRecord = {
    shopId: payload.shop_id ?? record.shopId,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessExpireAt: now + (payload.expire_in ?? 4 * 3600) * 1000,
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

export interface OrderListParams {
  timeFrom: number
  timeTo: number
  orderStatus?: string
  pageSize?: number
  cursor?: string
  timeRangeField?: 'create_time' | 'update_time'
}

export async function getOrderList(params: OrderListParams): Promise<ShopeeApiResponse> {
  const auth = await ensureShopAuth()
  const path = '/api/v2/order/get_order_list'
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signShop(path, timestamp, auth.accessToken, auth.shopId)
  const query: Record<string, string | number> = {
    access_token: auth.accessToken,
    shop_id: auth.shopId,
    time_range_field: params.timeRangeField ?? 'create_time',
    time_from: params.timeFrom,
    time_to: params.timeTo,
    page_size: params.pageSize ?? 50,
    response_optional_fields: 'order_status',
  }
  if (params.orderStatus) query.order_status = params.orderStatus
  if (params.cursor) query.cursor = params.cursor
  const url = buildSignedUrl(path, sign, timestamp, query)
  const response = await fetch(url, { method: 'GET' })
  return parseShopeeJson(response)
}

export async function getShopInfo(): Promise<ShopeeApiResponse> {
  const auth = await ensureShopAuth()
  const path = '/api/v2/shop/get_shop_info'
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signShop(path, timestamp, auth.accessToken, auth.shopId)
  const url = buildSignedUrl(path, sign, timestamp, {
    access_token: auth.accessToken,
    shop_id: auth.shopId,
  })
  const response = await fetch(url, { method: 'GET' })
  return parseShopeeJson(response)
}
