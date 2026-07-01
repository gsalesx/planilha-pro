import { db, nowMs } from './db.js'
import {
  assertShopeeOk,
  fetchConversationMap,
  getOrderDetail,
  ORDER_BUYER_FIELDS,
  type ShopeeApiResponse,
} from './shopee-api.js'

export interface ShopeeBuyerChatRow {
  buyerUserId: number
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
  errors: string[]
}

interface BuyerInfo {
  buyerUserId: number
  buyerUsername: string
}

function uniqueOrderSns(workbookId: string): string[] {
  const rows = db
    .prepare('SELECT DISTINCT id FROM orders WHERE workbook_id = ? AND TRIM(id) != ?')
    .all(workbookId, '') as Array<{ id: string }>
  return rows.map((r) => r.id.trim()).filter(Boolean)
}

function parseBuyersFromDetail(data: ShopeeApiResponse): BuyerInfo[] {
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_order_detail') as {
    order_list?: Array<{ buyer_user_id?: number; buyer_username?: string }>
  }
  const buyers: BuyerInfo[] = []
  for (const order of body.order_list ?? []) {
    const buyerUserId = order.buyer_user_id
    if (typeof buyerUserId !== 'number' || buyerUserId <= 0) continue
    buyers.push({
      buyerUserId,
      buyerUsername: (order.buyer_username ?? '').trim(),
    })
  }
  return buyers
}

function dedupeBuyers(buyers: BuyerInfo[]): BuyerInfo[] {
  const byId = new Map<number, BuyerInfo>()
  for (const b of buyers) {
    const prev = byId.get(b.buyerUserId)
    if (!prev || (!prev.buyerUsername && b.buyerUsername)) {
      byId.set(b.buyerUserId, b)
    }
  }
  return [...byId.values()]
}

function upsertBuyerChat(row: ShopeeBuyerChatRow): void {
  db.prepare(
    `INSERT INTO shopee_buyer_chats (buyer_user_id, buyer_username, conversation_id, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(buyer_user_id) DO UPDATE SET
       buyer_username = excluded.buyer_username,
       conversation_id = excluded.conversation_id,
       updated_at = excluded.updated_at`,
  ).run(row.buyerUserId, row.buyerUsername, row.conversationId, row.updatedAt)
}

export function getBuyerChat(buyerUserId: number): ShopeeBuyerChatRow | undefined {
  const row = db
    .prepare(
      'SELECT buyer_user_id, buyer_username, conversation_id, updated_at FROM shopee_buyer_chats WHERE buyer_user_id = ?',
    )
    .get(buyerUserId) as
    | { buyer_user_id: number; buyer_username: string; conversation_id: string; updated_at: number }
    | undefined
  if (!row) return undefined
  return {
    buyerUserId: row.buyer_user_id,
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
    buyerUserId: row.buyer_user_id,
    buyerUsername: row.buyer_username,
    conversationId: row.conversation_id,
    updatedAt: row.updated_at,
  }
}

/** Lê pedidos da planilha, busca buyer_user_id na API e vincula conversation_id — sem alterar linhas. */
export async function linkConversationsForWorkbook(workbookId: string): Promise<LinkConversationsResult> {
  const result: LinkConversationsResult = {
    ordersQueried: 0,
    buyersFound: 0,
    linked: 0,
    notFound: 0,
    conversationsScanned: 0,
    errors: [],
  }

  const orderSns = uniqueOrderSns(workbookId)
  result.ordersQueried = orderSns.length
  if (orderSns.length === 0) return result

  const allBuyers: BuyerInfo[] = []
  for (let i = 0; i < orderSns.length; i += 50) {
    const batch = orderSns.slice(i, i + 50)
    try {
      const data = await getOrderDetail(batch, ORDER_BUYER_FIELDS)
      allBuyers.push(...parseBuyersFromDetail(data))
    } catch (error) {
      result.errors.push(
        `pedidos ${i + 1}-${i + batch.length}: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }

  const buyers = dedupeBuyers(allBuyers)
  result.buyersFound = buyers.length
  if (buyers.length === 0) return result

  const targetIds = new Set(buyers.map((b) => b.buyerUserId))
  let convMaps: Awaited<ReturnType<typeof fetchConversationMap>>
  try {
    convMaps = await fetchConversationMap(targetIds)
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error))
    return result
  }
  result.conversationsScanned = convMaps.scanned

  const now = nowMs()
  for (const buyer of buyers) {
    let conversationId = convMaps.byBuyerId.get(buyer.buyerUserId)?.conversationId ?? ''
    if (!conversationId && buyer.buyerUsername) {
      conversationId = convMaps.byUsername.get(buyer.buyerUsername.toLowerCase())?.conversationId ?? ''
    }
    upsertBuyerChat({
      buyerUserId: buyer.buyerUserId,
      buyerUsername: buyer.buyerUsername,
      conversationId,
      updatedAt: now,
    })
    if (conversationId) result.linked++
    else result.notFound++
  }

  return result
}
