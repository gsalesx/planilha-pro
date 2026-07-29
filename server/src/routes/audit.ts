import { Router } from 'express'

import { auditSummary, queryAudit, recordAudit } from '../audit.js'
import { requireAuth } from '../auth.js'
import { db, nowMs } from '../db.js'
import { SHOPEE_COL_INTERNAL_STATUS } from '../shopee-columns.js'
import { reagruparLinhasDoPedido } from '../shopee-order-sync.js'
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

export default router
