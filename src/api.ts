import type { CellStyle, CellValue, WorkbookData } from './types'
import { headersForWorkbook } from './shopee-workbook'

const API_BASE = '/api'

export interface WorkbookSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  count: number
  columnWidths: Record<string, number>
  /** Planilha fixa do sistema (ex.: sync Shopee) — não pode ser excluída. */
  system?: boolean
}

export interface ServerOrder {
  key: string
  id: string
  row: CellValue[]
  styles: Record<string, CellStyle>
  disappeared: boolean
  sheetDate?: string
  position: number
  updatedAt: number
  images: Array<{ col: number; url: string; fileName: string; mime: string; size?: number; updatedAt?: number }>
}

export interface ServerWorkbook {
  unchanged: false
  updatedAt: number
  name: string
  columnWidths: Record<string, number>
  orders: ServerOrder[]
}

export interface ServerUnchanged {
  unchanged: true
  updatedAt: number
}

export type ServerWorkbookResponse = ServerWorkbook | ServerUnchanged

export class AuthRequiredError extends Error {
  constructor() {
    super('Login necessário')
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (response.status === 401) throw new AuthRequiredError()
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(detail.error ?? `HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

export async function checkAuth(): Promise<boolean> {
  try {
    await request('/me')
    return true
  } catch (error) {
    if (error instanceof AuthRequiredError) return false
    throw error
  }
}

export async function login(username: string, password: string): Promise<void> {
  await request('/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export async function logout(): Promise<void> {
  await request('/logout', { method: 'POST' })
}

/* ===========================================================
   Workbook CRUD
   =========================================================== */

export async function listWorkbooks(): Promise<WorkbookSummary[]> {
  return request<WorkbookSummary[]>('/workbooks')
}

export async function createWorkbook(name: string): Promise<WorkbookSummary> {
  return request<WorkbookSummary>('/workbooks', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function renameWorkbook(id: string, name: string): Promise<{ ok: true; updatedAt: number }> {
  return request(`/workbooks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

export async function deleteWorkbook(id: string): Promise<{ ok: true }> {
  return request(`/workbooks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export async function duplicateWorkbook(id: string, name?: string): Promise<WorkbookSummary> {
  return request<WorkbookSummary>(`/workbooks/${encodeURIComponent(id)}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

/* ===========================================================
   Workbook data (orders/images) — scoped por workbookId
   =========================================================== */

export async function fetchWorkbook(
  workbookId: string,
  since?: number,
): Promise<ServerWorkbookResponse> {
  const query = since != null ? `?since=${since}` : ''
  return request<ServerWorkbookResponse>(
    `/workbooks/${encodeURIComponent(workbookId)}/data${query}`,
  )
}

export async function replaceWorkbook(
  workbookId: string,
  payload: {
    orders: Array<{
      key?: string
      id: string
      row: CellValue[]
      styles?: Record<string, CellStyle>
      disappeared?: boolean
      sheetDate?: string
    }>
    columnWidths?: Record<number, number>
  },
): Promise<{ updatedAt: number; count: number }> {
  return request(`/workbooks/${encodeURIComponent(workbookId)}/replace`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function patchOrder(
  workbookId: string,
  orderId: string,
  patch: { row?: CellValue[]; styles?: Record<string, CellStyle>; disappeared?: boolean },
): Promise<{ updatedAt: number }> {
  return request(
    `/workbooks/${encodeURIComponent(workbookId)}/orders/${encodeURIComponent(orderId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    },
  )
}

export interface OrderCellDelta {
  col: number
  value: CellValue
}

export interface OrderStyleDelta {
  col: number
  bg?: string
  comment?: string
  clearBg?: boolean
  clearComment?: boolean
}

export async function patchOrderDelta(
  workbookId: string,
  orderId: string,
  patch: {
    cells?: OrderCellDelta[]
    stylePatches?: OrderStyleDelta[]
    disappeared?: boolean
  },
): Promise<{ updatedAt: number }> {
  return request(
    `/workbooks/${encodeURIComponent(workbookId)}/orders/${encodeURIComponent(orderId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    },
  )
}

export async function uploadImage(
  workbookId: string,
  orderId: string,
  col: number,
  blob: Blob,
  fileName: string,
): Promise<{ url: string; updatedAt: number }> {
  const body = new FormData()
  body.append('image', blob, fileName)
  const response = await fetch(
    `${API_BASE}/workbooks/${encodeURIComponent(workbookId)}/images/${encodeURIComponent(orderId)}/${col}`,
    {
      method: 'POST',
      credentials: 'include',
      body,
    },
  )
  if (response.status === 401) throw new AuthRequiredError()
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(detail.error ?? `HTTP ${response.status}`)
  }
  return (await response.json()) as { url: string; updatedAt: number }
}

export async function deleteImage(
  workbookId: string,
  orderId: string,
  col: number,
): Promise<{ updatedAt: number }> {
  return request(
    `/workbooks/${encodeURIComponent(workbookId)}/images/${encodeURIComponent(orderId)}/${col}`,
    { method: 'DELETE' },
  )
}

export async function deleteOrdersBySheetDate(
  workbookId: string,
  sheetDate: string,
): Promise<{ ok: true; deleted: number; sheetDate: string; updatedAt: number }> {
  return request(
    `/workbooks/${encodeURIComponent(workbookId)}/orders?sheetDate=${encodeURIComponent(sheetDate)}`,
    { method: 'DELETE' },
  )
}

export async function syncShopeeWorkbook(
  days = 90,
  offsetDays = 0,
): Promise<{
  ok: boolean
  days: number
  offsetDays: number
  listed: number
  created: number
  updated: number
  errors: string[]
}> {
  return request('/shopee/sync-workbook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ days, offsetDays }),
  })
}

/** Sincronização manual — mesma rotina do poll de 8h, sob demanda. */
export async function syncShopeeNow(): Promise<{
  ok: boolean
  listed: number
  created: number
  updated: number
  errors: string[]
  pendingRechecked: number
  readyToShipRechecked: number
}> {
  return request('/shopee/sync-now', { method: 'POST' })
}

/** Importação inicial parcelada — 1 request por dia para evitar timeout. */
export async function syncShopeeWorkbookInitial(
  totalDays = 5,
  onProgress?: (done: number, total: number, parcel: { listed: number; created: number; updated: number }) => void,
): Promise<{ listed: number; created: number; updated: number; errors: string[] }> {
  const acc = { listed: 0, created: 0, updated: 0, errors: [] as string[] }
  for (let d = 0; d < totalDays; d++) {
    const r = await syncShopeeWorkbook(1, d)
    acc.listed += r.listed
    acc.created += r.created
    acc.updated += r.updated
    acc.errors.push(...r.errors)
    onProgress?.(d + 1, totalDays, r)
  }
  return acc
}

export async function linkShopeeConversations(
  workbookId: string,
  options: { maxConversations?: number; startTimestampNano?: string } = {},
): Promise<{
  ok: boolean
  workbookId: string
  ordersQueried: number
  buyersFound: number
  linked: number
  notFound: number
  conversationsScanned: number
  conversationsIndexed: number
  conversationPages: number
  newestChatAt: string | null
  oldestScannedChatAt: string | null
  connectedShopId: number | null
  chatShopIds: number[]
  pageMetrics: Array<{
    page: number
    chatsOnPage: number
    indexedOnPage: number
    scannedTotal: number
    newestOnPage: string | null
    oldestOnPage: string | null
    inputTimestampNano: string | null
    nextTimestampNano: string | null
  }>
  resumeCursor: string | null
  errors: string[]
}> {
  return request('/shopee/link-conversations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workbookId, ...options }),
  })
}

export type LinkConversationsChunkResponse = {
  ok: boolean
  workbookId: string
  ordersQueried: number
  buyersFound: number
  linked: number
  linkedThisChunk: number
  notFound: number
  conversationsScanned: number
  conversationsIndexed: number
  conversationPages: number
  pageMetric: {
    page: number
    chatsOnPage: number
    indexedOnPage: number
    scannedTotal: number
    newestOnPage: string | null
    oldestOnPage: string | null
    inputTimestampNano: string | null
    nextTimestampNano: string | null
  } | null
  nextTimestampNano: string | null
  hasMore: boolean
  done: boolean
  doneReason: 'all_found' | 'no_more' | 'empty_page' | null
  connectedShopId: number | null
  errors: string[]
}

export async function linkShopeeConversationsScanChunk(
  workbookId: string,
  state: {
    nextTimestampNano?: string
    pageNumber: number
    scannedBefore: number
    indexedBefore: number
  },
): Promise<LinkConversationsChunkResponse> {
  return request('/shopee/link-conversations/scan-chunk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workbookId, ...state }),
  })
}

export async function fetchShopeeLinkBootstrap(): Promise<{
  ok: boolean
  configured?: boolean
  startPage: number
  pageNumber: number
  nextTimestampNano: string
  scannedBefore: number
  cursorSource?: string
  error?: string
}> {
  return request('/shopee/link-conversations/bootstrap')
}

export async function saveShopeeLinkStartCursor(nextTimestampNano: string): Promise<{
  ok: boolean
  nextTimestampNano: string
  startPage: number
  pageNumber: number
  scannedBefore: number
}> {
  return request('/shopee/link-conversations/start-cursor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nextTimestampNano }),
  })
}

export type ShopeeChatMessage = {
  id: string
  fromId: number
  toId: number
  type: string
  text: string
  imageUrl: string | null
  createdAt: number | null
  fromBuyer: boolean
}

export async function fetchShopeeLinkStatus(workbookId: string): Promise<{
  ok: boolean
  workbookId: string
  ordersQueried: number
  buyersFound: number
  linked: number
  allLinked: boolean
}> {
  const qs = new URLSearchParams({ workbookId })
  return request(`/shopee/link-conversations/status?${qs}`)
}

export async function clearShopeeBuyerChats(workbookId: string): Promise<{ ok: boolean; cleared: number }> {
  return request('/shopee/buyer-chats/clear', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ workbookId }),
  })
}

