import { Router } from 'express'
import multer from 'multer'
import * as XLSX from 'xlsx'

import { auditSummary, queryAudit, recordAudit } from '../audit.js'
import { requireAuth } from '../auth.js'
import { db, nowMs } from '../db.js'
import { SHOPEE_COL_INTERNAL_STATUS, SHOPEE_COL_RECIPIENT } from '../shopee-columns.js'
import {
  isMaskedOrEmptyRecipient,
  reagruparLinhasDoPedido,
  shopeeOrderExists,
  upsertShopeeOrder,
  type ShopeeItemRow,
  type ShopeeOrderDetail,
} from '../shopee-order-sync.js'
import { SHOPEE_WORKBOOK_ID } from '../shopee-workbook.js'

const router = Router()

const uploadXlsx = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
})

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

/**
 * Ordem do fluxo de trabalho — usada só pra decidir qual status sobrevive quando as duas
 * linhas duplicadas discordam (o operador mexeu numa e a outra ficou pra trás).
 * `Editar` fica no topo de propósito: significa "cliente pediu correção", é o único estado
 * que exige ação humana e perdê-lo faria o pedido ser entregue errado.
 */
const ORDEM_STATUS = [
  '',
  'Sem fotos',
  'Cancelado',
  'Manual',
  'Separado',
  'Pronto',
  'Prévia',
  'Aprovado',
  'Em produção 1',
  'Em produção 2',
  'Em produção 3',
  'Editar',
]

function pesoStatus(s: string): number {
  const i = ORDEM_STATUS.indexOf((s || '').trim())
  return i < 0 ? 1 : i // status desconhecido: acima de vazio, abaixo do resto
}

interface LinhaReparo extends OrderLinha {
  updated_at: number
  pecas: number
  fotos: number
}

/**
 * POST /api/audit/reparar — conserta as linhas quebradas pelo bug da order_key com data
 * embutida (2026-07-28). Faz três coisas, nesta ordem:
 *   1. duplicata: mantém a linha que tem trabalho preso nela (peças/fotos; empate = mais
 *      recente) e apaga a irmã — herdando o status mais avançado das duas antes;
 *   2. data divergente: alinha a sheet_date das irmãs com a da 1ª ocorrência (a única key
 *      sem data embutida, portanto a única que o sync sempre mantém correta);
 *   3. desalinhada: reagrupa as linhas do pedido, tirando outros pedidos do meio.
 *
 * DRY-RUN por padrão — só executa com `?aplicar=1`. A linha apagada vai inteira pro
 * audit_log antes do DELETE (é a única chance de reconstruir).
 *
 * ⚠️ `order_pieces` tem ON DELETE CASCADE: apagar a linha errada levaria junto as peças e
 * as fotos do chat. Por isso a escolha do sobrevivente olha peças/fotos antes de qualquer
 * outro critério, e nunca desempata por ordem alfabética da key.
 */
