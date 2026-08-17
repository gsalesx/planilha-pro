/**
 * Vínculo comprador Mercado Livre → pack (conversation_id = pack_id).
 * Col E (buyer nickname) × pack_id dos pedidos.
 */
import { db, nowMs } from './db.js'
import { searchOrders, mlConfigured } from './mercadolivre-api.js'
import { loadMercadoLivreAuth } from './mercadolivre-store.js'

export interface MlBuyerChatRow {
  buyerUserId: string
  buyerUsername: string
  packId: string
  orderId: string
  updatedAt: number
}

const COL_USERNAME = 4

function uniqueBuyersFromSheet(workbookId: string): string[] {
  const rows = db
    .prepare('SELECT row_json FROM orders WHERE workbook_id = ? AND TRIM(id) != ?')
    .all(workbookId, '') as Array<{ row_json: string }>
  const seen = new Set<string>()
  const result: string[] = []
  for (const r of rows) {
    let cells: unknown[]
    try { cells = JSON.parse(r.row_json) as unknown[] } catch { continue }
    const u = String(cells[COL_USERNAME] ?? '').trim()
    if (!u) continue
    const key = u.toLowerCase()
    if (!seen.has(key)) { seen.add(key); result.push(u) }
  }
  return result
}

export function upsertMlBuyerChat(row: MlBuyerChatRow): void {
  db.prepare('DELETE FROM mercadolivre_buyer_chats WHERE buyer_username = ? COLLATE NOCASE').run(row.buyerUsername)
  db.prepare(
    `INSERT INTO mercadolivre_buyer_chats (buyer_user_id, buyer_username, pack_id, order_id, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.buyerUserId, row.buyerUsername, row.packId, row.orderId, row.updatedAt)
}

export function getBuyerChatByUsername(username: string): MlBuyerChatRow | undefined {
  const name = username.trim()
  if (!name) return undefined
  const row = db
    .prepare(
      'SELECT buyer_user_id, buyer_username, pack_id, order_id, updated_at FROM mercadolivre_buyer_chats WHERE buyer_username = ? COLLATE NOCASE LIMIT 1',
    )
    .get(name) as
    | { buyer_user_id: string; buyer_username: string; pack_id: string; order_id: string; updated_at: number }
    | undefined
  if (!row) return undefined
  return {
    buyerUserId: row.buyer_user_id,
    buyerUsername: row.buyer_username,
    packId: row.pack_id,
    orderId: row.order_id,
    updatedAt: row.updated_at,
  }
}

export function listLinkedBuyerUsernames(): string[] {
  const rows = db
    .prepare('SELECT buyer_username FROM mercadolivre_buyer_chats ORDER BY buyer_username COLLATE NOCASE')
    .all() as Array<{ buyer_username: string }>
  return rows.map((r) => r.buyer_username)
}

/**
 * Varre pedidos recentes do ML e vincula pack_id pelo buyer nickname (col E).
 */
export async function linkConversationsScan(
  workbookId: string,
): Promise<{ scanned: number; linked: number }> {
  if (!mlConfigured()) return { scanned: 0, linked: 0 }
  const auth = loadMercadoLivreAuth()
  if (!auth?.userId) return { scanned: 0, linked: 0 }

  const buyers = uniqueBuyersFromSheet(workbookId)
  if (buyers.length === 0) return { scanned: 0, linked: 0 }

  const targetSet = new Set(buyers.map((b) => b.toLowerCase()))
  const now = nowMs()
  let scanned = 0
  let linked = 0
  let offset = 0
  const limit = 50
  let pages = 0

  try {
    let hasMore = true
    while (hasMore && pages < 10) {
      const page = await searchOrders({ seller: auth.userId, offset, limit })
      pages++
      for (const order of page.results ?? []) {
        scanned++
        const nickname = order.buyer?.nickname ?? ''
        const buyerId = String(order.buyer?.id ?? '')
        const packId = String(order.pack_id ?? order.id ?? '')
        const orderId = String(order.id ?? '')
        if (!nickname || !packId) continue
        const key = nickname.toLowerCase()
        if (!targetSet.has(key)) continue
        if (getBuyerChatByUsername(nickname)) continue
        upsertMlBuyerChat({
          buyerUserId: buyerId,
          buyerUsername: nickname,
          packId,
          orderId,
          updatedAt: now,
        })
        linked++
      }
      const results = page.results ?? []
      offset += results.length
      hasMore = results.length >= limit && offset < (page.paging?.total ?? 0)
    }
  } catch (error) {
    console.warn('[ml-link] scan falhou', error instanceof Error ? error.message : error)
  }

  return { scanned, linked }
}
