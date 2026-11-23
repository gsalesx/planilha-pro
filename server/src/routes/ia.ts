/**
 * Painel da IA — só o login `ia` alcança estas rotas (ver iaAccessBlock em review-access.ts).
 * Mostra, por pedido, o que o operador fez (peças, fotos, formato, ajuste, cor, emojis) ao
 * lado da sugestão da IA em modo sombra. Nada aqui altera pedido nem fala com o cliente.
 */
import { Router } from 'express'

import { requireAuth } from '../auth.js'
import { db } from '../db.js'
import {
  MP_COL_INTERNAL_STATUS,
  MP_COL_MARKETPLACE_STATUS,
  MP_COL_MODEL,
  MP_COL_ORDER_ID,
  MP_COL_PRODUCT,
  MP_COL_QTY,
  MP_COL_USERNAME,
} from '../marketplace-columns.js'
import { MERCADOLIVRE_WORKBOOK_ID, SHOPEE_WORKBOOK_ID, TIKTOK_WORKBOOK_ID } from '../marketplace.js'
import { listPieces } from '../pieces.js'
import { paginaRelatorio, resumoRelatorio } from '../relatorio-ajustes.js'
import { carregarModelo, salvarModelo, type PacoteModelo } from '../enquadramento-modelo.js'
import { conversaDoPedido, execucoesMontagem, miniaturaDoChat, montagensDoDia, montarComEscolha, pendentesDoDia, type EscolhaPedido } from '../montagem-ia.js'

const router = Router()

const MARKETPLACES: Record<string, string> = {
  [SHOPEE_WORKBOOK_ID]: 'shopee',
  [TIKTOK_WORKBOOK_ID]: 'tiktok',
  [MERCADOLIVRE_WORKBOOK_ID]: 'mercadolivre',
}
const WORKBOOKS = Object.keys(MARKETPLACES)
const MARCADORES = WORKBOOKS.map(() => '?').join(',')

function ymd(sheetDate: string): string {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(sheetDate)
  return m ? `${m[3]}${m[2]}${m[1]}` : ''
}

function parseJson<T>(texto: string | null | undefined, padrao: T): T {
  if (!texto) return padrao
  try {
    return JSON.parse(texto) as T
  } catch {
    return padrao
  }
}

router.get('/ia/resumo', requireAuth, (_req, res) => {
  res.json({ ok: true, relatorio: resumoRelatorio() })
})

