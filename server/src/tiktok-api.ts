/**
 * TikTok Shop Partner API — OAuth, request signing, orders, chat.
 * API version 202309.
 */
import crypto from 'node:crypto'

import { env } from './env.js'
import { loadTikTokAuth, saveTikTokAuth, type TikTokAuthRecord } from './tiktok-store.js'

// ─── helpers ────────────────────────────────────────────────────────────────

export function tiktokConfigured(): boolean {
  return Boolean(env.tiktokAppKey && env.tiktokAppSecret)
}

function sign(path: string, params: Record<string, string>, body: string = ''): string {
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}${params[k]}`)
    .join('')
  const raw = `${env.tiktokAppSecret}${path}${sorted}${body}${env.tiktokAppSecret}`
  return crypto.createHmac('sha256', env.tiktokAppSecret).update(raw).digest('hex')
}

function timestamp(): string {
  return String(Math.floor(Date.now() / 1000))
}

// Auto-refresh 5 min antes da expiração
async function ensureToken(): Promise<TikTokAuthRecord> {
  const auth = loadTikTokAuth()
  if (!auth) throw new Error('TikTok não autenticado — faça OAuth primeiro')
  if (auth.accessExpireAt - Date.now() < 5 * 60 * 1000) {
    return refreshAccessToken(auth.refreshToken)
  }
  return auth
}

// ─── token exchange / refresh ───────────────────────────────────────────────

const TOKEN_BASE = 'https://auth.tiktok-shops.com'

async function tokenRequest(
  grantType: 'authorized_code' | 'refresh_token',
  extra: Record<string, string>,
): Promise<TikTokAuthRecord> {
  const url = new URL(
    grantType === 'refresh_token'
      ? '/api/v2/token/refresh'
      : '/api/v2/token/get',
    TOKEN_BASE,
  )
  const params: Record<string, string> = {
    app_key: env.tiktokAppKey,
    app_secret: env.tiktokAppSecret,
    grant_type: grantType,
    ...extra,
  }
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const res = await fetch(url.toString())
  if (!res.ok) throw new Error(`TikTok token ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as {
    code?: number
    message?: string
    data?: {
      access_token?: string
      refresh_token?: string
      access_token_expire_in?: number
      open_id?: string
    }
  }
  if (json.code !== 0 || !json.data?.access_token) {
    throw new Error(`TikTok token error: ${json.message ?? JSON.stringify(json)}`)
  }
  const d = json.data
  const record: TikTokAuthRecord = {
    accessToken: d.access_token!,
    refreshToken: d.refresh_token ?? extra.refresh_token ?? '',
    accessExpireAt: Date.now() + (d.access_token_expire_in ?? 0) * 1000,
    openId: d.open_id,
    shopCipher: env.tiktokShopCipher || undefined,
    updatedAt: Date.now(),
  }
  saveTikTokAuth(record)
  return record
}

export async function exchangeAuthCode(code: string): Promise<TikTokAuthRecord> {
  return tokenRequest('authorized_code', { auth_code: code })
}

export async function refreshAccessToken(refreshToken: string): Promise<TikTokAuthRecord> {
  return tokenRequest('refresh_token', { refresh_token: refreshToken })
}

// ─── OAuth URL ──────────────────────────────────────────────────────────────

export function buildTikTokAuthUrl(): string {
  const base = 'https://services.tiktokshop.com/open/authorize'
  const params = new URLSearchParams({
    service_id: env.tiktokAppKey,
  })
  if (env.tiktokRedirectUrl) params.set('state', 'planilha-pro')
  return `${base}?${params.toString()}`
}

// ─── signed API call ────────────────────────────────────────────────────────

interface TikTokApiResponse {
  code?: number
  message?: string
  data?: unknown
}

async function apiCall(
  method: 'GET' | 'POST',
  path: string,
  query: Record<string, string> = {},
  body?: unknown,
): Promise<TikTokApiResponse> {
  const auth = await ensureToken()
  const ts = timestamp()
  const params: Record<string, string> = {
    app_key: env.tiktokAppKey,
    timestamp: ts,
    ...query,
  }
  if (auth.shopCipher || env.tiktokShopCipher) {
    params.shop_cipher = auth.shopCipher || env.tiktokShopCipher
  }
  const bodyStr = body ? JSON.stringify(body) : ''
  params.sign = sign(path, params, bodyStr)
  params.access_token = auth.accessToken

  const url = new URL(path, env.tiktokApiBase)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v)

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-tts-access-token': auth.accessToken,
  }
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: method === 'POST' ? bodyStr || undefined : undefined,
  })
  if (!res.ok) {
    throw new Error(`TikTok API ${res.status}: ${await res.text()}`)
  }
  return (await res.json()) as TikTokApiResponse
}

function assertOk(resp: TikTokApiResponse, label: string): unknown {
  if (resp.code !== 0) {
    throw new Error(`TikTok ${label}: code=${resp.code} ${resp.message ?? ''}`)
  }
  return resp.data
}

// ─── shop ───────────────────────────────────────────────────────────────────

export async function getAuthorizedShop(): Promise<unknown> {
  const resp = await apiCall('GET', '/authorization/202309/shops')
  return assertOk(resp, 'getAuthorizedShop')
}

// ─── orders ─────────────────────────────────────────────────────────────────

export interface TikTokOrderListResult {
  orderIds: string[]
  nextPageToken: string
  totalCount: number
}

