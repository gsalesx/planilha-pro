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
  /** Foto do anúncio/produto (item_list.image_info.image_url da Shopee) — cacheada
   * no sync, só pra referência visual do operador. */
  productImageUrl?: string
  position: number
  updatedAt: number
  /** null = linha do pedido; preenchido = unidade seguinte, filha desta key. */
  parentKey?: string | null
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

/** Bulk: só status. Body `[{id, status}]` — atualiza todas as linhas com aquele id. */
export async function patchOrdersStatus(
  workbookId: string,
  updates: Array<{ id: string; status: string }>,
): Promise<{ ok: boolean; updatedAt: number }> {
  return request(`/workbooks/${encodeURIComponent(workbookId)}/orders`, {
    method: 'PATCH',
    body: JSON.stringify(updates),
  })
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

export interface ImportShopeeOrdersXlsxResult {
  ok: boolean
  aplicado: boolean
  workbookId: string
  totalPedidosNoXlsx: number
  pedidosNovos?: number
  idsNovos?: string[]
  pedidosJaExistentes?: number
  pedidosComMultiplosItens?: number
  pedidosComAlgumaUnidadeMultipla?: number
  statusNaoMapeados?: Record<string, number>
  created?: number
  updated?: number
  unchanged?: number
  errors?: string[]
  aviso?: string
}

/** Export bruto do Seller Center (Pedidos > Exportar) — dry-run por padrão; `aplicar` grava no banco. */
export async function importShopeeOrdersXlsx(
  file: File,
  options?: { workbookId?: string; aplicar?: boolean },
): Promise<ImportShopeeOrdersXlsxResult> {
  const body = new FormData()
  body.append('file', file)
  const params = new URLSearchParams()
  if (options?.workbookId) params.set('workbookId', options.workbookId)
  if (options?.aplicar) params.set('aplicar', '1')
  const qs = params.toString()
  const response = await fetch(
    `${API_BASE}/audit/importar-pedidos-xlsx${qs ? `?${qs}` : ''}`,
    { method: 'POST', credentials: 'include', body },
  )
  if (response.status === 401) throw new AuthRequiredError()
  const detail = await response.json().catch(() => ({ error: response.statusText }))
  if (!response.ok) {
    throw new Error(detail.error ?? `HTTP ${response.status}`)
  }
  return detail as ImportShopeeOrdersXlsxResult
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

export type ShopeeQuotedMessage = {
  id: string
  text: string
  imageUrl: string | null
  fromBuyer: boolean
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
  /** Preenchido quando é resposta a outra mensagem (anexo/citação no app da Shopee). */
  quotedMessage: ShopeeQuotedMessage | null
}

/** Prefixo de API por canal de marketplace (`/shopee`, `/tiktok`, `/mercadolivre`). */
export type MarketplaceChatChannel = 'shopee' | 'tiktok' | 'mercadolivre'

function marketplaceApiPrefix(channel: MarketplaceChatChannel): string {
  if (channel === 'tiktok') return '/tiktok'
  if (channel === 'mercadolivre') return '/mercadolivre'
  return '/shopee'
}

export type MarketplaceChatHistory = {
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
}

export async function fetchMarketplaceChatHistory(
  channel: MarketplaceChatChannel,
  username: string,
): Promise<MarketplaceChatHistory> {
  const qs = new URLSearchParams({ username })
  return request(`${marketplaceApiPrefix(channel)}/chat-history?${qs}`)
}

export async function sendMarketplaceChatMessage(
  channel: MarketplaceChatChannel,
  opts: { toId: number; conversationId: string; text: string },
): Promise<unknown> {
  return request(`${marketplaceApiPrefix(channel)}/messages/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
}

export async function sendMarketplacePreview(
  channel: MarketplaceChatChannel,
  opts: { username: string; workbookId: string; orderKey: string; col: number },
): Promise<{ ok: boolean; shopeeImageUrl?: string; imageUrl?: string }> {
  return request(`${marketplaceApiPrefix(channel)}/messages/send-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
}

export async function fetchMarketplaceLinkedBuyerUsernames(
  channel: MarketplaceChatChannel,
): Promise<string[]> {
  const data = await request<{ ok: boolean; usernames: string[] }>(
    `${marketplaceApiPrefix(channel)}/buyer-chats`,
  )
  return data.usernames ?? []
}

export async function startMarketplaceConversation(
  channel: MarketplaceChatChannel,
  opts: { orderKey: string; message?: string },
): Promise<{ ok: boolean; buyerUserId: number; buyerUsername: string; conversationId: string }> {
  return request(`${marketplaceApiPrefix(channel)}/messages/start-conversation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  })
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
  return fetchMarketplaceLinkedBuyerUsernames('shopee')
}

export async function fetchShopeeChatHistory(username: string): Promise<MarketplaceChatHistory> {
  return fetchMarketplaceChatHistory('shopee', username)
}

export async function sendShopeeChatMessage(opts: {
  toId: number
  conversationId: string
  text: string
}): Promise<unknown> {
  return sendMarketplaceChatMessage('shopee', opts)
}

export async function sendShopeePreview(opts: {
  username: string
  workbookId: string
  orderKey: string
  col: number
}): Promise<{ ok: boolean; shopeeImageUrl?: string }> {
  return sendMarketplacePreview('shopee', opts)
}

/** Manda uma mensagem inicial (ex. "Oi") pro comprador de um pedido sem chat vinculado
 * ainda — a Shopee cria a conversa na hora, sem precisar de contato prévio do comprador. */
export async function startShopeeConversation(opts: {
  orderKey: string
  message?: string
}): Promise<{ ok: boolean; buyerUserId: number; buyerUsername: string; conversationId: string }> {
  return startMarketplaceConversation('shopee', opts)
}

/** Baixa o PDF da etiqueta de envio do pedido (NORMAL_AIR_WAYBILL — o formato térmico da
 *  Shopee vem como .zip de ZPL, que o navegador não abre). */
export async function fetchShippingLabel(orderSn: string): Promise<Blob> {
  const response = await fetch(`${API_BASE}/shopee/shipping-label/${encodeURIComponent(orderSn)}`, {
    credentials: 'include',
  })
  if (response.status === 401) throw new AuthRequiredError()
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(detail.error ?? `HTTP ${response.status}`)
  }
  return response.blob()
}

/* ===========================================================
   Peças por pedido (Fase 2 migração SKU→peça — picker no chat)
   =========================================================== */

export type PecaTipo = 'CAMISOLA' | 'SHORT' | 'CONJ'
export type PecaGenero = 'MASCULINO' | 'FEMININO'
/** Infantis (2/4/6/8/10/12 ANOS) — sem molde/medida própria ainda (2026-07-31);
 *  usam o canvas de M FEMININO como placeholder (ver render-molde-client.ts). */
export type PecaTamanhoInfantil = '2 ANOS' | '4 ANOS' | '6 ANOS' | '8 ANOS' | '10 ANOS' | '12 ANOS'
export type PecaTamanho = 'P' | 'M' | 'G' | 'GG' | PecaTamanhoInfantil

export type PhotoCrop = 'rosto' | 'coracao' | 'face'

export interface OrderPiece {
  id: number
  seq: number
  /** Linha da planilha a que esta peça pertence — a prévia dela é gravada NESSA linha.
   *  Um pedido de 5 unidades tem 5 peças, cada uma na sua linha (pai + filhas). */
  orderKey?: string
  /** "Peça 2 de 5" — numeração contínua no pedido inteiro, não dentro da linha. */
  rotulo?: string
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
  /** Tipo de composição por foto (recorte/cápsula vs coração vs rosto) — null = sem foto. */
  crops: { 1: PhotoCrop | null; 2: PhotoCrop | null }
  /** URL do CDN Shopee pra foto escolhida mas ainda não confirmada/baixada (hotlink
   * direto pro preview) — null quando já foi confirmada ou quando não tem foto. */
  pendingUrls: { 1: string | null; 2: string | null }
  /** Slot já ajustado no picker web → timestamp da composta (cache-buster da
   *  miniatura, que passa a mostrar o resultado). null = ainda não ajustado. */
  compostas?: { 1: number | null; 2: number | null }
  /** updated_at da foto crua por slot — cache-buster de /photo/:slot (cacheada
   *  24h pelo navegador; sem isso, trocar a foto não atualiza a miniatura). */
  fotosUpdatedAt?: { 1: number | null; 2: number | null }
  /** updated_at da PEÇA (order_pieces) — muda ao trocar emoji1/emoji2/cor/etc.
   *  Cache-buster de GET /pieces/:id/emoji/:slot (cacheada 1h pelo navegador,
   *  URL fixa por peça/slot — sem isso, trocar o emoji na peça continua
   *  servindo o PNG antigo até o cache expirar). Nome snake_case: vem direto
   *  da coluna do banco (server serializa o objeto sem remapear chaves). */
  updated_at: number
}

export async function getOrderPieces(
  workbookId: string,
  orderKey: string,
): Promise<{ pieces: OrderPiece[]; autoFailed?: string }> {
  return request(`/workbooks/${encodeURIComponent(workbookId)}/pieces/${encodeURIComponent(orderKey)}`)
}

/** Baixa e salva de verdade todas as fotos pendentes das peças do pedido — chamar ANTES
 * de marcar o status "Pronto" (botão "Confirmar pedido"). */
export async function confirmPiecesForOrder(workbookId: string, orderKey: string): Promise<{ ok: boolean }> {
  return request(
    `/workbooks/${encodeURIComponent(workbookId)}/pieces/${encodeURIComponent(orderKey)}/confirm`,
    { method: 'POST' },
  )
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

/** Sobe uma foto de arquivo local (ex.: cliente mandou link do Drive, operador baixou
 * na mão e sobe aqui) — diferente de assignPiecePhoto (URL do chat), grava direto,
 * sem passar pelo estado "pendente". */
export async function uploadPiecePhoto(pieceId: number, slot: 1 | 2, file: File): Promise<{ ok: boolean }> {
  const body = new FormData()
  body.append('image', file, file.name)
  const response = await fetch(`${API_BASE}/pieces/${pieceId}/photo/${slot}/upload`, {
    method: 'POST',
    credentials: 'include',
    body,
  })
  if (response.status === 401) throw new AuthRequiredError()
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(detail.error ?? `HTTP ${response.status}`)
  }
  return (await response.json()) as { ok: boolean }
}

export async function removePiecePhoto(pieceId: number, slot: 1 | 2): Promise<{ ok: boolean }> {
  return request(`/pieces/${pieceId}/photo/${slot}`, { method: 'DELETE' })
}

/** Troca só o tipo de composição (recorte/cápsula vs coração vs rosto) de uma foto já escolhida. */
export async function setPiecePhotoCrop(
  pieceId: number,
  slot: 1 | 2,
  crop: PhotoCrop,
): Promise<{ ok: boolean; crop: PhotoCrop }> {
  return request(`/pieces/${pieceId}/photo/${slot}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ crop }),
  })
}

