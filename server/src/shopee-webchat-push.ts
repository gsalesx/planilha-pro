import { db, nowMs } from './db.js'

export interface WebchatPushLogEntry {
  id: number
  receivedAt: number
  code: number
  rawJson: string
  guessedToId: number | null
  guessedFromUserName: string | null
  guessedToUserName: string | null
  guessedConversationId: string | null
  guessedContent: string | null
}

function firstDefined(...values: unknown[]): unknown {
  for (const v of values) {
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

/**
 * Não sabemos ainda o formato exato do webchat_push (docs da Shopee inacessíveis daqui) —
 * então isso só REGISTRA um chute de campos prováveis, sem escrever em shopee_buyer_chats.
 * Depois que a primeira mensagem real chegar, GET /shopee/webchat-push/recent mostra o
 * raw_json completo pra implementar o parsing certo com base no formato de verdade.
 */
export function recordWebchatPushAttempt(code: number, data: unknown): void {
  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {}
  const toId = firstDefined(d.to_id, d.toId, d.from_id, d.fromId, d.sender_id, d.buyer_user_id)
  const fromUserName = firstDefined(d.from_user_name, d.fromUserName, d.sender_name, d.from_name)
  const toUserName = firstDefined(d.to_user_name, d.toUserName, d.receiver_name, d.to_name)
  const conversationId = firstDefined(d.conversation_id, d.conversationId)
  const content = firstDefined(d.content, d.message, d.text)

  db.prepare(
    `INSERT INTO shopee_webchat_push_log
     (received_at, code, raw_json, guessed_to_id, guessed_from_user_name, guessed_to_user_name, guessed_conversation_id, guessed_content)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nowMs(),
    code,
    JSON.stringify(data ?? null).slice(0, 4000),
    toId != null ? Number(toId) || null : null,
    fromUserName != null ? String(fromUserName).slice(0, 200) : null,
    toUserName != null ? String(toUserName).slice(0, 200) : null,
    conversationId != null ? String(conversationId).slice(0, 200) : null,
    content != null ? String(content).slice(0, 500) : null,
  )
}

export function getRecentWebchatPushes(limit = 20): WebchatPushLogEntry[] {
  const rows = db
    .prepare(
      `SELECT id, received_at, code, raw_json, guessed_to_id, guessed_from_user_name,
              guessed_to_user_name, guessed_conversation_id, guessed_content
       FROM shopee_webchat_push_log ORDER BY id DESC LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 100)) as Array<{
    id: number
    received_at: number
    code: number
    raw_json: string
    guessed_to_id: number | null
    guessed_from_user_name: string | null
    guessed_to_user_name: string | null
    guessed_conversation_id: string | null
    guessed_content: string | null
  }>
  return rows.map((r) => ({
    id: r.id,
    receivedAt: r.received_at,
    code: r.code,
    rawJson: r.raw_json,
    guessedToId: r.guessed_to_id,
    guessedFromUserName: r.guessed_from_user_name,
    guessedToUserName: r.guessed_to_user_name,
    guessedConversationId: r.guessed_conversation_id,
    guessedContent: r.guessed_content,
  }))
}