router.post('/audit/reparar', requireAuth, (req, res) => {
  const workbookId = typeof req.query.workbookId === 'string' ? req.query.workbookId : SHOPEE_WORKBOOK_ID
  const aplicar = req.query.aplicar === '1' || req.query.aplicar === 'true'

  const linhas = db
    .prepare(
      `SELECT o.order_key, o.id, o.row_json, o.sheet_date, o.position, o.updated_at,
              (SELECT COUNT(*) FROM order_pieces p
                WHERE p.workbook_id = o.workbook_id AND p.order_key = o.order_key) AS pecas,
              (SELECT COUNT(*) FROM piece_images pi
                 INNER JOIN order_pieces p2 ON p2.id = pi.piece_id
                WHERE p2.workbook_id = o.workbook_id AND p2.order_key = o.order_key) AS fotos
         FROM orders o WHERE o.workbook_id = ? ORDER BY o.position`,
    )
    .all(workbookId) as LinhaReparo[]

  const porPedido = new Map<string, LinhaReparo[]>()
  for (const l of linhas) {
    const lista = porPedido.get(l.id) ?? []
    lista.push(l)
    porPedido.set(l.id, lista)
  }

  const acoes: Array<Record<string, unknown>> = []
  /** Keys removidas nesta execução — as etapas seguintes precisam ignorá-las. */
  const removidas = new Set<string>()

  for (const [orderSn, lista] of porPedido) {
    if (lista.length < 2) continue

    const porOccurrence = new Map<number, LinhaReparo[]>()
    for (const l of lista) {
      const occ = occurrenceDaKey(l.order_key, orderSn)
      if (occ == null) continue
      const g = porOccurrence.get(occ) ?? []
      g.push(l)
      porOccurrence.set(occ, g)
    }

    for (const [occ, grupo] of porOccurrence) {
      if (grupo.length < 2) continue
      // Sobrevivente: mais peças > mais fotos > mexida mais recente.
      const ordenado = [...grupo].sort(
        (a, b) => b.pecas - a.pecas || b.fotos - a.fotos || b.updated_at - a.updated_at,
      )
      const vencedora = ordenado[0]
      const perdedoras = ordenado.slice(1)

      const statusVencedor = [...grupo]
        .map((l) => String((JSON.parse(l.row_json) as string[])[SHOPEE_COL_INTERNAL_STATUS] ?? ''))
        .sort((a, b) => pesoStatus(b) - pesoStatus(a))[0]

      const rowAtual = JSON.parse(vencedora.row_json) as string[]
      const statusAtual = String(rowAtual[SHOPEE_COL_INTERNAL_STATUS] ?? '')
      const mudaStatus = statusVencedor !== statusAtual

      acoes.push({
        tipo: 'duplicata',
        orderSn,
        occurrence: occ,
        mantem: { key: vencedora.order_key, pecas: vencedora.pecas, fotos: vencedora.fotos },
        apaga: perdedoras.map((l) => ({ key: l.order_key, pecas: l.pecas, fotos: l.fotos })),
        statusDe: statusAtual,
        statusPara: statusVencedor,
      })

      for (const l of perdedoras) removidas.add(l.order_key)

      if (aplicar) {
        recordAudit({
          source: 'api',
          event: 'reparo.duplicata',
          level: 'warn',
          workbookId,
          orderSn,
          detail: {
            mantida: vencedora.order_key,
            apagadas: perdedoras.map((l) => ({
              key: l.order_key,
              row: JSON.parse(l.row_json) as unknown,
              sheetDate: l.sheet_date,
              position: l.position,
              pecas: l.pecas,
              fotos: l.fotos,
            })),
            statusDe: statusAtual,
            statusPara: statusVencedor,
          },
        })
        db.transaction(() => {
          if (mudaStatus) {
            rowAtual[SHOPEE_COL_INTERNAL_STATUS] = statusVencedor
            db.prepare('UPDATE orders SET row_json = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?')
              .run(JSON.stringify(rowAtual), nowMs(), workbookId, vencedora.order_key)
          }
          for (const l of perdedoras) {
            db.prepare('DELETE FROM orders WHERE workbook_id = ? AND order_key = ?')
              .run(workbookId, l.order_key)
          }
        })()
      }
    }
  }

  // Datas divergentes: a 1ª ocorrência (key = só o orderSn) é a referência confiável.
  for (const [orderSn, lista] of porPedido) {
    if (lista.length < 2) continue
    const primeira = lista.find((l) => l.order_key === orderSn)
    if (!primeira) continue
    const fora = lista.filter(
      (l) => l.order_key !== orderSn && l.sheet_date !== primeira.sheet_date && !removidas.has(l.order_key),
    )
    if (fora.length === 0) continue
    acoes.push({
      tipo: 'data',
      orderSn,
      para: primeira.sheet_date,
      linhas: fora.map((l) => ({ key: l.order_key, de: l.sheet_date })),
    })
    if (aplicar) {
      for (const l of fora) {
        db.prepare('UPDATE orders SET sheet_date = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?')
          .run(primeira.sheet_date, nowMs(), workbookId, l.order_key)
      }
    }
  }

  // Reagrupamento: só faz sentido depois dos deletes/updates acima.
  if (aplicar) {
    for (const orderSn of porPedido.keys()) {
      const movidas = reagruparLinhasDoPedido(orderSn, workbookId)
      if (movidas > 0) acoes.push({ tipo: 'reagrupou', orderSn, linhasMovidas: movidas })
    }
  } else {
    for (const [orderSn, lista] of porPedido) {
      if (lista.length < 2) continue
      const pos = lista.map((l) => l.position).sort((a, b) => a - b)
      if (pos[pos.length - 1] - pos[0] !== pos.length - 1) {
        acoes.push({ tipo: 'reagruparia', orderSn, posicoes: pos })
      }
    }
  }

  res.json({
    ok: true,
    aplicado: aplicar,
    workbookId,
    totalAcoes: acoes.length,
    acoes,
    aviso: aplicar ? undefined : 'DRY-RUN — nada foi alterado. Repita com ?aplicar=1 pra executar.',
  })
})

/**
 * POST /api/audit/renomear-keys — tira a data de dentro da identidade da linha.
 *
 * `{data}__{pedido}__{N}` → `{pedido}#{N}`. A data ali dentro nunca identificou nada: quem
 * filtra por data é a coluna `sheet_date`. Ela só congelava o valor de quando a linha
 * nasceu e, ao mudar, fazia o upsert não reconhecer a linha e criar uma duplicata.
 *
 * A key é referenciada em `order_pieces`, `images` e `parse_issues` — renomear só em
 * `orders` órfanaria as peças e as fotos do picker. Tudo é atualizado na mesma transação,
 * e um `foreign_key_check` no fim prova que não sobrou referência quebrada.
 *
 * DRY-RUN por padrão; executa com `?aplicar=1`.
 */
