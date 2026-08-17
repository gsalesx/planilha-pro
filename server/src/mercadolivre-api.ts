/**
 * Mercado Livre Open Platform — OAuth, orders, messages.
 * BR: auth em mercadolivre.com.br, API em api.mercadolibre.com (espanhol no domínio).
 */
import { env } from './env.js'
import {
  loadMercadoLivreAuth,
  saveMercadoLivreAuth,
  type MercadoLivreAuthRecord,
} from './mercadolivre-store.js'

const AUTH_BASE = 'https://auth.mercadolivre.com.br'
const API_BASE = 'https://api.mercadolibre.com'

export function mlConfigured(): boolean {
  return Boolean(env.mlAppId && env.mlClientSecret)
}

// Auto-refresh 5 min antes da expiração
async function ensureToken(): Promise<MercadoLivreAuthRecord> {
  const auth = loadMercadoLivreAuth()
  if (!auth) throw new Error('Mercado Livre não autenticado — faça OAuth primeiro')
  if (auth.accessExpireAt - Date.now() < 5 * 60 * 1000) {
    return refreshAccessToken(auth.refreshToken)
  }
  return auth
}

// ─── token exchange / refresh ───────────────────────────────────────────────

async function tokenRequest(
  grantType: 'authorization_code' | 'refresh_token',
  extra: Record<string, string>,
): Promise<MercadoLivreAuthRecord> {
  const body: Record<string, string> = {
    grant_type: grantType,
    client_id: env.mlAppId,
    client_secret: env.mlClientSecret,
    ...extra,
  }
  if (grantType === 'authorization_code') {
    body.redirect_uri = env.mlRedirectUrl
  }

  const res = await fetch(`${API_BASE}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  })
  if (!res.ok) throw new Error(`ML token ${res.status}: ${await res.text()}`)

  const json = (await res.json()) as {
    access_token?: string
    refresh_token?: string
    expires_in?: number
    user_id?: number
  }
  if (!json.access_token) throw new Error(`ML token error: ${JSON.stringify(json)}`)

  const record: MercadoLivreAuthRecord = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? extra.refresh_token ?? '',
    accessExpireAt: Date.now() + (json.expires_in ?? 21600) * 1000,
    userId: json.user_id ?? loadMercadoLivreAuth()?.userId ?? 0,
    updatedAt: Date.now(),
  }
  saveMercadoLivreAuth(record)
  return record
}

export async function exchangeAuthCode(code: string): Promise<MercadoLivreAuthRecord> {
  return tokenRequest('authorization_code', { code })
}

export async function refreshAccessToken(refreshToken: string): Promise<MercadoLivreAuthRecord> {
  return tokenRequest('refresh_token', { refresh_token: refreshToken })
}

// ─── OAuth URL ──────────────────────────────────────────────────────────────

export function buildMlAuthUrl(): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: env.mlAppId,
    redirect_uri: env.mlRedirectUrl,
  })
  return `${AUTH_BASE}/authorization?${params.toString()}`
}

// ─── generic API call ───────────────────────────────────────────────────────

async function apiCall<T = unknown>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  opts: { query?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const auth = await ensureToken()
  const url = new URL(path, API_BASE)
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v)
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    'Content-Type': 'application/json',
  }
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  })
  if (!res.ok) {
    throw new Error(`ML API ${method} ${path} ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as T
}

// ─── user ───────────────────────────────────────────────────────────────────

export async function getMe(): Promise<{ id: number; nickname: string; site_id: string }> {
  return apiCall('GET', '/users/me')
}

// ─── orders ─────────────────────────────────────────────────────────────────

export interface MlOrderSearchResult {
  results: MlOrder[]
  paging: { total: number; offset: number; limit: number }
}

export interface MlOrder {
  id?: number
  status?: string
  date_created?: string
  date_closed?: string
  buyer?: { id?: number; nickname?: string; first_name?: string; last_name?: string }
  order_items?: Array<{
    item?: { id?: string; title?: string; seller_sku?: string; variation_id?: number }
    quantity?: number
    unit_price?: number
  }>
  shipping?: { id?: number }
  pack_id?: number | null
  tags?: string[]
}

export async function searchOrders(opts: {
  seller: number
  orderStatus?: string
  offset?: number
  limit?: number
}): Promise<MlOrderSearchResult> {
  const query: Record<string, string> = {
    seller: String(opts.seller),
    sort: 'date_desc',
    limit: String(opts.limit ?? 50),
    offset: String(opts.offset ?? 0),
  }
  if (opts.orderStatus) query['order.status'] = opts.orderStatus
  return apiCall('GET', '/orders/search', { query })
}

export async function getOrder(orderId: number): Promise<MlOrder> {
  return apiCall('GET', `/orders/${orderId}`)
}

// ─── shipment ───────────────────────────────────────────────────────────────

export interface MlShipment {
  id?: number
  status?: string
  substatus?: string
  date_first_printed?: string | null
  receiver_address?: { receiver_name?: string; city?: { name?: string }; state?: { name?: string } }
  shipping_option?: { estimated_handling_limit?: { date?: string } }
  status_history?: { date_ready_to_ship?: string; date_shipped?: string; date_delivered?: string }
}

export async function getShipment(shippingId: number): Promise<MlShipment> {
  return apiCall('GET', `/shipments/${shippingId}`)
}

// ─── messages (packs) ───────────────────────────────────────────────────────

export interface MlMessage {
  id?: string
  from?: { user_id?: number; email?: string }
  to?: { user_id?: number }
  text?: string
  message_date?: { created?: string }
  message_attachments?: Array<{ filename?: string; original_filename?: string; type?: string }>
  status?: string
}

export interface MlMessagesResponse {
  paging?: { total?: number; offset?: number; limit?: number }
  results?: MlMessage[]
}

export async function getPackMessages(
  packId: string | number,
  sellerId: number,
): Promise<MlMessagesResponse> {
  return apiCall('GET', `/messages/packs/${packId}/sellers/${sellerId}`, {
    query: { tag: 'post_sale' },
  })
}

export async function sendPackMessage(
  packId: string | number,
  sellerId: number,
  body: { text?: string },
): Promise<unknown> {
  return apiCall('POST', `/messages/packs/${packId}/sellers/${sellerId}`, {
    query: { tag: 'post_sale' },
    body: { from: { user_id: sellerId }, to: {}, text: body.text },
  })
}

// ─── fetch all messages (shape compatível com Shopee/TikTok) ────────────────

export async function fetchAllMlMessages(
  packId: string | number,
  sellerId: number,
): Promise<{
  messages: Array<{
    id: string
    fromId: number
    toId: number
    type: string
    text: string
    imageUrl: string | null
    createdAt: number | null
    fromBuyer: boolean
    quotedMessage: null
  }>
  pages: number
  truncated: boolean
}> {
  const resp = await getPackMessages(packId, sellerId)
  const raw = resp.results ?? []
  const messages = raw.map((m) => ({
    id: m.id ?? '',
    fromId: m.from?.user_id ?? 0,
    toId: m.to?.user_id ?? 0,
    type: 'text' as const,
    text: m.text ?? '',
    imageUrl: null,
    createdAt: m.message_date?.created ? new Date(m.message_date.created).getTime() : null,
    fromBuyer: (m.from?.user_id ?? 0) !== sellerId,
    quotedMessage: null,
  }))
  return { messages, pages: 1, truncated: false }
}
