import { db, nowMs } from './db.js'
import {
  getOrderDetail,
  ORDER_BUYER_FIELDS,
  sendChatMessage,
  type ShopeeApiResponse,
} from './shopee-api.js'

/** Status Shopee que dispara a mensagem automática (compra paga, pronta pra enviar). */
const READY_TO_SHIP = 'READY_TO_SHIP'

/** Mensagem padrão do disparo — pedida pelo usuário. */
export const DEFAULT_GREET_MESSAGE = 'Olá, pode enviar aqui as artes para personalização'

export interface AutoGreetState {
  armed: boolean
  message: string
  updatedAt: number
}

export interface AutoGreetLogEntry {
  id: number
  orderSn: string
  buyerUserId: number | null
  buyerUsername: string
  status: 'sent' | 'failed'
  detail: string
  createdAt: number
}

export function getAutoGreetState(): AutoGreetState {
  const row = db
    .prepare('SELECT armed, message, updated_at FROM shopee_auto_greet WHERE id = 1')
    .get() as { armed: number; message: string; updated_at: number } | undefined
  return {
    armed: Boolean(row?.armed),
    message: row?.message?.trim() || DEFAULT_GREET_MESSAGE,
    updatedAt: row?.updated_at ?? 0,
  }
}

/** Arma o disparo para a PRÓXIMA compra READY_TO_SHIP. Mensagem vazia usa a padrão. */
export function armAutoGreet(message?: string): AutoGreetState {
  const text = (message ?? '').trim() || DEFAULT_GREET_MESSAGE
  db.prepare('UPDATE shopee_auto_greet SET armed = 1, message = ?, updated_at = ? WHERE id = 1').run(
    text,
    nowMs(),
  )
  return getAutoGreetState()
}

export function disarmAutoGreet(): AutoGreetState {
  db.prepare('UPDATE shopee_auto_greet SET armed = 0, updated_at = ? WHERE id = 1').run(nowMs())
  return getAutoGreetState()
}

export function getAutoGreetLog(limit = 20): AutoGreetLogEntry[] {
  const rows = db
    .prepare(
      'SELECT id, order_sn, buyer_user_id, buyer_username, status, detail, created_at FROM shopee_auto_greet_log ORDER BY id DESC LIMIT ?',
    )
    .all(Math.min(Math.max(limit, 1), 200)) as Array<{
    id: number
    order_sn: string
    buyer_user_id: number | null
    buyer_username: string
    status: string
    detail: string
    created_at: number
  }>
  return rows.map((r) => ({
    id: r.id,
    orderSn: r.order_sn,
    buyerUserId: r.buyer_user_id,
    buyerUsername: r.buyer_username,
    status: r.status === 'sent' ? 'sent' : 'failed',
    detail: r.detail,
    createdAt: r.created_at,
  }))
}

function logGreet(entry: Omit<AutoGreetLogEntry, 'id' | 'createdAt'>): void {
  db.prepare(
    `INSERT INTO shopee_auto_greet_log (order_sn, buyer_user_id, buyer_username, status, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(entry.orderSn, entry.buyerUserId, entry.buyerUsername, entry.status, entry.detail, nowMs())
}

interface BuyerInfo {
  buyerUserId: number | null
  buyerUsername: string
}

async function fetchBuyerInfo(orderSn: string): Promise<BuyerInfo> {
  const data = await getOrderDetail([orderSn], ORDER_BUYER_FIELDS)
  if (data.error) {
    throw new Error(`get_order_detail: ${data.error}${data.message ? ` — ${data.message}` : ''}`)
  }
  const body =
    data.response != null && typeof data.response === 'object'
      ? (data.response as Record<string, unknown>)
      : (data as Record<string, unknown>)
  const list = (body.order_list as Array<Record<string, unknown>> | undefined) ?? []
  const row = list.find((o) => o.order_sn === orderSn) ?? list[0]
  return {
    buyerUserId: Number(row?.buyer_user_id) || null,
    buyerUsername: typeof row?.buyer_username === 'string' ? row.buyer_username : '',
  }
}

function shopeeErrorFrom(resp: ShopeeApiResponse): string | null {
  if (resp.error && resp.error !== '') {
    return `${resp.error}${resp.message ? ` — ${resp.message}` : ''}`
  }
  return null
}

/**
 * Chamado a cada push de status (code 3). Só age quando o status vira READY_TO_SHIP
 * e o disparo está armado. Consome o "armado" de forma atômica → exatamente a PRÓXIMA
 * compra dispara. Registra sent/failed em shopee_auto_greet_log.
 */
export async function maybeGreetOnReadyToShip(orderSn: string, status: string): Promise<void> {
  if (status.trim().toUpperCase() !== READY_TO_SHIP) return
  const sn = orderSn.trim()
  if (!sn) return

  const armed = db.prepare('SELECT message FROM shopee_auto_greet WHERE id = 1 AND armed = 1').get() as
    | { message: string }
    | undefined
  if (!armed) return

  // Consome o disparo atomicamente — se dois pushes chegarem juntos, só um vence.
  const claim = db
    .prepare('UPDATE shopee_auto_greet SET armed = 0, updated_at = ? WHERE id = 1 AND armed = 1')
    .run(nowMs())
  if (claim.changes !== 1) return

  const message = armed.message.trim() || DEFAULT_GREET_MESSAGE
  let buyerUserId: number | null = null
  let buyerUsername = ''
  try {
    const info = await fetchBuyerInfo(sn)
    buyerUserId = info.buyerUserId
    buyerUsername = info.buyerUsername
    if (!buyerUserId) throw new Error('buyer_user_id não retornado pelo get_order_detail')

    const resp = await sendChatMessage({ toId: buyerUserId, text: message })
    const err = shopeeErrorFrom(resp)
    if (err) throw new Error(err)

    logGreet({
      orderSn: sn,
      buyerUserId,
      buyerUsername,
      status: 'sent',
      detail: JSON.stringify(resp).slice(0, 500),
    })
    console.log('[shopee-auto-greet] mensagem enviada', { orderSn: sn, buyerUserId })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    logGreet({
      orderSn: sn,
      buyerUserId,
      buyerUsername,
      status: 'failed',
      detail: msg.slice(0, 500),
    })
    console.error('[shopee-auto-greet] falha ao enviar', { orderSn: sn, error: msg })
  }
}