router.post('/audit/renomear-keys', requireAuth, (req, res) => {
  const workbookId = typeof req.query.workbookId === 'string' ? req.query.workbookId : SHOPEE_WORKBOOK_ID
  const aplicar = req.query.aplicar === '1' || req.query.aplicar === 'true'

  // ESCAPE '\' é OBRIGATÓRIO: sem ele o SQLite trata a barra como caractere literal e o
  // padrão vira "procure barras de verdade na key" — não casa com nada e a migração vira
  // um no-op silencioso. Mesma armadilha que deixou o fix da duplicação inerte.
  const linhas = db
    .prepare("SELECT order_key, id FROM orders WHERE workbook_id = ? AND order_key LIKE ? ESCAPE '\\'")
    .all(workbookId, '%\\_\\_%') as Array<{ order_key: string; id: string }>

  const planos: Array<{ de: string; para: string; pecas: number; fotos: number; issues: number }> = []
  const colisoes: Array<{ de: string; para: string }> = []

  for (const l of linhas) {
    const occ = occurrenceDaKey(l.order_key, l.id)
    if (occ == null || occ === 1) continue // key fora do padrão: não é da migração
    const nova = `${l.id}#${occ}`
    if (nova === l.order_key) continue

    const ocupada = db
      .prepare('SELECT 1 FROM orders WHERE workbook_id = ? AND order_key = ?')
      .get(workbookId, nova)
    if (ocupada) {
      // Duas linhas cairiam no mesmo nome — é duplicata não resolvida. Renomear aqui
      // perderia uma delas; o reparo (/audit/reparar) tem que rodar antes.
      colisoes.push({ de: l.order_key, para: nova })
      continue
    }

    const conta = (sql: string, ...p: unknown[]) =>
      (db.prepare(sql).get(...p) as { n: number }).n
    planos.push({
      de: l.order_key,
      para: nova,
      pecas: conta('SELECT COUNT(*) AS n FROM order_pieces WHERE workbook_id = ? AND order_key = ?', workbookId, l.order_key),
      fotos: conta(
        `SELECT COUNT(*) AS n FROM piece_images pi
           INNER JOIN order_pieces p ON p.id = pi.piece_id
          WHERE p.workbook_id = ? AND p.order_key = ?`,
        workbookId,
        l.order_key,
      ),
      issues: conta('SELECT COUNT(*) AS n FROM parse_issues WHERE workbook_id = ? AND order_key = ?', workbookId, l.order_key),
    })
  }

  let integridade: unknown[] = []
  if (aplicar && planos.length > 0) {
    // A FK images→orders(order_key) é ON DELETE CASCADE e não tem ON UPDATE: com as FKs
    // ligadas, renomear o pai seria recusado. Desliga só durante a transação (mesmo
    // recurso já usado na migração de schema) e confere a integridade logo depois.
    db.pragma('foreign_keys = OFF')
    try {
      db.transaction(() => {
        for (const p of planos) {
          db.prepare('UPDATE orders SET order_key = ? WHERE workbook_id = ? AND order_key = ?')
            .run(p.para, workbookId, p.de)
          db.prepare('UPDATE orders SET parent_key = ? WHERE workbook_id = ? AND parent_key = ?')
            .run(p.para, workbookId, p.de)
          db.prepare('UPDATE order_pieces SET order_key = ? WHERE workbook_id = ? AND order_key = ?')
            .run(p.para, workbookId, p.de)
          db.prepare('UPDATE images SET order_id = ? WHERE workbook_id = ? AND order_id = ?')
            .run(p.para, workbookId, p.de)
          db.prepare('UPDATE parse_issues SET order_key = ? WHERE workbook_id = ? AND order_key = ?')
            .run(p.para, workbookId, p.de)
        }
      })()
    } finally {
      db.pragma('foreign_keys = ON')
    }
    integridade = db.pragma('foreign_key_check') as unknown[]
    recordAudit({
      source: 'api',
      event: 'keys.renomeadas',
      level: 'warn',
      workbookId,
      detail: { total: planos.length, planos, integridadeQuebrada: integridade },
    })
  }

  res.json({
    ok: true,
    aplicado: aplicar,
    totalRenomear: planos.length,
    planos,
    colisoes,
    // Vazio = nenhuma referência ficou apontando pra key que não existe mais.
    integridade,
    aviso: colisoes.length
      ? 'Há keys que colidiriam: rode POST /audit/reparar antes.'
      : aplicar
        ? undefined
        : 'DRY-RUN — nada foi alterado. Repita com ?aplicar=1 pra executar.',
  })
})

/**
 * POST /api/audit/marcar-filhas — passo 5: aplica o agrupamento pai/filha aos pedidos que
 * já existiam antes dele.
 *
 * Não apaga, não move, não muda status: só preenche `parent_key` na 2ª linha em diante de
 * cada pedido multi-linha, que é o que faz o grid desenhar o `↳` e a numeração contar
 * pedidos em vez de linhas. Ficou barato porque o reparo já deixou tudo íntegro — sem
 * duplicata nem linha fora de ordem, "quem é a 1ª linha" é uma pergunta sem ambiguidade.
 *
 * A quantidade NÃO é explodida aqui: pedido antigo com Qnt=5 numa linha continua assim.
 * Explodir mexeria em pedido publicado, criando 4 linhas do nada em coisa já entregue.
 *
 * DRY-RUN por padrão; executa com `?aplicar=1`.
 */