export async function fetchLinkedBuyerUsernames(): Promise<string[]> {
  const data = await request<{ ok: boolean; usernames: string[] }>('/shopee/buyer-chats')
  return data.usernames ?? []
}

export async function fetchShopeeChatHistory(username: string): Promise<{
  ok: boolean
  chat: {
    buyerUsername: string
    conversationId: string
    toId: number
    updatedAt: number
  }
  messages: ShopeeChatMessage[]
  pages: number
  truncated: boolean
}> {
  const qs = new URLSearchParams({ username })
  return request(`/shopee/chat-history?${qs}`)
}

export async function sendShopeeChatMessage(opts: {
  toId: number
  conversationId: string
  text: string
}): Promise<unknown> {
  return request('/shopee/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
}

export async function sendShopeePreview(opts: {
  username: string
  workbookId: string
  orderKey: string
  col: number
}): Promise<{ ok: boolean; shopeeImageUrl?: string }> {
  return request('/shopee/messages/send-preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
}

/* ===========================================================
   Peças por pedido (Fase 2 migração SKU→peça — picker no chat)
   =========================================================== */

export type PecaTipo = 'CAMISOLA' | 'SHORT' | 'CONJ'
export type PecaGenero = 'MASCULINO' | 'FEMININO'
export type PecaTamanho = 'P' | 'M' | 'G' | 'GG'

export interface OrderPiece {
  id: number
  seq: number
  tipo: PecaTipo
  genero: PecaGenero | null
  tamanho: PecaTamanho
  molde: string
  emoji1: string
  emoji2: string
  cor: string
  nota: string
  source: 'auto' | 'manual'
  photos: { 1: boolean; 2: boolean }
}

export async function getOrderPieces(
  workbookId: string,
  orderKey: string,
): Promise<{ pieces: OrderPiece[]; autoFailed?: string }> {
  return request(`/workbooks/${encodeURIComponent(workbookId)}/pieces/${encodeURIComponent(orderKey)}`)
}

export async function addOrderPiece(workbookId: string, orderKey: string): Promise<{ piece: OrderPiece }> {
  return request(`/workbooks/${encodeURIComponent(workbookId)}/pieces/${encodeURIComponent(orderKey)}`, {
    method: 'POST',
  })
}

export async function updateOrderPiece(
  pieceId: number,
  patch: Partial<{
    tipo: PecaTipo
    genero: PecaGenero | null
    tamanho: PecaTamanho
    emoji1: string
    emoji2: string
    cor: string
    nota: string
  }>,
): Promise<{ piece: OrderPiece }> {
  return request(`/pieces/${pieceId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}

export async function deleteOrderPiece(pieceId: number): Promise<{ ok: boolean }> {
  return request(`/pieces/${pieceId}`, { method: 'DELETE' })
}

export async function assignPiecePhoto(
  pieceId: number,
  slot: 1 | 2,
  url: string,
): Promise<{ url: string; updatedAt: number }> {
  return request(`/pieces/${pieceId}/photo/${slot}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  })
}

export async function removePiecePhoto(pieceId: number, slot: 1 | 2): Promise<{ ok: boolean }> {
  return request(`/pieces/${pieceId}/photo/${slot}`, { method: 'DELETE' })
}

/** Copia fotos (slots 1/2) + emoji1/emoji2 de `sourceId` pra `pieceId` — não mexe em
 * tipo/gênero/tamanho/cor (cada peça mantém o seu). */
export async function copyPieceFrom(pieceId: number, sourceId: number): Promise<{ ok: boolean }> {
  return request(`/pieces/${pieceId}/copy-from/${sourceId}`, { method: 'POST' })
}

/* ===========================================================
   Catálogo de emojis (picker de peças — Emoji 1/2)
   =========================================================== */

export interface EmojiCatalogItem {
  id: number
  name: string
  aliases: string[]
  imageUrl: string
  source: 'builtin' | 'custom'
}

export async function getEmojiCatalog(query?: string): Promise<{ items: EmojiCatalogItem[] }> {
  const qs = query && query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''
  return request(`/emoji-catalog${qs}`)
}

export async function createCustomEmoji(
  file: File | Blob,
  name: string,
  aliases?: string[],
): Promise<{ item: EmojiCatalogItem }> {
  const body = new FormData()
  body.append('image', file, name)
  body.append('name', name)
  if (aliases && aliases.length) body.append('aliases', JSON.stringify(aliases))
  const response = await fetch(`${API_BASE}/emoji-catalog`, {
    method: 'POST',
    credentials: 'include',
    body,
  })
  if (response.status === 401) throw new AuthRequiredError()
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(detail.error ?? `HTTP ${response.status}`)
  }
  return (await response.json()) as { item: EmojiCatalogItem }
}

