/**
 * Vínculo comprador TikTok → chat (conversation_id).
 * Espelha shopee-link-conversations: col E (username) × conversations API.
 */
import { db, nowMs } from './db.js'
import { listConversations, tiktokConfigured } from './tiktok-api.js'
import { loadTikTokAuth } from './tiktok-store.js'

export interface TikTokBuyerChatRow {
  buyerUserId: string
  buyerUsername: string
  conversationId: string
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

export function upsertTikTokBuyerChat(row: TikTokBuyerChatRow): void {
  db.prepare('DELETE FROM tiktok_buyer_chats WHERE buyer_username = ? COLLATE NOCASE').run(row.buyerUsername)
  db.prepare(
    `INSERT INTO tiktok_buyer_chats (buyer_user_id, buyer_username, conversation_id, updated_at)
     VALUES (?, ?, ?, ?)`,
  ).run(row.buyerUserId, row.buyerUsername, row.conversationId, row.updatedAt)
}

export function getBuyerChatByUsername(username: string): TikTokBuyerChatRow | undefined {
  const name = username.trim()
  if (!name) return undefined
  const row = db
    .prepare(
      'SELECT buyer_user_id, buyer_username, conversation_id, updated_at FROM tiktok_buyer_chats WHERE buyer_username = ? COLLATE NOCASE LIMIT 1',
    )
    .get(name) as
    | { buyer_user_id: string; buyer_username: string; conversation_id: string; updated_at: number }
    | undefined
  if (!row) return undefined
  return {
    buyerUserId: row.buyer_user_id,
    buyerUsername: row.buyer_username,
    conversationId: row.conversation_id,
    updatedAt: row.updated_at,
  }
}

export function listLinkedBuyerUsernames(): string[] {
  const rows = db
    .prepare('SELECT buyer_username FROM tiktok_buyer_chats ORDER BY buyer_username COLLATE NOCASE')
    .all() as Array<{ buyer_username: string }>
  return rows.map((r) => r.buyer_username)
}

/**
 * Varre conversations do TikTok e vincula pelo username da col E.
 * Best-effort: 1 passada paginada, max 10 páginas.
 */
export async function linkConversationsScan(
  workbookId: string,
): Promise<{ scanned: number; linked: number }> {
  if (!tiktokConfigured() || !loadTikTokAuth()) {
    return { scanned: 0, linked: 0 }
  }
  const buyers = uniqueBuyersFromSheet(workbookId)
  if (buyers.length === 0) return { scanned: 0, linked: 0 }

  const targetSet = new Set(buyers.map((b) => b.toLowerCase()))
  const now = nowMs()
  let scanned = 0
  let linked = 0
  let pageToken = ''
  let pages = 0

  do {
    const page = await listConversations({
      pageSize: 20,
      pageToken: pageToken || undefined,
    })
    pages++
    for (const conv of page.conversations) {
      scanned++
      const buyerUsername = conv.participant_info?.buyer_username ?? ''
      const buyerUserId = conv.participant_info?.buyer_user_id ?? ''
      const conversationId = conv.conversation_id ?? ''
      if (!buyerUsername || !conversationId) continue
      const key = buyerUsername.toLowerCase()
      if (!targetSet.has(key)) continue
      if (getBuyerChatByUsername(buyerUsername)) continue
      upsertTikTokBuyerChat({
        buyerUserId,
        buyerUsername,
        conversationId,
        updatedAt: now,
      })
      linked++
    }
    pageToken = page.nextPageToken
  } while (pageToken && pages < 10)

  return { scanned, linked }
}