router.post('/audit/marcar-filhas', requireAuth, (req, res) => {
  const workbookId = typeof req.query.workbookId === 'string' ? req.query.workbookId : SHOPEE_WORKBOOK_ID
  const aplicar = req.query.aplicar === '1' || req.query.aplicar === 'true'

  const linhas = db
    .prepare(
      `SELECT order_key, id, position, parent_key, row_json FROM orders
        WHERE workbook_id = ? ORDER BY position`,
    )
    .all(workbookId) as Array<{
      order_key: string
      id: string
      position: number
      parent_key: string | null
      row_json: string
    }>

  const porPedido = new Map<string, typeof linhas>()
  for (const l of linhas) {
    const lista = porPedido.get(l.id) ?? []
    lista.push(l)
    porPedido.set(l.id, lista)
  }

  const marcar: Array<{ orderSn: string; pai: string; filhas: string[]; cliente: string }> = []
  const naoContiguos: string[] = []

  for (const [orderSn, lista] of porPedido) {
    if (lista.length < 2) continue
    const jaMarcado = lista.slice(1).every((l) => l.parent_key === lista[0].order_key)
    if (jaMarcado) continue

    // Contiguidade é pré-requisito: com outro pedido no meio, "a 1ª linha" seria arbitrária.
    const pos = lista.map((l) => l.position)
    if (Math.max(...pos) - Math.min(...pos) !== lista.length - 1) {
      naoContiguos.push(orderSn)
      continue
    }

    const row = JSON.parse(lista[0].row_json || '[]') as string[]
    marcar.push({
      orderSn,
      pai: lista[0].order_key,
      filhas: lista.slice(1).map((l) => l.order_key),
      cliente: row[4] ?? '',
    })
  }

  if (aplicar && marcar.length > 0) {
    const upd = db.prepare('UPDATE orders SET parent_key = ? WHERE workbook_id = ? AND order_key = ?')
    db.transaction(() => {
      for (const m of marcar) {
        // A linha-pai fica explicitamente sem pai (NULL) — pedido que já tenha sido marcado
        // errado antes volta ao estado certo em vez de acumular.
        upd.run(null, workbookId, m.pai)
        for (const f of m.filhas) upd.run(m.pai, workbookId, f)
      }
      db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(nowMs(), workbookId)
    })()
    recordAudit({
      source: 'api',
      event: 'filhas.marcadas',
      level: 'warn',
      workbookId,
      detail: { pedidos: marcar.length, linhas: marcar.reduce((n, m) => n + m.filhas.length, 0), marcar },
    })
  }

  res.json({
    ok: true,
    aplicado: aplicar,
    pedidosParaMarcar: marcar.length,
    linhasQueViramFilhas: marcar.reduce((n, m) => n + m.filhas.length, 0),
    marcar,
    // Pedido com outro no meio: o reparo junta primeiro, senão a 1ª linha é chute.
    naoContiguos,
    aviso: naoContiguos.length
      ? 'Há pedidos com linhas separadas: rode POST /audit/reparar antes.'
      : aplicar
        ? undefined
        : 'DRY-RUN — nada foi alterado. Repita com ?aplicar=1 pra executar.',
  })
})

/**
 * POST /api/audit/explodir-quantidade — aplica a explosão de quantidade aos pedidos que já
 * existiam antes dela.
 *
 * "5× M MASCULINO" numa linha com Qnt=5 vira 5 linhas de Qnt=1 (a original + 4 filhas),
 * porque são 5 artes a imprimir: com uma linha só, a planilha conta 1 e a produção precisa
 * de 5. Caso real que motivou: adrielegiyuri, 5 shorts em 1 linha (2026-07-28).
 *
 * As linhas novas nascem SEM prévia e SEM peça — cada uma precisa passar pelo picker. O
 * status é copiado da original pra não deixar o pedido com status divergente entre linhas
 * (é o que a propagação espera); as colunas de foto vazias é que mostram o que falta.
 *
 * Por padrão ignora Cancelado/Concluído — explodir pedido morto só polui a planilha.
 * DRY-RUN por padrão; executa com `?aplicar=1`. `?incluirEncerrados=1` pega todos.
 */
