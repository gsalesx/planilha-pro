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
  manufacturing_ending_date?: string | null
  buyer?: { id?: number; nickname?: string; first_name?: string; last_name?: string }
  order_items?: Array<{
    item?: {
      id?: string
      title?: string
      seller_sku?: string
      seller_custom_field?: string | null
      variation_id?: number
      variation_attributes?: Array<{
        id?: string
        name?: string
        value_id?: string | null
        value_name?: string
      }>
    }
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

function mlHttps(url?: string | null): string | undefined {
  const u = String(url ?? '').trim()
  if (!u) return undefined
  return u.replace(/^http:\/\//i, 'https://')
}

/** Foto pública do anúncio (CDN). Pedido não traz imagem — precisa do GET /items. */
export async function fetchMlItemImageUrl(
  itemId: string,
  variationId?: number | null,
): Promise<string | undefined> {
  const item = await apiCall<{
    secure_thumbnail?: string
    thumbnail?: string
    pictures?: Array<{ id?: string; secure_url?: string; url?: string }>
    variations?: Array<{ id?: number; picture_ids?: string[] }>
  }>('GET', `/items/${encodeURIComponent(itemId)}`)

  if (variationId) {
    const variation = item.variations?.find((v) => v.id === variationId)
    const picId = variation?.picture_ids?.[0]
    if (picId) {
      const pic = item.pictures?.find((p) => p.id === picId)
      const fromVariation = mlHttps(pic?.secure_url || pic?.url)
      if (fromVariation) return fromVariation
    }
  }

  const first = item.pictures?.[0]
  return mlHttps(first?.secure_url || first?.url || item.secure_thumbnail || item.thumbnail)
}

export interface MlPack {
  id?: number
  status?: string
  orders?: Array<{ id?: number }>
  shipment?: { id?: number }
  buyer?: { id?: number }
}

/** Pack = número da venda no painel. Pode conter 1+ pedidos (order.id). */
export async function getPack(packId: number | string): Promise<MlPack> {
  return apiCall('GET', `/packs/${packId}`)
}

// ─── shipment ───────────────────────────────────────────────────────────────

export interface MlShipment {
  id?: number
  status?: string
  substatus?: string
  date_first_printed?: string | null
  receiver_address?: { receiver_name?: string; city?: { name?: string }; state?: { name?: string } }
  shipping_option?: {
    estimated_handling_limit?: { date?: string }
    estimated_schedule_limit?: { date?: string }
  }
  status_history?: { date_ready_to_ship?: string; date_shipped?: string; date_delivered?: string }
}

export async function getShipment(shippingId: number): Promise<MlShipment> {
  return apiCall('GET', `/shipments/${shippingId}`)
}

/** Prazo máximo de despacho (substitui estimated_handling_limit, deprecado em 2025-05). */
export interface MlShipmentSla {
  status?: string
  service?: string
  expected_date?: string
  last_updated?: string
}

export async function getShipmentSla(shippingId: number): Promise<MlShipmentSla> {
  return apiCall('GET', `/shipments/${shippingId}/sla`)
}

// ─── messages (packs) ───────────────────────────────────────────────────────

export interface MlAttachment {
  filename?: string
  original_filename?: string
  type?: string
}

export interface MlMessage {
  id?: string
  from?: { user_id?: number; email?: string }
  to?: { user_id?: number }
  /** API nova devolve string; formato antigo pode vir `{ plain }`. */
  text?: string | { plain?: string }
  message_date?: { created?: string }
  message_attachments?: MlAttachment[]
  /** Formato antigo: lista de ids de anexo. */
  attachments?: string[]
  status?: string
}

const IMAGE_ATT_RE = /image|picture|jpe?g|png|gif|webp|heic|bmp/i
const DOC_ATT_RE = /pdf|text\/plain|\.txt(\b|$)|application\/pdf/i

function isMlImageAttachment(att: { filename?: string; original_filename?: string; type?: string }): boolean {
  const blob = `${att.type ?? ''} ${att.filename ?? ''} ${att.original_filename ?? ''}`
  if (DOC_ATT_RE.test(blob)) return false
  if (IMAGE_ATT_RE.test(blob)) return true
  return Boolean(String(att.filename ?? '').trim())
}

function mlImageAttachmentIds(m: MlMessage): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  const add = (id: string) => {
    if (!id || seen.has(id)) return
    seen.add(id)
    ids.push(id)
  }
  for (const att of m.message_attachments ?? []) {
    const id = String(att.filename ?? '').trim()
    if (id && isMlImageAttachment(att)) add(id)
  }
  for (const raw of m.attachments ?? []) {
    const id = String(raw).trim()
    if (id && isMlImageAttachment({ filename: id })) add(id)
  }
  return ids
}

export function mlChatAttachmentUrl(attachmentId: string): string {
  return `/api/mercadolivre/attachments/${encodeURIComponent(attachmentId)}`
}

export async function fetchMlAttachment(
  attachmentId: string,
): Promise<{ body: Buffer; contentType: string }> {
  const auth = await ensureToken()
  const url = new URL(`/messages/attachments/${attachmentId}`, API_BASE)
  url.searchParams.set('tag', 'post_sale')
  url.searchParams.set('site_id', env.mlSiteId || 'MLB')
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: '*/*' },
  })
  if (!res.ok) {
    throw new Error(`ML attachment ${res.status}: ${await res.text()}`)
  }
  const contentType = res.headers.get('content-type') || 'image/jpeg'
  return { body: Buffer.from(await res.arrayBuffer()), contentType }
}

