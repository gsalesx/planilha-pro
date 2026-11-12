import {
  assertShopeeOk,
  getAdsDailyPerformance,
  getAdsTotalBalance,
  getOrderDetail,
  getOrderList,
  type ShopeeApiResponse,
} from './shopee-api.js'

/**
 * Resumo do dia da loja Shopee (vendas + anúncios) para o widget do PC.
 * Fuso da loja: America/Sao_Paulo (UTC-3, sem horário de verão).
 */

const TZ = 'America/Sao_Paulo'
const UTC_OFFSET = '-03:00'
const CACHE_MS = 2 * 60 * 1000
const NOT_PAID = new Set(['UNPAID'])
const CANCELLED = new Set(['CANCELLED', 'IN_CANCEL'])

export interface ResumoDia {
  data: string
  geradoEm: number
  vendas: {
    pedidosPagos: number
    valorPago: number
    unidadesPagas: number
    naoPagos: { pedidos: number; valor: number }
    cancelados: { pedidos: number; valor: number }
    ultimoPedidoEm: number | null
  } | null
  ads: {
    gasto: number
    impressoes: number
    cliques: number
    pedidos: number
    pedidosAmplos: number
    gmv: number
    gmvAmplo: number
    roas: number
    roasAmplo: number
    saldo: number | null
  } | null
  erros: { vendas?: string; ads?: string }
}

/** Hoje em DD-MM-YYYY no fuso da loja. */
export function hojeLoja(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' })
    .formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? ''
  return `${get('day')}-${get('month')}-${get('year')}`
}

export function parseDataLoja(data: string): { from: number; to: number } | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(data)
  if (!m) return null
  const start = Date.parse(`${m[3]}-${m[2]}-${m[1]}T00:00:00${UTC_OFFSET}`)
  if (!Number.isFinite(start)) return null
  const from = Math.floor(start / 1000)
  const to = Math.min(from + 86400 - 1, Math.floor(Date.now() / 1000))
  return to < from ? null : { from, to }
}

const round2 = (n: number) => Math.round(n * 100) / 100

type OrderItem = { model_quantity_purchased?: number }
type OrderDetail = { order_sn: string; order_status?: string; total_amount?: number; create_time?: number; item_list?: OrderItem[] }

async function resumoVendas(from: number, to: number): Promise<NonNullable<ResumoDia['vendas']>> {
  const sns: string[] = []
  let cursor = ''
  for (let page = 0; page < 50; page++) {
    const body = assertShopeeOk(
      (await getOrderList({ timeFrom: from, timeTo: to, pageSize: 100, cursor: cursor || undefined })) as ShopeeApiResponse<Record<string, unknown>>,
      'get_order_list',
    ) as { order_list?: { order_sn?: string }[]; more?: boolean; next_cursor?: string }
    for (const o of body.order_list ?? []) if (o.order_sn) sns.push(o.order_sn)
    if (!body.more || !body.next_cursor) break
    cursor = body.next_cursor
  }

  const orders: OrderDetail[] = []
  for (let i = 0; i < sns.length; i += 50) {
    const body = assertShopeeOk(
      (await getOrderDetail(sns.slice(i, i + 50), 'item_list,order_status,create_time,total_amount')) as ShopeeApiResponse<Record<string, unknown>>,
      'get_order_detail',
    ) as { order_list?: OrderDetail[] }
    orders.push(...(body.order_list ?? []))
  }

  const out = {
    pedidosPagos: 0,
    valorPago: 0,
    unidadesPagas: 0,
    naoPagos: { pedidos: 0, valor: 0 },
    cancelados: { pedidos: 0, valor: 0 },
    ultimoPedidoEm: null as number | null,
  }
  for (const o of orders) {
    const status = o.order_status ?? ''
    const valor = Number(o.total_amount) || 0
    if (o.create_time && (!out.ultimoPedidoEm || o.create_time * 1000 > out.ultimoPedidoEm)) {
      out.ultimoPedidoEm = o.create_time * 1000
    }
    if (NOT_PAID.has(status)) {
      out.naoPagos.pedidos++
      out.naoPagos.valor += valor
    } else if (CANCELLED.has(status)) {
      out.cancelados.pedidos++
      out.cancelados.valor += valor
    } else {
      out.pedidosPagos++
      out.valorPago += valor
      out.unidadesPagas += (o.item_list ?? []).reduce((a, it) => a + (Number(it.model_quantity_purchased) || 0), 0)
    }
  }
  out.valorPago = round2(out.valorPago)
  out.naoPagos.valor = round2(out.naoPagos.valor)
  out.cancelados.valor = round2(out.cancelados.valor)
  return out
}

function checkAds(data: ShopeeApiResponse, context: string): unknown {
  if (data.error) throw new Error(`${context}: ${data.error}${data.message ? ` — ${data.message}` : ''}`)
  return data.response
}

async function resumoAds(data: string): Promise<NonNullable<ResumoDia['ads']>> {
  const [perfRaw, balRaw] = await Promise.all([getAdsDailyPerformance(data, data), getAdsTotalBalance()])
  const perf = checkAds(perfRaw, 'get_all_cpc_ads_daily_performance')
  const dia = (Array.isArray(perf) ? perf : []).find((d) => d?.date === data) ?? {}
  let saldo: number | null = null
  try {
    const bal = checkAds(balRaw, 'get_total_balance') as { total_balance?: number } | undefined
    saldo = typeof bal?.total_balance === 'number' ? bal.total_balance : null
  } catch {
    saldo = null
  }
  const n = (k: string) => Number((dia as Record<string, unknown>)[k]) || 0
  return {
    gasto: round2(n('expense')),
    impressoes: n('impression'),
    cliques: n('clicks'),
    pedidos: n('direct_order'),
    pedidosAmplos: n('broad_order'),
    gmv: round2(n('direct_gmv')),
    gmvAmplo: round2(n('broad_gmv')),
    roas: n('direct_roas'),
    roasAmplo: n('broad_roas'),
    saldo,
  }
}

const cache = new Map<string, ResumoDia>()
const inflight = new Map<string, Promise<ResumoDia>>()

export async function getResumoDia(data: string, force = false): Promise<ResumoDia> {
  const range = parseDataLoja(data)
  if (!range) throw new Error('data inválida (use DD-MM-YYYY, até hoje)')
  const hit = cache.get(data)
  if (!force && hit && Date.now() - hit.geradoEm < CACHE_MS) return hit
  const running = inflight.get(data)
  if (running) return running

  const job = (async () => {
    const [v, a] = await Promise.allSettled([resumoVendas(range.from, range.to), resumoAds(data)])
    const resumo: ResumoDia = {
      data,
      geradoEm: Date.now(),
      vendas: v.status === 'fulfilled' ? v.value : null,
      ads: a.status === 'fulfilled' ? a.value : null,
      erros: {},
    }
    if (v.status === 'rejected') resumo.erros.vendas = String((v.reason as Error)?.message ?? v.reason)
    if (a.status === 'rejected') resumo.erros.ads = String((a.reason as Error)?.message ?? a.reason)
    if (resumo.vendas || resumo.ads) cache.set(data, resumo)
    if (cache.size > 10) cache.delete(cache.keys().next().value as string)
    return resumo
  })()
  inflight.set(data, job)
  try {
    return await job
  } finally {
    inflight.delete(data)
  }
}