router.post('/audit/explodir-quantidade', requireAuth, (req, res) => {
  const workbookId = typeof req.query.workbookId === 'string' ? req.query.workbookId : SHOPEE_WORKBOOK_ID
  const aplicar = req.query.aplicar === '1' || req.query.aplicar === 'true'
  const incluirEncerrados = req.query.incluirEncerrados === '1'
  // Sem filtro, a rota acha pedido de QUALQUER data — inclusive resíduo antigo com
  // status vazio (nunca entrou no fluxo). ?orderSn=a,b restringe a pedidos específicos,
  // pro operador aplicar só onde já confirmou que é caso de verdade.
  const somenteOrderSn = typeof req.query.orderSn === 'string'
    ? new Set(req.query.orderSn.split(',').map((s) => s.trim()).filter(Boolean))
    : null
  const ENCERRADOS = new Set(['Cancelado', 'Concluído'])
  const COL_QTD = 3

  interface Linha {
    order_key: string
    id: string
    row_json: string
    sheet_date: string
    position: number
    parent_key: string | null
    product_image_url: string
  }
  const todas = db
    .prepare(
      `SELECT order_key, id, row_json, sheet_date, position, parent_key, product_image_url
         FROM orders WHERE workbook_id = ? ORDER BY position`,
    )
    .all(workbookId) as Linha[]

  const planos: Array<{
    orderSn: string
    cliente: string
    linha: string
    quantidade: number
    novasLinhas: string[]
    status: string
    /** Peças já existentes na linha (de antes da explosão) que serão MOVIDAS pras
     *  linhas novas, 1 por peça — preserva foto/ajuste já feitos. */
    pecasRedistribuidas: Array<{ pieceId: number; para: string }>
  }> = []

  for (const l of todas) {
    if (somenteOrderSn && !somenteOrderSn.has(l.id)) continue
    const row = JSON.parse(l.row_json || '[]') as string[]
    const qtd = Number(String(row[COL_QTD] ?? '').trim())
    if (!Number.isInteger(qtd) || qtd < 2) continue
    const status = String(row[SHOPEE_COL_INTERNAL_STATUS] ?? '')
    if (!incluirEncerrados && ENCERRADOS.has(status)) continue

    // Numeração continua de onde o pedido parou, pra não colidir com irmã existente.
    const usados = todas
      .filter((x) => x.id === l.id)
      .map((x) => occurrenceDaKey(x.order_key, x.id) ?? 0)
    let proxima = Math.max(1, ...usados) + 1
    const novas: string[] = []
    for (let i = 1; i < qtd; i++) novas.push(`${l.id}#${proxima++}`)

    /**
     * A linha pode já ter peças cadastradas de ANTES da explosão existir — era o jeito
     * de controlar cada unidade dentro de uma linha só (adicionar peça na mão pra cada
     * uma das N compradas). Se a contagem bate exato com a quantidade, cada peça extra
     * (a partir da 2ª) é MOVIDA pra uma linha nova — preserva a foto/ajuste já feito.
     * Se não bater, não mexe: cada linha nova auto-deriva sozinha ao abrir o picker
     * (comportamento de sempre), e o operador ajusta cada uma do zero.
     * Caso real que expôs isso: adrielegiyuri, 5 peças com foto na linha única —
     * sem isso, a explosão deixava as 5 presas na linha-pai e cada filha nascia com
     * uma peça VAZIA duplicada (2026-07-29).
     */
    const pecasExistentes = db
      .prepare('SELECT id FROM order_pieces WHERE workbook_id = ? AND order_key = ? ORDER BY seq')
      .all(workbookId, l.order_key) as Array<{ id: number }>
    const pecasRedistribuidas =
      pecasExistentes.length === qtd
        ? pecasExistentes.slice(1).map((p, i) => ({ pieceId: p.id, para: novas[i] }))
        : []

    planos.push({
      orderSn: l.id,
      cliente: row[4] ?? '',
      linha: l.order_key,
      quantidade: qtd,
      novasLinhas: novas,
      status,
      pecasRedistribuidas,
    })
  }

  if (aplicar && planos.length > 0) {
    const now = nowMs()
    db.transaction(() => {
      for (const p of planos) {
        const original = todas.find((x) => x.order_key === p.linha)!
        const row = JSON.parse(original.row_json) as string[]
        row[COL_QTD] = '1'
        db.prepare('UPDATE orders SET row_json = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?')
          .run(JSON.stringify(row), now, workbookId, p.linha)

        // Filha de filha não existe: se a original já é filha, as novas penduram no mesmo pai.
        const chavePai = original.parent_key ?? original.order_key
        // Entram logo abaixo da última linha do pedido, empurrando o resto — as linhas de
        // um pedido têm que ficar contíguas pra "a 1ª linha" não virar loteria.
        const ultima = Math.max(
          ...todas.filter((x) => x.id === p.orderSn).map((x) => x.position),
        )
        db.prepare('UPDATE orders SET position = position + ? WHERE workbook_id = ? AND position > ?')
          .run(p.novasLinhas.length, workbookId, ultima)

        p.novasLinhas.forEach((chave, i) => {
          db.prepare(
            `INSERT INTO orders (workbook_id, order_key, id, row_json, styles_json, disappeared,
                                 sheet_date, product_image_url, position, updated_at, parent_key)
             VALUES (?, ?, ?, ?, '{}', 0, ?, ?, ?, ?, ?)`,
          ).run(
            workbookId,
            chave,
            p.orderSn,
            JSON.stringify(row), // já com Qnt=1; sem imagem, porque prévia é por peça
            original.sheet_date,
            original.product_image_url,
            ultima + 1 + i,
            now,
            chavePai,
          )
        })

        for (const r of p.pecasRedistribuidas) {
          db.prepare('UPDATE order_pieces SET order_key = ?, seq = 1, updated_at = ? WHERE id = ?')
            .run(r.para, now, r.pieceId)
        }
      }
      db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
    })()
    recordAudit({
      source: 'api',
      event: 'quantidade.explodida',
      level: 'warn',
      workbookId,
      detail: { pedidos: planos.length, linhasCriadas: planos.reduce((n, p) => n + p.novasLinhas.length, 0), planos },
    })
  }

  res.json({
    ok: true,
    aplicado: aplicar,
    pedidos: planos.length,
    linhasQueSeraoCriadas: planos.reduce((n, p) => n + p.novasLinhas.length, 0),
    planos,
    aviso: aplicar
      ? 'As linhas novas nascem sem prévia — cada uma precisa passar pelo picker.'
      : 'DRY-RUN — nada foi alterado. Repita com ?aplicar=1 pra executar.',
  })
})

/**
 * POST /api/audit/recuperar-destinatario — restaura o nome do destinatário (col G) mascarado
 * pela Shopee ("H******a", "****", desde 2026-07-24) usando o próprio audit_log: acha, por
 * pedido, o registro mais recente de `order.atualizada` cujo `rowAntes`/`rowDepois` ainda tinha
 * o nome de verdade, e devolve pra linha atual.
 *
 * Só recupera pedido que (a) está com nome mascarado/vazio HOJE e (b) tem algum nome de
 * verdade registrado no log. Pedido que já nasceu mascarado antes do audit_log existir
 * (2026-07-28) fica de fora — o nome real nunca foi gravado em lugar nenhum do nosso lado.
 *
 * DRY-RUN por padrão; executa com `?aplicar=1`.
 */