/** Datas (DD-MM-YYYY) com pedidos que têm peças — mais recente primeiro. */
router.get('/ia/datas', requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT o.sheet_date AS data FROM orders o
        WHERE o.workbook_id IN (${MARCADORES}) AND o.sheet_date != ''
          AND EXISTS (SELECT 1 FROM order_pieces p WHERE p.workbook_id = o.workbook_id AND p.order_key = o.order_key)`,
    )
    .all(...WORKBOOKS) as Array<{ data: string }>
  const datas = rows
    .map((r) => r.data)
    .filter((d) => ymd(d))
    .sort((a, b) => ymd(b).localeCompare(ymd(a)))
    .slice(0, 45)
  res.json({ ok: true, datas })
})

interface LinhaPedido {
  workbook_id: string
  order_key: string
  row_json: string
  parent_key: string | null
  product_image_url: string
}

/** GET /ia/pedidos?data=DD-MM-YYYY — o que o operador fez em cada pedido do dia. */
router.get('/ia/pedidos', requireAuth, (req, res) => {
  const data = typeof req.query.data === 'string' ? req.query.data.trim() : ''
  if (!ymd(data)) {
    res.status(400).json({ error: 'data inválida (DD-MM-YYYY)' })
    return
  }
  const pedidos = db
    .prepare(
      `SELECT o.workbook_id, o.order_key, o.row_json, o.parent_key, o.product_image_url
         FROM orders o
        WHERE o.workbook_id IN (${MARCADORES}) AND o.sheet_date = ?
          AND EXISTS (SELECT 1 FROM order_pieces p WHERE p.workbook_id = o.workbook_id AND p.order_key = o.order_key)
        ORDER BY o.workbook_id, o.position
        LIMIT 400`,
    )
    .all(...WORKBOOKS, data) as LinhaPedido[]

  const ajustes = db.prepare('SELECT slot, ajuste_json, u_width, origem_url FROM piece_images WHERE piece_id = ?')

  const itens = pedidos.map((o) => {
    const cells = parseJson<string[]>(o.row_json, [])
    const pecas = listPieces(o.workbook_id, o.order_key).map((p) => {
      const porSlot = new Map(
        (ajustes.all(p.id) as Array<{ slot: number; ajuste_json: string; u_width: number | null; origem_url: string }>).map(
          (a) => [a.slot, a],
        ),
      )
      const fotos = ([1, 2] as const)
        .filter((slot) => p.photos[slot])
        .map((slot) => {
          const a = porSlot.get(slot)
          const pendente = p.pendingUrls[slot]
          const v = p.fotosUpdatedAt[slot]
          const composta = p.compostas[slot]
          return {
            slot,
            formato: p.crops[slot],
            url: pendente ?? `/api/pieces/${p.id}/photo/${slot}${v ? `?v=${v}` : ''}`,
            compostaUrl: composta ? `/api/pieces/${p.id}/photo/${slot}/composta?v=${composta}` : null,
            ajuste: a?.ajuste_json ? parseJson<Record<string, unknown>>(a.ajuste_json, {}) : null,
            uWidth: a?.u_width ?? null,
            origem: pendente || a?.origem_url ? 'chat' : 'upload',
          }
        })
      return {
        id: p.id,
        seq: p.seq,
        molde: p.molde,
        tipo: p.tipo,
        cor: p.cor,
        emoji1: p.emoji1,
        emoji2: p.emoji2,
        origem: p.source,
        fotos,
      }
    })
    return {
      marketplace: MARKETPLACES[o.workbook_id] ?? o.workbook_id,
      workbookId: o.workbook_id,
      orderKey: o.order_key,
      filha: Boolean(o.parent_key),
      pedido: cells[MP_COL_ORDER_ID] ?? '',
      produto: cells[MP_COL_PRODUCT] ?? '',
      modelo: cells[MP_COL_MODEL] ?? '',
      qtd: cells[MP_COL_QTY] ?? '',
      cliente: cells[MP_COL_USERNAME] ?? '',
      status: cells[MP_COL_INTERNAL_STATUS] ?? '',
      statusCanal: cells[MP_COL_MARKETPLACE_STATUS] ?? '',
      fotoProduto: o.product_image_url || null,
      pecas,
      sugestao: null as null,
    }
  })
  res.json({ ok: true, data, pedidos: itens })
})

/** GET /ia/montagens?data=DD-MM-AAAA — o que a IA montou (ou por que pulou) em cada pedido. */
router.get('/ia/montagens', requireAuth, (req, res) => {
  const data = typeof req.query.data === 'string' ? req.query.data.trim() : ''
  res.json({ ok: true, execucoes: execucoesMontagem(), montagens: data ? montagensDoDia(data) : [] })
})

/** GET /ia/pendentes?data= — pedidos do dia sem arte feita (ninguém começou). */
router.get('/ia/pendentes', requireAuth, (req, res) => {
  const data = typeof req.query.data === 'string' ? req.query.data.trim() : ''
  res.json({ ok: true, pedidos: data ? pendentesDoDia(data) : [] })
})

/** GET /ia/conversa/:orderKey — peças + conversa recente do cliente. */
router.get('/ia/conversa/:orderKey', requireAuth, async (req, res) => {
  try {
    res.json({ ok: true, ...(await conversaDoPedido(req.params.orderKey)) })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

/** GET /ia/imagem?url=&w= — miniatura de uma imagem do chat. */
router.get('/ia/imagem', requireAuth, async (req, res) => {
  try {
    const url = String(req.query.url ?? '')
    const w = Math.min(1200, Math.max(64, Number(req.query.w) || 320))
    res.setHeader('content-type', 'image/jpeg')
    res.send(await miniaturaDoChat(url, w))
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

/** POST /ia/montar/:orderKey — monta o rascunho com a escolha dada (não gera prévia nem muda status). */
router.post('/ia/montar/:orderKey', requireAuth, async (req, res) => {
  try {
    res.json(await montarComEscolha(req.params.orderKey, req.body as EscolhaPedido))
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

/** GET /ia/relatorio?desde=&limite= — export do relatório de ajustes (só medidas) pro treino. */
router.get('/ia/relatorio', requireAuth, (req, res) => {
  const desde = Math.max(0, Number(req.query.desde) || 0)
  const limite = Math.min(5000, Math.max(1, Number(req.query.limite) || 1000))
  res.json({ ok: true, ...paginaRelatorio(desde, limite) })
})

/** GET /ia/modelo-enquadramento — métricas do modelo salvo (sem as árvores). */
router.get('/ia/modelo-enquadramento', requireAuth, (_req, res) => {
  const m = carregarModelo()
  res.json({ ok: true, existe: Boolean(m), ativo: process.env.IA_ENQUADRAMENTO === 'modelo', versao: m?.versao, criadoEm: m?.criadoEm, metricas: m?.metricas ?? null })
})

/** POST /ia/modelo-enquadramento — o job de treino grava o modelo novo (não liga sozinho). */
router.post('/ia/modelo-enquadramento', requireAuth, (req, res) => {
  try {
    salvarModelo(req.body as PacoteModelo)
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

export default router
