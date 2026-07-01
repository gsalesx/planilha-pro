import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { db, nowMs } from './db.js'
import { env } from './env.js'
import {
  fetchConversationMap,
  fetchConversationPage,
  SHOPEE_CONVERSATION_SCAN_MAX,
  type ConversationPageMetric,
} from './shopee-api.js'

export interface ShopeeBuyerChatRow {
  /** to_id do chat Shopee — usado no send_message, não é buyer_user_id do pedido. */
  toId: number
  buyerUsername: string
  conversationId: string
  updatedAt: number
}

export interface LinkConversationsResult {
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
  pageMetrics: ConversationPageMetric[]
  resumeCursor: string | null
  errors: string[]
}

export interface LinkConversationsChunkResult {
  ordersQueried: number
  buyersFound: number
  linked: number
  linkedThisChunk: number
  notFound: number
  conversationsScanned: number
  conversationsIndexed: number
  conversationPages: number
  pageMetric: ConversationPageMetric | null
  nextTimestampNano: string | null
  hasMore: boolean
  done: boolean
  doneReason: 'all_found' | 'no_more' | 'empty_page' | null
  connectedShopId: number | null
  errors: string[]
}

/** Col E — Nome de usuário (já vem no export Shopee / planilha manual). */
const COL_USERNAME = 4

/** Vínculo sempre começa nesta página (via cursor da página anterior). */
export const SHOPEE_LINK_START_PAGE = 285

export const SHOPEE_LINK_CONVERSATION_PAGE_SIZE = 50

function linkStartCursorPath(): string {
  mkdirSync(env.dataDir, { recursive: true })
  return path.join(env.dataDir, 'shopee-link-start-cursor.json')
}

/** Cursor gravado (env ou /data) — input da 1ª request = página 285. */
export function loadLinkStartCursor(): string | null {
  const fromEnv = env.shopeeLinkStartTimestampNano
  if (fromEnv) return fromEnv
  const file = linkStartCursorPath()
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as { nextTimestampNano?: string }
    const cursor = data.nextTimestampNano?.trim()
    return cursor || null
  } catch {
    return null
  }
}

export function saveLinkStartCursor(nextTimestampNano: string): void {
  const cursor = nextTimestampNano.trim()
  if (!cursor) throw new Error('nextTimestampNano obrigatório')
  writeFileSync(
    linkStartCursorPath(),
    JSON.stringify(
      { nextTimestampNano: cursor, startPage: SHOPEE_LINK_START_PAGE, updatedAt: nowMs() },
      null,
      2,
    ),
    'utf8',
  )
}

/** Estado inicial da varredura — pula páginas 1..284 sem request. */
export function getLinkScanBootstrap(): {
  startPage: number
  pageNumber: number
  nextTimestampNano: string
  scannedBefore: number
} {
  const cursor = loadLinkStartCursor()
  if (!cursor) {
    throw new Error(
      `Cursor da página ${SHOPEE_LINK_START_PAGE} não configurado. No Shopee Test, avance até a página ${SHOPEE_LINK_START_PAGE - 1}, copie o próximo next_timestamp_nano e use "Definir início do vínculo (pág ${SHOPEE_LINK_START_PAGE})" — ou defina SHOPEE_LINK_START_TIMESTAMP_NANO no servidor.`,
    )
  }
  const skippedPages = SHOPEE_LINK_START_PAGE - 1
  return {
    startPage: SHOPEE_LINK_START_PAGE,
    pageNumber: skippedPages,
    nextTimestampNano: cursor,
    scannedBefore: skippedPages * SHOPEE_LINK_CONVERSATION_PAGE_SIZE,
  }
}

interface SheetBuyer {
  username: string
}

function uniqueBuyersFromSheet(workbookId: string): SheetBuyer[] {
  const rows = db
    .prepare('SELECT row_json FROM orders WHERE workbook_id = ? AND TRIM(id) != ?')
    .all(workbookId, '') as Array<{ row_json: string }>

  const byUsername = new Map<string, SheetBuyer>()
  for (const row of rows) {
    let cells: unknown[]
    try {
      cells = JSON.parse(row.row_json) as unknown[]
    } catch {
      continue
    }
    const username = String(cells[COL_USERNAME] ?? '').trim()
    if (!username) continue
    const key = username.toLowerCase()
    if (!byUsername.has(key)) {
      byUsername.set(key, { username })
    }
  }
  return [...byUsername.values()]
}

