import { type AuditSource, recordAudit } from './audit.js'
import { type MarketplaceChannel } from './marketplace.js'

/**
 * Status que o sistema já entende. Qualquer outro — API ou planilha, em qualquer
 * marketplace — é gravado em audit_log (evento status.desconhecido) e no stdout,
 * que o Grafana coleta. A planilha não importa rótulo desconhecido; a API grava
 * o pedido mesmo assim, senão uma venda nova sumiria até alguém mapear o status.
 */

const SHOPEE = new Set([
  'UNPAID',
  'READY_TO_SHIP',
  'PROCESSED',
  'RETRY_SHIP',
  'SHIPPED',
  'TO_CONFIRM_RECEIVE',
  'IN_CANCEL',
  'CANCELLED',
  'TO_RETURN',
  'COMPLETED',
])

const TIKTOK = new Set([
  'UNPAID',
  'ON_HOLD',
  'AWAITING_SHIPMENT',
  'PARTIALLY_SHIPPING',
  'AWAITING_COLLECTION',
  'IN_TRANSIT',
  'DELIVERED',
  'COMPLETED',
  'CANCELLED',
  'CANCEL',
])

const ML_ORDER = new Set([
  'confirmed',
  'payment_required',
  'payment_in_process',
  'partially_paid',
  'paid',
  'partially_refunded',
  'pending_cancel',
  'cancelled',
  'invalid',
])

const ML_SHIPMENT = new Set([
  'pending',
  'handling',
  'ready_to_ship',
  'ready_to_print',
  'shipped',
  'delivered',
  'not_delivered',
  'cancelled',
  'to_be_agreed',
  'closed',
  'error',
  'active',
  'stalled',
  'delayed',
])

/** Mesmo pedido+status no mesmo processo não repete o aviso a cada poll. */
const jaAvisados = new Set<string>()

export function isKnownMarketplaceStatus(channel: MarketplaceChannel, status: string): boolean {
  const value = status.trim()
  if (!value) return true
  if (channel === 'shopee') return SHOPEE.has(value.toUpperCase())
  if (channel === 'tiktok') return TIKTOK.has(value.toUpperCase())
  const lower = value.toLowerCase()
  const slash = lower.indexOf('/')
  if (slash < 0) return ML_ORDER.has(lower) || ML_SHIPMENT.has(lower)
  const order = lower.slice(0, slash)
  const shipment = lower.slice(slash + 1)
  return ML_ORDER.has(order) && ML_SHIPMENT.has(shipment)
}

export function noteUnknownMarketplaceStatus(input: {
  channel: MarketplaceChannel
  origem: 'api' | 'planilha'
  status: string
  workbookId: string
  orderId?: string
  runId?: string | null
  source?: AuditSource
}): void {
  const status = input.status.trim()
  if (!status || isKnownMarketplaceStatus(input.channel, status)) return
  const chave = `${input.channel}|${input.orderId ?? ''}|${status}`
  if (jaAvisados.has(chave)) return
  jaAvisados.add(chave)

  console.warn('[status-desconhecido]', {
    channel: input.channel,
    origem: input.origem,
    status,
    orderId: input.orderId ?? '',
  })
  recordAudit({
    source: input.source ?? (input.origem === 'planilha' ? 'manual' : 'api'),
    level: 'warn',
    event: 'status.desconhecido',
    runId: input.runId,
    workbookId: input.workbookId,
    orderSn: input.orderId,
    detail: {
      origem: input.origem,
      channel: input.channel,
      status,
    },
  })
}

/** Vários rótulos de uma planilha recusada, num evento só. */
export function noteUnknownSpreadsheetStatuses(input: {
  channel: MarketplaceChannel
  workbookId: string
  arquivo: string
  status: Record<string, number>
  exemplos: Record<string, string[]>
}): void {
  const entradas = Object.entries(input.status)
  if (!entradas.length) return
  console.warn('[status-desconhecido]', {
    channel: input.channel,
    origem: 'planilha',
    arquivo: input.arquivo,
    status: input.status,
  })
  recordAudit({
    source: 'manual',
    level: 'warn',
    event: 'status.desconhecido',
    workbookId: input.workbookId,
    detail: {
      origem: 'planilha',
      channel: input.channel,
      arquivo: input.arquivo,
      status: input.status,
      exemplos: input.exemplos,
    },
  })
}