router.post('/audit/recuperar-destinatario', requireAuth, (req, res) => {
  const workbookId = typeof req.query.workbookId === 'string' ? req.query.workbookId : SHOPEE_WORKBOOK_ID

  const aplicar = req.query.aplicar === '1' || req.query.aplicar === 'true'

  const eventos = db
    .prepare(
      `SELECT order_key, detail_json, at FROM audit_log
        WHERE event = 'order.atualizada' AND workbook_id = ? ORDER BY at ASC`,
    )
    .all(workbookId) as Array<{ order_key: string | null; detail_json: string; at: number }>

  const melhorNome = new Map<string, { nome: string; at: number }>()
  for (const ev of eventos) {
    if (!ev.order_key) continue
    let detail: { rowAntes?: string[]; rowDepois?: string[] }
    try {
      detail = JSON.parse(ev.detail_json)
    } catch {
      continue
    }
    for (const row of [detail.rowAntes, detail.rowDepois]) {
      const nome = row?.[SHOPEE_COL_RECIPIENT]
      if (nome && !isMaskedOrEmptyRecipient(nome)) {
        const atual = melhorNome.get(ev.order_key)
        if (!atual || ev.at >= atual.at) melhorNome.set(ev.order_key, { nome, at: ev.at })
      }
    }
  }

  const linhas = db
    .prepare('SELECT order_key, row_json FROM orders WHERE workbook_id = ?')
    .all(workbookId) as Array<{ order_key: string; row_json: string }>

  const planos: Array<{ orderKey: string; de: string; para: string }> = []
  for (const l of linhas) {
    const row = JSON.parse(l.row_json) as string[]
    const nomeAtual = row[SHOPEE_COL_RECIPIENT] ?? ''
    if (!isMaskedOrEmptyRecipient(nomeAtual)) continue
    const achado = melhorNome.get(l.order_key)
    if (!achado) continue
    planos.push({ orderKey: l.order_key, de: nomeAtual, para: achado.nome })
  }

  if (aplicar && planos.length > 0) {
    const now = nowMs()
    const upd = db.prepare('UPDATE orders SET row_json = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?')
    db.transaction(() => {
      for (const p of planos) {
        const linha = linhas.find((l) => l.order_key === p.orderKey)!
        const row = JSON.parse(linha.row_json) as string[]
        row[SHOPEE_COL_RECIPIENT] = p.para
        upd.run(JSON.stringify(row), now, workbookId, p.orderKey)
      }
      db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
    })()
    recordAudit({
      source: 'api',
      event: 'destinatario.recuperado',
      level: 'warn',
      workbookId,
      detail: { total: planos.length, planos },
    })
  }

  res.json({
    ok: true,
    aplicado: aplicar,
    workbookId,
    totalRecuperaveis: planos.length,
    planos,
    aviso: aplicar
      ? undefined
      : 'DRY-RUN — nada foi alterado. Repita com ?aplicar=1 pra executar.',
  })
})

function normalizeHeader(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
}

const XLSX_COL_ID = normalizeHeader('ID do pedido')
const XLSX_COL_STATUS = normalizeHeader('Status do pedido')
const XLSX_COL_NOME = normalizeHeader('Nome do destinatário')

/**
 * POST /api/audit/importar-nomes-xlsx — recupera o nome do destinatário (col G) mascarado
 * pela Shopee usando um export bruto do Seller Center (Pedidos > Exportar), que NÃO mascara
 * o nome — só a API pública mascara.
 *
 * Só considera linha do XLSX com "Status do pedido" == "A Enviar" (pedido usa esse export
 * justamente pra resolver pedidos presos em `****` que ainda vão ser enviados) e só sobrescreve
 * pedido que está com nome mascarado/vazio HOJE — nunca pisa em nome real já resolvido nem em
 * edição manual. Mexe única e exclusivamente na col G (SHOPEE_COL_RECIPIENT).
 *
 * DRY-RUN por padrão; executa com `?aplicar=1`.
 */
router.post('/audit/importar-nomes-xlsx', requireAuth, uploadXlsx.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ ok: false, error: 'Envie o arquivo XLSX no campo "file".' })
    return
  }

  const workbookId = typeof req.query.workbookId === 'string' ? req.query.workbookId : SHOPEE_WORKBOOK_ID
  const aplicar = req.query.aplicar === '1' || req.query.aplicar === 'true'

  let rows: unknown[][]
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][]
  } catch {
    res.status(400).json({ ok: false, error: 'Não consegui ler o XLSX — arquivo corrompido ou formato inesperado.' })
    return
  }

  const header = (rows[0] ?? []).map((h) => normalizeHeader(String(h ?? '')))
  const idxId = header.indexOf(XLSX_COL_ID)
  const idxStatus = header.indexOf(XLSX_COL_STATUS)
  const idxNome = header.indexOf(XLSX_COL_NOME)
  if (idxId < 0 || idxStatus < 0 || idxNome < 0) {
    res.status(400).json({
      ok: false,
      error: 'XLSX não tem as colunas esperadas ("ID do pedido", "Status do pedido", "Nome do destinatário"). É o export de Pedidos do Seller Center?',
    })
    return
  }

  const nomeById = new Map<string, string>()
  let linhasAEnviar = 0
  for (const row of rows.slice(1)) {
    const status = String(row[idxStatus] ?? '').trim()
    if (status.toLowerCase() !== 'a enviar') continue
    linhasAEnviar++
    const id = String(row[idxId] ?? '').trim()
    const nome = String(row[idxNome] ?? '').trim()
    if (!id || isMaskedOrEmptyRecipient(nome)) continue
    if (!nomeById.has(id)) nomeById.set(id, nome)
  }

  // `id` é o order_sn cru da Shopee (coluna própria, distinta de order_key — que ganha sufixo
  // `#2`, `#3`... quando um pedido tem múltiplos itens). Casar por `id` em vez de derivar a
  // base a partir de order_key evita qualquer risco de parsing errado cair no pedido errado;
  // todas as linhas de um mesmo pedido (mesmo `id`) recebem o mesmo nome, que é o esperado.
  const linhas = db
    .prepare('SELECT order_key, id, row_json FROM orders WHERE workbook_id = ?')
    .all(workbookId) as Array<{ order_key: string; id: string; row_json: string }>

  const planos: Array<{ orderKey: string; de: string; para: string }> = []
  for (const l of linhas) {
    const row = JSON.parse(l.row_json) as string[]
    const nomeAtual = row[SHOPEE_COL_RECIPIENT] ?? ''
    if (!isMaskedOrEmptyRecipient(nomeAtual)) continue
    const achado = nomeById.get(l.id)
    if (!achado) continue
    planos.push({ orderKey: l.order_key, de: nomeAtual, para: achado })
  }

  if (aplicar && planos.length > 0) {
    const now = nowMs()
    const upd = db.prepare('UPDATE orders SET row_json = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?')
    db.transaction(() => {
      for (const p of planos) {
        const linha = linhas.find((l) => l.order_key === p.orderKey)!
        const row = JSON.parse(linha.row_json) as string[]
        row[SHOPEE_COL_RECIPIENT] = p.para
        upd.run(JSON.stringify(row), now, workbookId, p.orderKey)
      }
      db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
    })()
    recordAudit({
      source: 'api',
      event: 'destinatario.importado_xlsx',
      level: 'warn',
      workbookId,
      detail: { total: planos.length, arquivo: req.file.originalname, planos },
    })
  }

  res.json({
    ok: true,
    aplicado: aplicar,
    workbookId,
    linhasNoXlsx: rows.length - 1,
    linhasAEnviarNoXlsx: linhasAEnviar,
    nomesUtilizaveisNoXlsx: nomeById.size,
    totalRecuperaveis: planos.length,
    planos,
    aviso: aplicar
      ? undefined
      : 'DRY-RUN — nada foi alterado. Repita com ?aplicar=1 pra executar.',
  })
})