export async function updateEmojiAliases(id: number, aliases: string[]): Promise<{ item: EmojiCatalogItem }> {
  return request(`/emoji-catalog/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ aliases }),
  })
}

export async function deleteCustomEmoji(id: number): Promise<{ ok: boolean }> {
  return request(`/emoji-catalog/${id}`, { method: 'DELETE' })
}

/** Converte payload do servidor pra WorkbookData (formato que a grid usa) */
export function serverWorkbookToLocal(workbookId: string, server: ServerWorkbook): WorkbookData {
  const rows: CellValue[][] = []
  const rowKeys: string[] = []
  const rowDates: string[] = []
  const images: Record<string, { url: string; fileName: string; updatedAt?: number }> = {}
  const cellStyles: Record<string, CellStyle> = {}
  const rowFlags: Record<number, { disappeared?: boolean }> = {}

  server.orders.forEach((order, idx) => {
    rows.push(order.row)
    rowKeys.push(order.key ?? order.id)
    rowDates.push(order.sheetDate ?? '')
    for (const [colKey, style] of Object.entries(order.styles ?? {})) {
      cellStyles[`${idx}:${colKey}`] = style
    }
    if (order.disappeared) rowFlags[idx] = { disappeared: true }
    for (const img of order.images) {
      images[`${idx}:${img.col}`] = { url: img.url, fileName: img.fileName, updatedAt: img.updatedAt }
    }
  })

  const columnWidths: Record<number, number> = {}
  for (const [colKey, width] of Object.entries(server.columnWidths ?? {})) {
    columnWidths[Number(colKey)] = width
  }

  const sheetId = `sheet-${workbookId}`
  return {
    id: workbookId,
    name: server.name,
    importedAt: new Date(server.updatedAt).toISOString(),
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: server.name,
        headers: headersForWorkbook(workbookId, FIXED_HEADERS),
        rows,
        rowKeys,
        rowDates,
        images,
        cellStyles,
        rowFlags,
        columnWidths,
      },
    },
  }
}

const FIXED_HEADERS = [
  'ID do pedido',
  'Nome do Produto',
  'Modelo',
  'Qnt.',
  'Nome de usuário',
  'Status',
  'Nome do destinatário',
  ...Array.from({ length: 10 }, (_, i) => `Foto ${i + 1}`),
]