export async function listOrders(opts: {
  pageSize?: number
  pageToken?: string
  createTimeGe?: number
  createTimeLt?: number
  updateTimeGe?: number
  updateTimeLt?: number
}): Promise<TikTokOrderListResult> {
  const body: Record<string, unknown> = {
    page_size: opts.pageSize ?? 50,
  }
  if (opts.pageToken) body.page_token = opts.pageToken
  if (opts.createTimeGe || opts.createTimeLt) {
    body.create_time = {
      ...(opts.createTimeGe ? { create_time_ge: opts.createTimeGe } : {}),
      ...(opts.createTimeLt ? { create_time_lt: opts.createTimeLt } : {}),
    }
  }
  if (opts.updateTimeGe || opts.updateTimeLt) {
    body.update_time = {
      ...(opts.updateTimeGe ? { update_time_ge: opts.updateTimeGe } : {}),
      ...(opts.updateTimeLt ? { update_time_lt: opts.updateTimeLt } : {}),
    }
  }
  const resp = await apiCall('POST', '/order/202309/orders/search', {}, body)
  const data = assertOk(resp, 'listOrders') as {
    orders?: Array<{ id?: string }>
    next_page_token?: string
    total_count?: number
  }
  return {
    orderIds: (data.orders ?? []).map((o) => o.id ?? '').filter(Boolean),
    nextPageToken: data.next_page_token ?? '',
    totalCount: data.total_count ?? 0,
  }
}

export interface TikTokOrderDetail {
  id?: string
  status?: string
  buyer_message?: string
  create_time?: number
  update_time?: number
  delivery_option_required_delivery_by?: number
  shipping_due_time?: number
  payment?: { shipping_fee?: string }
  recipient_address?: { name?: string; phone_number?: string }
  line_items?: Array<{
    id?: string
    sku_name?: string
    seller_sku?: string
    product_name?: string
    quantity?: number
    sku_image?: { url?: string }
  }>
  buyer_uid?: string
  buyer_email?: string
}

export async function getOrderDetails(orderIds: string[]): Promise<TikTokOrderDetail[]> {
  const resp = await apiCall('POST', '/order/202309/orders', {}, {
    order_id_list: orderIds,
  })
  const data = assertOk(resp, 'getOrderDetails') as {
    orders?: TikTokOrderDetail[]
  }
  return data.orders ?? []
}

// ─── chat / customer service ────────────────────────────────────────────────

export interface TikTokConversation {
  conversation_id?: string
  participant_info?: {
    buyer_user_id?: string
    buyer_username?: string
  }
  latest_message_create_time?: number
}

export async function listConversations(opts: {
  pageSize?: number
  pageToken?: string
} = {}): Promise<{
  conversations: TikTokConversation[]
  nextPageToken: string
}> {
  const query: Record<string, string> = {
    page_size: String(opts.pageSize ?? 20),
  }
  if (opts.pageToken) query.page_token = opts.pageToken
  const resp = await apiCall('GET', '/customer_service/202309/conversations', query)
  const data = assertOk(resp, 'listConversations') as {
    conversations?: TikTokConversation[]
    next_page_token?: string
  }
  return {
    conversations: data.conversations ?? [],
    nextPageToken: data.next_page_token ?? '',
  }
}

export interface TikTokMessage {
  id?: string
  type?: string
  content?: {
    text?: string
    image_url?: string
  }
  sender_role?: string
  create_time?: number
}

export async function getConversationMessages(
  conversationId: string,
  opts: { pageSize?: number; pageToken?: string } = {},
): Promise<{ messages: TikTokMessage[]; nextPageToken: string }> {
  const query: Record<string, string> = {
    page_size: String(opts.pageSize ?? 50),
  }
  if (opts.pageToken) query.page_token = opts.pageToken
  const resp = await apiCall(
    'GET',
    `/customer_service/202309/conversations/${conversationId}/messages`,
    query,
  )
  const data = assertOk(resp, 'getConversationMessages') as {
    messages?: TikTokMessage[]
    next_page_token?: string
  }
  return {
    messages: data.messages ?? [],
    nextPageToken: data.next_page_token ?? '',
  }
}

export async function sendConversationMessage(
  conversationId: string,
  body: { type: 'text' | 'image'; content: { text?: string; image_url?: string } },
): Promise<unknown> {
  const resp = await apiCall(
    'POST',
    `/customer_service/202309/conversations/${conversationId}/messages`,
    {},
    body,
  )
  return assertOk(resp, 'sendConversationMessage')
}

/** Remove @resize/@crop do CDN TikTok pra pegar a original. */
export function tiktokCdnOriginalUrl(url: string): string {
  return url.replace(/@resize[^/]*/g, '').replace(/@crop[^/]*/g, '')
}

// ─── fetch all messages (like Shopee fetchAllChatMessages) ──────────────────

export async function fetchAllTikTokMessages(
  conversationId: string,
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
  const allMessages: TikTokMessage[] = []
  let pageToken = ''
  let pages = 0
  const MAX_PAGES = 20

  do {
    const page = await getConversationMessages(conversationId, {
      pageSize: 50,
      pageToken: pageToken || undefined,
    })
    pages++
    allMessages.push(...page.messages)
    pageToken = page.nextPageToken
  } while (pageToken && pages < MAX_PAGES)

  const messages = allMessages.map((m) => ({
    id: m.id ?? '',
    fromId: 0,
    toId: 0,
    type: m.content?.image_url ? 'image' : 'text',
    text: m.content?.text ?? '',
    imageUrl: m.content?.image_url ? tiktokCdnOriginalUrl(m.content.image_url) : null,
    createdAt: m.create_time ? m.create_time * 1000 : null,
    fromBuyer: m.sender_role === 'BUYER',
    quotedMessage: null,
  }))

  return { messages, pages, truncated: Boolean(pageToken) }
}