const XLSX_COL_SKU = normalizeHeader('Número de referência SKU')
const XLSX_COL_SKU_PRINCIPAL = normalizeHeader('Nº de referência do SKU principal')
const XLSX_COL_VARIACAO = normalizeHeader('Nome da variação')
const XLSX_COL_QTD = normalizeHeader('Quantidade')
const XLSX_COL_USERNAME = normalizeHeader('Nome de usuário (comprador)')
const XLSX_COL_SHIP_DATE = normalizeHeader('Data prevista de envio')

/** Status do Seller Center (PT) → enum da API Shopee, pra bater com o que o sync automático grava na col H. */
const XLSX_STATUS_MAP: Record<string, string> = {
  'nao pago': 'UNPAID',
  'a enviar': 'READY_TO_SHIP',
  processando: 'PROCESSED',
  enviado: 'SHIPPED',
  concluido: 'COMPLETED',
  cancelado: 'CANCELLED',
  'devolucao / reembolso': 'TO_RETURN',
  'devolucao/reembolso': 'TO_RETURN',
  'em disputa': 'IN_CANCEL',
}

/**
 * "Data prevista de envio" do export vem em texto local (BRT, sem timezone) — ex. "2026-08-14 08:46".
 * `upsertShopeeOrder` espera um unix timestamp e formata em America/Sao_Paulo (ver `resolveSheetDate`
 * em shopee-order-sync.ts), então somamos 3h pra reconstruir o instante UTC equivalente (Brasil não
 * observa horário de verão desde 2019 — sem essa soma o pedido podia cair no dia errado perto da
 * virada da meia-noite). String vazia/ilegível vira 0 → cai em "Sem data de envio", igual à API.
 */
function unixSecFromBrtDateString(s: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s.trim())
  if (!m) return 0
  const [, y, mo, d, hh, mi] = m
  return Math.floor(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh) + 3, Number(mi)) / 1000)
}

/**
 * POST /api/audit/importar-pedidos-xlsx — importa pedidos NOVOS e atualiza os já existentes
 * (nome do destinatário, status, itens) a partir do export bruto do Seller Center (Pedidos >
 * Exportar), pra usar como substituto manual do poll automático quando a API Shopee está fora
 * do ar (ex.: penalidade/bloqueio de app). Cada linha do XLSX é um item do pedido (mesmo formato
 * de `order.item_list`); pedidos com mais de uma unidade comprada do mesmo item OU múltiplos
 * itens diferentes são explodidos em sublinhas por `upsertShopeeOrder` — mesma lógica de sempre,
 * unidade por unidade (ver `mapShopeeOrderToUnitRows`).
 *
 * DRY-RUN por padrão (não escreve nada, só devolve o diagnóstico); executa com `?aplicar=1`.
 */