export interface MlMessagesResponse {
  paging?: { total?: number; offset?: number; limit?: number }
  /** Formato oficial: `messages`. `results` fica de fallback. */
  messages?: MlMessage[]
  results?: MlMessage[]
}

function mlMessageText(m: MlMessage): string {
  const t = m.text
  if (typeof t === 'string') return t
  if (t && typeof t === 'object' && typeof t.plain === 'string') return t.plain
  return ''
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
  // BR desde 2026-02: to.user_id é o agente MLB, não o comprador.
  return apiCall('POST', `/messages/packs/${packId}/sellers/${sellerId}`, {
    query: { tag: 'post_sale' },
    body: { from: { user_id: sellerId }, to: { user_id: 3037675074 }, text: body.text },
  })
}

// ─── fetch all messages (shape compatível com Shopee/TikTok) ────────────────

type MlChatMessage = {
  id: string
  fromId: number
  toId: number
  type: string
  text: string
  imageUrl: string | null
  createdAt: number | null
  fromBuyer: boolean
  quotedMessage: null
}

export async function fetchAllMlMessages(
  packId: string | number,
  sellerId: number,
): Promise<{
  messages: MlChatMessage[]
  pages: number
  truncated: boolean
}> {
  const resp = await getPackMessages(packId, sellerId)
  const raw: MlMessage[] = resp.messages ?? resp.results ?? []
  const messages = raw.flatMap((m): MlChatMessage[] => {
    const attachmentIds = mlImageAttachmentIds(m)
    const createdAt = m.message_date?.created ? new Date(m.message_date.created).getTime() : null
    const base = {
      fromId: m.from?.user_id ?? 0,
      toId: m.to?.user_id ?? 0,
      createdAt,
      fromBuyer: (m.from?.user_id ?? 0) !== sellerId,
      quotedMessage: null as null,
    }
    if (attachmentIds.length === 0) {
      return [
        {
          ...base,
          id: m.id ?? '',
          type: 'text',
          text: mlMessageText(m),
          imageUrl: null,
        },
      ]
    }
    return attachmentIds.map((attachmentId, i) => ({
      ...base,
      id: i === 0 ? (m.id ?? attachmentId) : `${m.id ?? 'att'}:${attachmentId}`,
      type: 'image',
      text: i === 0 ? mlMessageText(m) : '',
      imageUrl: mlChatAttachmentUrl(attachmentId),
    }))
  })
  messages.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  return { messages, pages: 1, truncated: false }
}
