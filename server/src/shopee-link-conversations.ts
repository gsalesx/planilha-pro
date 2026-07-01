import { db, nowMs } from './db.js'
import {
  fetchConversationMap,
  SHOPEE_CONVERSATION_SCAN_MAX,
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
  errors: string[]
}

/** Col E — Nome de usuário (já vem no export Shopee / planilha manual). */
const COL_USERNAME = 4

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

/**
 * Cruza col E (username) com to_name do get_conversation_list.
 * A Shopee não expõe busca por username — só lista paginada ou get_one_conversation(conversation_id).
 */
export async function linkConversationsForWorkbook(workbookId: string): Promise<LinkConversationsResult> {
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
      maxConversations: SHOPEE_CONVERSATION_SCAN_MAX,
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