router.post('/audit/importar-pedidos-xlsx', requireAuth, uploadXlsx.single('file'), (req, res) => {
  if (!req.file) {
    res.status(400).json({ ok: false, error: 'Envie o arquivo XLSX no campo "file".' })
    return
  }

  const workbookId = typeof req.query.workbookId === 'string' ? req.query.workbookId : SHOPEE_WORKBOOK_ID
  const aplicar = req.query.aplicar === '1' || req.query.aplicar === 'true'

  let rows: unknown[][]
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }) as unknown[][]
  } catch {
    res.status(400).json({ ok: false, error: 'Não consegui ler o XLSX — arquivo corrompido ou formato inesperado.' })
    return
  }

  const header = (rows[0] ?? []).map((h) => normalizeHeader(String(h ?? '')))
  const idxId = header.indexOf(XLSX_COL_ID)
  const idxStatus = header.indexOf(XLSX_COL_STATUS)
  const idxNome = header.indexOf(XLSX_COL_NOME)
  const idxSku = header.indexOf(XLSX_COL_SKU) >= 0 ? header.indexOf(XLSX_COL_SKU) : header.indexOf(XLSX_COL_SKU_PRINCIPAL)
  const idxVariacao = header.indexOf(XLSX_COL_VARIACAO)
  const idxQtd = header.indexOf(XLSX_COL_QTD)
  const idxUsername = header.indexOf(XLSX_COL_USERNAME)
  const idxShipDate = header.indexOf(XLSX_COL_SHIP_DATE)
  if (idxId < 0 || idxStatus < 0 || idxNome < 0 || idxSku < 0 || idxQtd < 0) {
    res.status(400).json({
      ok: false,
      error: 'XLSX não tem as colunas esperadas do export de Pedidos do Seller Center (ID do pedido, Status do pedido, Nome do destinatário, Número de referência SKU, Quantidade).',
    })
    return
  }

  // agrupa linhas por pedido, preservando a ordem de 1ª aparição no arquivo
  const ordemPedidos: string[] = []
  const linhasPorPedido = new Map<string, unknown[][]>()
  for (const row of rows.slice(1)) {
    const id = String(row[idxId] ?? '').trim()
    if (!id) continue
    if (!linhasPorPedido.has(id)) {
      linhasPorPedido.set(id, [])
      ordemPedidos.push(id)
    }
    linhasPorPedido.get(id)!.push(row)
  }

  const statusNaoMapeados = new Map<string, number>()
  const pedidos: ShopeeOrderDetail[] = []
  for (const id of ordemPedidos) {
    const linhas = linhasPorPedido.get(id)!
    const primeira = linhas[0]
    const statusBruto = String(primeira[idxStatus] ?? '').trim()
    const statusNorm = normalizeHeader(statusBruto)
    const status = XLSX_STATUS_MAP[statusNorm]
    if (!status) statusNaoMapeados.set(statusBruto, (statusNaoMapeados.get(statusBruto) ?? 0) + 1)

    const item_list: ShopeeItemRow[] = linhas.map((row) => ({
      item_sku: String(row[idxSku] ?? '').trim(),
      model_sku: String(row[idxSku] ?? '').trim(),
      model_name: idxVariacao >= 0 ? String(row[idxVariacao] ?? '').trim() : '',
      model_quantity_purchased: Number(row[idxQtd]) || 1,
    }))

    pedidos.push({
      order_sn: id,
      order_status: status ?? statusBruto,
      buyer_username: idxUsername >= 0 ? String(primeira[idxUsername] ?? '').trim() : '',
      ship_by_date: idxShipDate >= 0 ? unixSecFromBrtDateString(String(primeira[idxShipDate] ?? '')) : 0,
      recipient_address: { name: String(primeira[idxNome] ?? '').trim() },
      item_list,
    })
  }

  const novos = pedidos.filter((p) => !shopeeOrderExists(p.order_sn!, workbookId))
  const multiplasLinhas = pedidos.filter((p) => (p.item_list?.length ?? 0) > 1)
  const unidadesExplodidas = pedidos.filter((p) => (p.item_list ?? []).some((i) => (i.model_quantity_purchased ?? 1) > 1))

  if (!aplicar) {
    res.json({
      ok: true,
      aplicado: false,
      workbookId,
      totalPedidosNoXlsx: pedidos.length,
      pedidosNovos: novos.length,
      idsNovos: novos.slice(0, 50).map((p) => p.order_sn),
      pedidosJaExistentes: pedidos.length - novos.length,
      pedidosComMultiplosItens: multiplasLinhas.length,
      pedidosComAlgumaUnidadeMultipla: unidadesExplodidas.length,
      statusNaoMapeados: Object.fromEntries(statusNaoMapeados),
      amostraExplosao: [...multiplasLinhas, ...unidadesExplodidas]
        .filter((p, i, arr) => arr.indexOf(p) === i)
        .slice(0, 5)
        .map((p) => ({
          orderSn: p.order_sn,
          itens: p.item_list?.map((i) => ({ sku: i.item_sku, variacao: i.model_name, qtd: i.model_quantity_purchased })),
          unidadesQueSeriamCriadas: p.item_list?.reduce((s, i) => s + Math.max(1, i.model_quantity_purchased ?? 1), 0),
        })),
      aviso: 'DRY-RUN — nada foi alterado. Repita com ?aplicar=1 pra executar.',
    })
    return
  }

  const runId = `xlsx-${nowMs()}`
  let created = 0
  let updated = 0
  let unchanged = 0
  const errors: string[] = []
  for (const pedido of pedidos) {
    try {
      const acao = upsertShopeeOrder(pedido, workbookId, { source: 'manual', runId, rotina: 'importarPedidosXlsx' })
      if (acao === 'created') created++
      else if (acao === 'updated') updated++
      else unchanged++
    } catch (error) {
      errors.push(`${pedido.order_sn}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  recordAudit({
    source: 'manual',
    runId,
    workbookId,
    event: 'import.xlsx_pedidos',
    level: errors.length > 0 ? 'warn' : 'info',
    detail: { arquivo: req.file.originalname, totalPedidosNoXlsx: pedidos.length, created, updated, unchanged, errors },
  })

  res.json({
    ok: true,
    aplicado: true,
    workbookId,
    totalPedidosNoXlsx: pedidos.length,
    created,
    updated,
    unchanged,
    errors,
  })
})

export default router