function upsertBuyerChat(row: ShopeeBuyerChatRow): void {
  db.prepare('DELETE FROM shopee_buyer_chats WHERE buyer_username = ? COLLATE NOCASE').run(row.buyerUsername)
  db.prepare(
    `INSERT INTO shopee_buyer_chats (buyer_user_id, buyer_username, conversation_id, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(row.toId, row.buyerUsername, row.conversationId, row.updatedAt)
}

/** Lookup por to_id gravado na vinculação (coluna legada buyer_user_id). */
export function getBuyerChatByToId(toId: number): ShopeeBuyerChatRow | undefined {
  if (toId <= 0) return undefined
  const row = db
    .prepare(
      'SELECT buyer_user_id, buyer_username, conversation_id, updated_at FROM shopee_buyer_chats WHERE buyer_user_id = ?',
    )
    .get(toId) as
    | { buyer_user_id: number; buyer_username: string; conversation_id: string; updated_at: number }
    | undefined
  if (!row) return undefined
  return {
    toId: row.buyer_user_id,
    buyerUsername: row.buyer_username,
    conversationId: row.conversation_id,
    updatedAt: row.updated_at,
  }
}

export function getBuyerChatByUsername(username: string): ShopeeBuyerChatRow | undefined {
  const name = username.trim()
  if (!name) return undefined
  const row = db
    .prepare(
      'SELECT buyer_user_id, buyer_username, conversation_id, updated_at FROM shopee_buyer_chats WHERE buyer_username = ? COLLATE NOCASE LIMIT 1',
    )
    .get(name) as
    | { buyer_user_id: number; buyer_username: string; conversation_id: string; updated_at: number }
    | undefined
  if (!row) return undefined
  return {
    toId: row.buyer_user_id,
    buyerUsername: row.buyer_username,
    conversationId: row.conversation_id,
    updatedAt: row.updated_at,
  }
}

export function listLinkedBuyerUsernames(): string[] {
  const rows = db
    .prepare('SELECT buyer_username FROM shopee_buyer_chats ORDER BY buyer_username COLLATE NOCASE')
    .all() as Array<{ buyer_username: string }>
  return rows.map((r) => r.buyer_username)
}

export function getWorkbookLinkStatus(workbookId: string): {
  ordersQueried: number
  buyersFound: number
  linked: number
  allLinked: boolean
} {
  const buyers = uniqueBuyersFromSheet(workbookId)
  const orderCount = (
    db
      .prepare('SELECT COUNT(DISTINCT id) AS n FROM orders WHERE workbook_id = ? AND TRIM(id) != ?')
      .get(workbookId, '') as { n: number }
  ).n
  const linked = countLinkedBuyers(buyers)
  return {
    ordersQueried: orderCount,
    buyersFound: buyers.length,
    linked,
    allLinked: buyers.length > 0 && linked >= buyers.length,
  }
}

/** Remove vínculos dos compradores (col E) desta planilha — para varrer de novo. */
export function clearBuyerChatsForWorkbook(workbookId: string): number {
  const buyers = uniqueBuyersFromSheet(workbookId)
  let cleared = 0
  const stmt = db.prepare('DELETE FROM shopee_buyer_chats WHERE buyer_username = ? COLLATE NOCASE')
  for (const buyer of buyers) {
    cleared += stmt.run(buyer.username).changes
  }
  return cleared
}

function countLinkedBuyers(buyers: SheetBuyer[]): number {
  let linked = 0
  for (const buyer of buyers) {
    if (getBuyerChatByUsername(buyer.username)) linked++
  }
  return linked
}

/**
 * Uma página da varredura — resposta leve para evitar timeout/502.
 * Grava vínculos assim que encontra match na col E.
 */
export async function linkConversationsScanChunk(
  workbookId: string,
  options: {
    nextTimestampNano?: string
    pageNumber?: number
    scannedBefore?: number
    indexedBefore?: number
  } = {},
): Promise<LinkConversationsChunkResult> {
  const result: LinkConversationsChunkResult = {
    ordersQueried: 0,
    buyersFound: 0,
    linked: 0,
    linkedThisChunk: 0,
    notFound: 0,
    conversationsScanned: options.scannedBefore ?? 0,
    conversationsIndexed: options.indexedBefore ?? 0,
    conversationPages: options.pageNumber ?? 0,
    pageMetric: null,
    nextTimestampNano: null,
    hasMore: false,
    done: true,
    doneReason: null,
    connectedShopId: null,
    errors: [],
  }

  const buyers = uniqueBuyersFromSheet(workbookId)
  const orderCount = (
    db
      .prepare('SELECT COUNT(DISTINCT id) AS n FROM orders WHERE workbook_id = ? AND TRIM(id) != ?')
      .get(workbookId, '') as { n: number }
  ).n
  result.ordersQueried = orderCount
  result.buyersFound = buyers.length
  if (buyers.length === 0) {
    result.doneReason = 'empty_page'
    return result
  }

  const targetUsernames = new Set(buyers.map((b) => b.username.toLowerCase()))
  const buyerByKey = new Map(buyers.map((b) => [b.username.toLowerCase(), b]))
  const linkedBefore = countLinkedBuyers(buyers)
  const pageNumber = (options.pageNumber ?? 0) + 1

  let page: Awaited<ReturnType<typeof fetchConversationPage>>
  try {
    page = await fetchConversationPage({
      nextTimestampNano: options.nextTimestampNano,
      pageNumber,
      scannedBefore: options.scannedBefore ?? 0,
    })
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error))
    result.linked = linkedBefore
    result.notFound = buyers.length - linkedBefore
    return result
  }

  result.pageMetric = page.pageMetric
  result.conversationsScanned = page.pageMetric.scannedTotal
  result.conversationsIndexed = (options.indexedBefore ?? 0) + page.pageMetric.indexedOnPage
  result.conversationPages = pageNumber
  result.nextTimestampNano = page.pageMetric.nextTimestampNano
  result.hasMore = page.hasMore
  result.connectedShopId = page.connectedShopId

  const now = nowMs()
  let linkedThisChunk = 0
  for (const entry of page.entries) {
    const key = entry.toName.toLowerCase()
    if (!targetUsernames.has(key)) continue
    const buyer = buyerByKey.get(key)
    if (!buyer) continue
    if (getBuyerChatByUsername(buyer.username)) continue
    upsertBuyerChat({
      toId: entry.toId,
      buyerUsername: buyer.username,
      conversationId: entry.conversationId,
      updatedAt: now,
    })
    linkedThisChunk++
  }
  result.linkedThisChunk = linkedThisChunk
  result.linked = countLinkedBuyers(buyers)
  result.notFound = buyers.length - result.linked

  if (page.pageMetric.chatsOnPage === 0) {
    result.done = true
    result.doneReason = 'no_more'
    result.hasMore = false
  } else if (result.linked >= buyers.length) {
    result.done = true
    result.doneReason = 'all_found'
  } else if (!page.hasMore) {
    result.done = true
    result.doneReason = 'no_more'
  } else {
    result.done = false
    result.doneReason = null
  }

  return result
}

/**
 * Cruza col E (username) com to_name do get_conversation_list.
 * A Shopee não expõe busca por username — só lista paginada ou get_one_conversation(conversation_id).
 */
export async function linkConversationsForWorkbook(
  workbookId: string,
  options: { maxConversations?: number; startTimestampNano?: string } = {},
): Promise<LinkConversationsResult> {
  const result: LinkConversationsResult = {
    ordersQueried: 0,
    buyersFound: 0,
    linked: 0,
    notFound: 0,
    conversationsScanned: 0,
    conversationsIndexed: 0,
    conversationPages: 0,
    newestChatAt: null,
    oldestScannedChatAt: null,
    connectedShopId: null,
    chatShopIds: [],
    pageMetrics: [],
    resumeCursor: null,
    errors: [],
  }

  const buyers = uniqueBuyersFromSheet(workbookId)
  const orderCount = (
    db
      .prepare('SELECT COUNT(DISTINCT id) AS n FROM orders WHERE workbook_id = ? AND TRIM(id) != ?')
      .get(workbookId, '') as { n: number }
  ).n
  result.ordersQueried = orderCount
  result.buyersFound = buyers.length
  if (buyers.length === 0) return result

  const targetUsernames = new Set(buyers.map((b) => b.username.toLowerCase()))
  let convMaps: Awaited<ReturnType<typeof fetchConversationMap>>
  try {
    convMaps = await fetchConversationMap({
      targetUsernames,
      maxConversations: options.maxConversations ?? SHOPEE_CONVERSATION_SCAN_MAX,
      startTimestampNano: options.startTimestampNano,
    })
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error))
    return result
  }
  result.conversationsScanned = convMaps.scanned
  result.conversationsIndexed = convMaps.indexed
  result.conversationPages = convMaps.pages
  result.newestChatAt = convMaps.newestChatAt
  result.oldestScannedChatAt = convMaps.oldestScannedChatAt
  result.connectedShopId = convMaps.connectedShopId
  result.chatShopIds = convMaps.chatShopIds
  result.pageMetrics = convMaps.pageMetrics
  result.resumeCursor = convMaps.resumeCursor
  if (
    result.connectedShopId != null &&
    result.chatShopIds.length > 0 &&
    !result.chatShopIds.every((id) => id === result.connectedShopId)
  ) {
    result.errors.push(
      `shop_id dos chats (${result.chatShopIds.join(', ')}) difere da loja OAuth (${result.connectedShopId}) — reautorize a loja certa no Shopee Test`,
    )
  }
  if (convMaps.indexed === 0 && convMaps.scanned > 0) {
    result.errors.push(
      'Nenhum chat com to_name/conversation_id reconhecível — confira get_conversation_list no Shopee Test',
    )
  }

  const now = nowMs()
  for (const buyer of buyers) {
    const chat = convMaps.byUsername.get(buyer.username.toLowerCase())
    if (!chat?.conversationId) {
      result.notFound++
      continue
    }
    upsertBuyerChat({
      toId: chat.toId,
      buyerUsername: buyer.username,
      conversationId: chat.conversationId,
      updatedAt: now,
    })
    result.linked++
  }

  return result
}
