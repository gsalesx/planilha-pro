import { Router } from 'express'

import { auditSummary, queryAudit } from '../audit.js'
import { requireAuth } from '../auth.js'
import { db } from '../db.js'
import { SHOPEE_WORKBOOK_ID } from '../shopee-workbook.js'

const router = Router()

function num(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/**
 * GET /api/audit — trilha crua, com filtros.
 * Ex.: /api/audit?orderSn=260725HRX22DV3  → tudo que já aconteceu com aquele pedido.
 *      /api/audit?level=error&since=<ms>  → só o que deu errado na janela.
 */
router.get('/audit', requireAuth, (req, res) => {
  const q = req.query
  const { total, rows } = queryAudit({
    since: num(q.since),
    until: num(q.until),
    source: typeof q.source === 'string' ? q.source : undefined,
    event: typeof q.event === 'string' ? q.event : undefined,
    level: typeof q.level === 'string' ? q.level : undefined,
    orderSn: typeof q.orderSn === 'string' ? q.orderSn : undefined,
    orderKey: typeof q.orderKey === 'string' ? q.orderKey : undefined,
    runId: typeof q.runId === 'string' ? q.runId : undefined,
    search: typeof q.search === 'string' ? q.search : undefined,
    limit: num(q.limit),
    offset: num(q.offset),
  })
  res.json({
    ok: true,
    total,
    items: rows.map((r) => ({
      id: r.id,
      at: r.at,
      level: r.level,
      source: r.source,
      event: r.event,
      runId: r.run_id,
      workbookId: r.workbook_id,
      orderSn: r.order_sn,
      orderKey: r.order_key,
      detail: JSON.parse(r.detail_json) as unknown,
    })),
  })
})

/** GET /api/audit/resumo?horas=48 — contagem por evento; é o "como foram os crons". */
router.get('/audit/resumo', requireAuth, (req, res) => {
  const horas = Math.min(Math.max(num(req.query.horas) ?? 48, 1), 24 * 90)
  const desde = Date.now() - horas * 3600_000
  const eventos = auditSummary(desde)
  const ultimoPoll = queryAudit({ event: 'poll.fim', limit: 1 }).rows[0]
  const ultimoPush = queryAudit({ event: 'push.recebido', limit: 1 }).rows[0]
  res.json({
    ok: true,
    janelaHoras: horas,
    desde,
    ultimoPoll: ultimoPoll
      ? { at: ultimoPoll.at, detail: JSON.parse(ultimoPoll.detail_json) as unknown }
      : null,
    ultimoPushRecebido: ultimoPush ? { at: ultimoPush.at } : null,
    eventos,
    problemas: eventos.filter((e) => e.level !== 'info'),
  })
})

interface OrderLinha {
  order_key: string
  id: string
  row_json: string
  sheet_date: string
  position: number
}

/**
 * Ocorrência codificada na key: `SN` = 1ª linha · `{data}__{SN}__{n}` = n-ésima.
 * Duas linhas com a MESMA ocorrência do mesmo pedido = duplicata (foi assim que o
 * pedido de 2 peças da 24lehsilva virou 3 linhas em 2026-07-28).
 */
function occurrenceDaKey(orderKey: string, orderSn: string): number | null {
  if (orderKey === orderSn) return 1
  const m = new RegExp(`__${orderSn.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}__(\\d+)$`).exec(orderKey)
  return m ? Number(m[1]) : null
}

/**
 * GET /api/audit/duplicatas — varredura de integridade das linhas de pedido.
 * Roda direto no estado atual do banco (não depende do log): responde "existe hoje
 * alguma linha duplicada ou fora de lugar?".
 */
router.get('/audit/duplicatas', requireAuth, (req, res) => {
  const workbookId = typeof req.query.workbookId === 'string' ? req.query.workbookId : SHOPEE_WORKBOOK_ID
  const linhas = db
    .prepare('SELECT order_key, id, row_json, sheet_date, position FROM orders WHERE workbook_id = ? ORDER BY position')
    .all(workbookId) as OrderLinha[]

  const porPedido = new Map<string, OrderLinha[]>()
  for (const l of linhas) {
    const lista = porPedido.get(l.id) ?? []
    lista.push(l)
    porPedido.set(l.id, lista)
  }

  const duplicadas: unknown[] = []
  const desalinhadas: unknown[] = []
  const datasDivergentes: unknown[] = []

  for (const [orderSn, lista] of porPedido) {
    if (lista.length < 2) continue

    const porOccurrence = new Map<number, OrderLinha[]>()
    for (const l of lista) {
      const occ = occurrenceDaKey(l.order_key, orderSn)
      if (occ == null) continue
      const g = porOccurrence.get(occ) ?? []
      g.push(l)
      porOccurrence.set(occ, g)
    }
    for (const [occ, g] of porOccurrence) {
      if (g.length > 1) {
        duplicadas.push({
          orderSn,
          occurrence: occ,
          linhas: g.map((l) => ({ key: l.order_key, position: l.position, sheetDate: l.sheet_date, row: JSON.parse(l.row_json) })),
        })
      }
    }

    const posicoes = lista.map((l) => l.position).sort((a, b) => a - b)
    const contiguas = posicoes[posicoes.length - 1] - posicoes[0] === posicoes.length - 1
    if (!contiguas) {
      desalinhadas.push({ orderSn, posicoes, keys: lista.map((l) => l.order_key) })
    }

    const datas = [...new Set(lista.map((l) => l.sheet_date))]
    if (datas.length > 1) {
      datasDivergentes.push({ orderSn, datas, keys: lista.map((l) => ({ key: l.order_key, sheetDate: l.sheet_date })) })
    }
  }

  res.json({
    ok: true,
    workbookId,
    totalLinhas: linhas.length,
    duplicadas,
    desalinhadas,
    datasDivergentes,
    resumo: {
      duplicadas: duplicadas.length,
      desalinhadas: desalinhadas.length,
      datasDivergentes: datasDivergentes.length,
    },
  })
})

export default router