/** Copia fotos (slots 1/2) + emoji1/emoji2 de `sourceId` pra `pieceId` — não mexe em
 * tipo/gênero/tamanho/cor (cada peça mantém o seu). */
export async function copyPieceFrom(pieceId: number, sourceId: number): Promise<{ ok: boolean }> {
  return request(`/pieces/${pieceId}/copy-from/${sourceId}`, { method: 'POST' })
}

/* ===========================================================
   Artes avulsas (artes.html) — criação de arte independente de pedido.
   As peças em si reaproveitam toda a API de OrderPiece acima (patch/delete/foto/emoji).
   =========================================================== */

export interface ArtProject {
  id: string
  nome: string
  created_at: number
  updated_at: number
  pieces: number
}

export async function listArtProjects(): Promise<{ projects: ArtProject[] }> {
  return request('/artes/projects')
}

export async function createArtProject(nome?: string): Promise<{ project: ArtProject }> {
  return request('/artes/projects', {
    method: 'POST',
    body: JSON.stringify({ nome: nome ?? '' }),
  })
}

export async function renameArtProject(id: string, nome: string): Promise<{ ok: boolean }> {
  return request(`/artes/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ nome }),
  })
}

export async function deleteArtProject(id: string): Promise<{ ok: boolean }> {
  return request(`/artes/projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export async function getArtProjectPieces(id: string): Promise<{ pieces: OrderPiece[] }> {
  return request(`/artes/projects/${encodeURIComponent(id)}/pieces`)
}

export async function addArtProjectPiece(id: string): Promise<{ piece: OrderPiece }> {
  return request(`/artes/projects/${encodeURIComponent(id)}/pieces`, { method: 'POST' })
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
  const rowProductImages: string[] = []
  const images: Record<string, { url: string; fileName: string; updatedAt?: number }> = {}
  const cellStyles: Record<string, CellStyle> = {}
  const rowFlags: Record<number, { disappeared?: boolean; filha?: boolean }> = {}

  server.orders.forEach((order, idx) => {
    rows.push(order.row)
    rowKeys.push(order.key ?? order.id)
    rowDates.push(order.sheetDate ?? '')
    rowProductImages.push(order.productImageUrl ?? '')
    for (const [colKey, style] of Object.entries(order.styles ?? {})) {
      cellStyles[`${idx}:${colKey}`] = style
    }
    if (order.disappeared || order.parentKey) {
      rowFlags[idx] = {
        ...(order.disappeared ? { disappeared: true } : {}),
        ...(order.parentKey ? { filha: true } : {}),
      }
    }
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
        rowProductImages,
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
