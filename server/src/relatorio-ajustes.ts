/**
 * Relatório de ajustes — base de treino do enquadramento automático.
 *
 * Fotos, compostas e artes saem do disco em 15 dias (limpar-fotos-antigas.ts). Este
 * relatório fica para sempre e é leve (~2 KB por foto): guarda as MEDIDAS da foto (hash,
 * tamanho, brilho, nitidez, rostos achados pelo SCRFD e pelo YuNet) e o que o operador fez com ela
 * (formato, dx/dy/zoom/rotação, fundo, cores), mais o contexto da peça e do pedido.
 * Nenhuma imagem é guardada aqui.
 *
 * Cada mudança numa foto (ajuste, troca de foto, cor/emoji da peça) vira uma VERSÃO nova
 * do mesmo (peça, slot) — a anterior fica. Alteração pedida pelo cliente aparece como v2.
 *
 * O texto do chat Shopee do pedido vai em `relatorio_chats` (insumo da IA que lê o pedido).
 */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { analisarFoto, encerrarAnalise } from './analise-foto.js'
import { recordAudit } from './audit.js'
import { db, nowMs } from './db.js'
import {
  MP_COL_INTERNAL_STATUS,
  MP_COL_MARKETPLACE_STATUS,
  MP_COL_MODEL,
  MP_COL_ORDER_ID,
  MP_COL_PRODUCT,
  MP_COL_QTY,
  MP_COL_USERNAME,
} from './marketplace-columns.js'
import { MERCADOLIVRE_WORKBOOK_ID, SHOPEE_WORKBOOK_ID, TIKTOK_WORKBOOK_ID } from './marketplace.js'
import { fetchAllChatMessages } from './shopee-api.js'
import { currentShopeeAccount } from './shopee-account.js'
import { getBuyerChatByUsername } from './shopee-link-conversations.js'
import { loadShopeeAuth } from './shopee-store.js'

db.exec(`
  CREATE TABLE IF NOT EXISTS relatorio_ajustes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piece_id INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    versao INTEGER NOT NULL,
    assinatura TEXT NOT NULL,
    workbook_id TEXT NOT NULL,
    order_key TEXT NOT NULL,
    motivo TEXT NOT NULL,
    lido_em INTEGER NOT NULL,
    salvo_em INTEGER NOT NULL,
    foto_hash TEXT NOT NULL,
    modo TEXT NOT NULL,
    n_rostos INTEGER NOT NULL,
    dados_json TEXT NOT NULL,
    UNIQUE (piece_id, slot, versao)
  );
  CREATE INDEX IF NOT EXISTS idx_relatorio_ajustes_pedido ON relatorio_ajustes (workbook_id, order_key);
  CREATE INDEX IF NOT EXISTS idx_relatorio_ajustes_hash ON relatorio_ajustes (foto_hash);

  CREATE TABLE IF NOT EXISTS relatorio_chats (
    workbook_id TEXT NOT NULL,
    order_key TEXT NOT NULL,
    order_id TEXT NOT NULL,
    capturado_em INTEGER NOT NULL,
    n_mensagens INTEGER NOT NULL,
    mensagens_json TEXT NOT NULL,
    PRIMARY KEY (workbook_id, order_key)
  );

  CREATE TABLE IF NOT EXISTS relatorio_execucoes (
    dia TEXT PRIMARY KEY,
    inicio INTEGER NOT NULL,
    fim INTEGER,
    resumo_json TEXT NOT NULL DEFAULT '{}'
  );
`)

interface LinhaFonte {
  piece_id: number
  slot: number
  storage_path: string
  crop: string
  ajuste_json: string
  u_width: number | null
  sem_fundo_path: string
  origem_url: string
  img_updated_at: number
  workbook_id: string
  order_key: string
  seq: number
  tipo: string
  genero: string | null
  tamanho: string
  molde: string
  emoji1: string
  emoji2: string
  cor: string
  source: string
  piece_updated_at: number
  sheet_date: string | null
  row_json: string | null
}

export type MotivoLeitura = 'noturna' | 'antes-limpeza' | 'manual'

export interface ResumoLeitura {
  motivo: MotivoLeitura
  fotosVistas: number
  versoesNovas: number
  comRosto: number
  chatsGravados: number
  erros: string[]
  duracaoMs: number
  /** Leitura noturna parou ao chegar o horário de trabalho; o resto fica pra próxima noite. */
  interrompida?: boolean
}

function marketplaceDe(workbookId: string): string {
  if (workbookId === SHOPEE_WORKBOOK_ID) return 'shopee'
  if (workbookId === TIKTOK_WORKBOOK_ID) return 'tiktok'
  if (workbookId === MERCADOLIVRE_WORKBOOK_ID) return 'mercadolivre'
  if (workbookId === 'artes-avulsas') return 'avulsa'
  return 'planilha'
}

function parseJson<T>(texto: string | null | undefined, padrao: T): T {
  if (!texto) return padrao
  try {
    return JSON.parse(texto) as T
  } catch {
    return padrao
  }
}

/** Arquivo do qual o ajuste foi aplicado — mesma regra do picker (routes/picker.ts). */
function fonteDoAjuste(l: LinhaFonte, ajuste: Record<string, unknown>): { tipo: string; caminho: string } {
  const temSemFundo = Boolean(l.sem_fundo_path && existsSync(l.sem_fundo_path))
  if (l.crop === 'sem') return { tipo: 'original', caminho: l.storage_path }
  if (l.crop === 'face') {
    return temSemFundo ? { tipo: 'face_cutout', caminho: l.sem_fundo_path } : { tipo: 'original', caminho: l.storage_path }
  }
  const escolhida = ajuste.fonteRecorte
  const usaSemFundo =
    escolhida === 'sem_fundo' || (escolhida !== 'original' && l.crop !== 'coracao' && temSemFundo)
  return usaSemFundo && temSemFundo
    ? { tipo: 'sem_fundo', caminho: l.sem_fundo_path }
    : { tipo: 'original', caminho: l.storage_path }
}

function linhasCandidatas(): LinhaFonte[] {
  return db
    .prepare(
      `SELECT pi.piece_id, pi.slot, pi.storage_path, pi.crop, pi.ajuste_json, pi.u_width,
              pi.sem_fundo_path, pi.origem_url, pi.updated_at AS img_updated_at,
              p.workbook_id, p.order_key, p.seq, p.tipo, p.genero, p.tamanho, p.molde,
              p.emoji1, p.emoji2, p.cor, p.source, p.updated_at AS piece_updated_at,
              o.sheet_date, o.row_json
         FROM piece_images pi
         JOIN order_pieces p ON p.id = pi.piece_id
         LEFT JOIN orders o ON o.workbook_id = p.workbook_id AND o.order_key = p.order_key`,
    )
    .all() as LinhaFonte[]
}

function ultimasVersoes(): Map<string, { versao: number; assinatura: string; id: number }> {
  const rows = db
    .prepare(
      `SELECT r.piece_id, r.slot, r.versao, r.assinatura, r.id
         FROM relatorio_ajustes r
         JOIN (SELECT piece_id, slot, MAX(versao) AS v FROM relatorio_ajustes GROUP BY piece_id, slot) m
           ON m.piece_id = r.piece_id AND m.slot = r.slot AND m.v = r.versao`,
    )
    .all() as Array<{ piece_id: number; slot: number; versao: number; assinatura: string; id: number }>
  return new Map(rows.map((r) => [`${r.piece_id}:${r.slot}`, r]))
}

function assinaturaDe(l: LinhaFonte): string {
  return [
    path.basename(l.storage_path),
    l.crop,
    l.ajuste_json,
    l.u_width ?? '',
    path.basename(l.sem_fundo_path || ''),
    l.molde,
    l.cor,
    l.emoji1,
    l.emoji2,
  ].join('|')
}

const inserir = db.prepare(
  `INSERT INTO relatorio_ajustes
     (piece_id, slot, versao, assinatura, workbook_id, order_key, motivo, lido_em, salvo_em,
      foto_hash, modo, n_rostos, dados_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
)

async function registrarFoto(
  l: LinhaFonte,
  versao: number,
  anteriorId: number | null,
  assinatura: string,
  motivo: MotivoLeitura,
  pecasPorPedido: Map<string, number>,
): Promise<{ comRosto: boolean }> {
  const original = readFileSync(l.storage_path)
  const ajuste = parseJson<Record<string, unknown>>(l.ajuste_json, {})
  const fonte = fonteDoAjuste(l, ajuste)

  // Medidas e rostos saem da thread de análise — a principal fica livre pra planilha.
  const detOriginal = await analisarFoto(original, ['scrfd', 'yunet'])
  const foto = detOriginal.medidas
  const nRostos = detOriginal.nRostos

  let fonteInfo: Record<string, unknown> = { tipo: fonte.tipo }
  if (fonte.caminho !== l.storage_path && existsSync(fonte.caminho)) {
    const bytesFonte = readFileSync(fonte.caminho)
    const analise = await analisarFoto(bytesFonte, ['scrfd', 'yunet'])
    fonteInfo = {
      tipo: fonte.tipo,
      hash: analise.medidas.hash,
      largura: analise.medidas.largura,
      altura: analise.medidas.altura,
      deteccao: analise.deteccao,
    }
  }

  const cells = parseJson<string[]>(l.row_json, [])
  const chavePedido = `${l.workbook_id}:${l.order_key}`
  const dados = {
    pedido: {
      marketplace: marketplaceDe(l.workbook_id),
      workbook_id: l.workbook_id,
      order_key: l.order_key,
      order_id: cells[MP_COL_ORDER_ID] ?? '',
      sheet_date: l.sheet_date ?? '',
      status: cells[MP_COL_INTERNAL_STATUS] ?? '',
      status_canal: cells[MP_COL_MARKETPLACE_STATUS] ?? '',
      produto: cells[MP_COL_PRODUCT] ?? '',
      modelo: cells[MP_COL_MODEL] ?? '',
      qtd: cells[MP_COL_QTY] ?? '',
      n_pecas: pecasPorPedido.get(chavePedido) ?? 1,
    },
    peca: {
      seq: l.seq,
      tipo: l.tipo,
      genero: l.genero,
      tamanho: l.tamanho,
      molde: l.molde,
      emoji1: l.emoji1,
      emoji2: l.emoji2,
      cor: l.cor,
      origem: l.source,
      atualizada_em: l.piece_updated_at,
    },
    foto: {
      ...foto,
      origem: l.origem_url ? 'chat' : 'upload',
      origem_url: l.origem_url,
    },
    deteccao: detOriginal.deteccao,
    fonte: fonteInfo,
    ajuste: {
      modo: l.crop,
      ajustado: Boolean(l.ajuste_json),
      width: ajuste.width ?? null,
      height: ajuste.height ?? null,
      dx: ajuste.dx ?? null,
      dy: ajuste.dy ?? null,
      rotation: ajuste.rotation ?? null,
      u_width: l.u_width,
      fonte_recorte: ajuste.fonteRecorte ?? null,
      fundo_cor: ajuste.fundoCor ?? null,
      borda_cor: ajuste.bordaCor ?? null,
      sem_borda: ajuste.semBorda ?? null,
    },
    versao_anterior_id: anteriorId,
  }

  inserir.run(
    l.piece_id,
    l.slot,
    versao,
    assinatura,
    l.workbook_id,
    l.order_key,
    motivo,
    nowMs(),
    l.img_updated_at,
    String(foto.hash),
    l.crop,
    nRostos,
    JSON.stringify(dados),
  )
  return { comRosto: nRostos > 0 }
}

/** Só texto/tipo/hora — sem nome nem endereço do comprador, que já estão no pedido. */
async function gravarChatShopee(workbookId: string, orderKey: string, cells: string[]): Promise<boolean> {
  const username = (cells[MP_COL_USERNAME] ?? '').trim()
  const chat = username ? getBuyerChatByUsername(username) : undefined
  if (!chat) return false
  const { messages } = await fetchAllChatMessages(chat.conversationId, chat.toId, { maxPages: 10 })
  const mensagens = messages.map((m) => ({
    id: m.id,
    do_cliente: m.fromBuyer,
    tipo: m.type,
    texto: m.type === 'image' ? '' : m.text,
    imagem: m.imageUrl ?? null,
    em: m.createdAt,
  }))
  db.prepare(
    `INSERT INTO relatorio_chats (workbook_id, order_key, order_id, capturado_em, n_mensagens, mensagens_json)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(workbook_id, order_key) DO UPDATE SET
       order_id = excluded.order_id, capturado_em = excluded.capturado_em,
       n_mensagens = excluded.n_mensagens, mensagens_json = excluded.mensagens_json`,
  ).run(workbookId, orderKey, cells[MP_COL_ORDER_ID] ?? '', nowMs(), mensagens.length, JSON.stringify(mensagens))
  return true
}

function shopeePronta(): boolean {
  const conta = currentShopeeAccount()
  return Boolean(conta.partnerId && conta.partnerKey && loadShopeeAuth())
}

let rodando = false

/**
 * Lê toda foto de peça que mudou desde a última versão gravada e acrescenta a versão
 * nova. `filtro` restringe a leitura (ex.: só pedidos que a limpeza vai apagar).
 */
export async function gravarRelatorioAjustes(
  motivo: MotivoLeitura,
  filtro?: (l: { workbook_id: string; order_key: string; sheet_date: string | null }) => boolean,
): Promise<ResumoLeitura> {
  const t0 = Date.now()
  const resumo: ResumoLeitura = {
    motivo,
    fotosVistas: 0,
    versoesNovas: 0,
    comRosto: 0,
    chatsGravados: 0,
    erros: [],
    duracaoMs: 0,
  }
  if (rodando) {
    resumo.erros.push('leitura anterior ainda rodando')
    return resumo
  }
  rodando = true
  try {
    const todas = linhasCandidatas()
    const pecasPorPedido = new Map<string, number>()
    const pecasVistas = new Set<number>()
    for (const l of todas) {
      if (pecasVistas.has(l.piece_id)) continue
      pecasVistas.add(l.piece_id)
      const k = `${l.workbook_id}:${l.order_key}`
      pecasPorPedido.set(k, (pecasPorPedido.get(k) ?? 0) + 1)
    }

    const ultimas = ultimasVersoes()
    const pedidosComNovidade = new Map<string, { workbookId: string; orderKey: string; cells: string[] }>()

    for (const l of todas) {
      if (motivo === 'noturna' && !dentroDaJanelaNoturna()) {
        resumo.interrompida = true
        break
      }
      if (filtro && !filtro(l)) continue
      if (!l.storage_path || !existsSync(l.storage_path)) continue
      resumo.fotosVistas++
      const assinatura = assinaturaDe(l)
      const ultima = ultimas.get(`${l.piece_id}:${l.slot}`)
      if (ultima && ultima.assinatura === assinatura) continue
      try {
        const { comRosto } = await registrarFoto(
          l,
          (ultima?.versao ?? 0) + 1,
          ultima?.id ?? null,
          assinatura,
          motivo,
          pecasPorPedido,
        )
        resumo.versoesNovas++
        if (comRosto) resumo.comRosto++
        if (l.workbook_id === SHOPEE_WORKBOOK_ID && l.row_json) {
          pedidosComNovidade.set(`${l.workbook_id}:${l.order_key}`, {
            workbookId: l.workbook_id,
            orderKey: l.order_key,
            cells: parseJson<string[]>(l.row_json, []),
          })
        }
      } catch (e) {
        resumo.erros.push(`peça ${l.piece_id}/foto ${l.slot}: ${(e as Error).message}`)
      }
    }

    if (pedidosComNovidade.size > 0 && shopeePronta()) {
      for (const p of pedidosComNovidade.values()) {
        try {
          if (await gravarChatShopee(p.workbookId, p.orderKey, p.cells)) resumo.chatsGravados++
        } catch (e) {
          resumo.erros.push(`chat ${p.orderKey}: ${(e as Error).message}`)
        }
        await new Promise((r) => setTimeout(r, 300))
      }
    }
  } finally {
    await encerrarAnalise().catch(() => undefined)
    rodando = false
    resumo.duracaoMs = Date.now() - t0
  }

  recordAudit({
    source: motivo === 'manual' ? 'manual' : 'boot',
    event: 'relatorio.ajustes',
    level: resumo.erros.length > 0 ? 'warn' : 'info',
    detail: { ...resumo, erros: resumo.erros.slice(0, 50) },
  })
  return resumo
}

/** Dia de hoje em São Paulo (YYYY-MM-DD) e a hora local. */
function agoraSaoPaulo(): { dia: string; hora: number } {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date())
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? ''
  return { dia: `${v('year')}-${v('month')}-${v('day')}`, hora: Number(v('hour')) }
}

export const HORA_LEITURA_NOTURNA = 4
/** A leitura noturna para às 8h (início do expediente) e continua na noite seguinte. */
export const HORA_FIM_LEITURA_NOTURNA = 8

function dentroDaJanelaNoturna(): boolean {
  const { hora } = agoraSaoPaulo()
  return hora >= HORA_LEITURA_NOTURNA && hora < HORA_FIM_LEITURA_NOTURNA
}

/**
 * Chamado a cada poucos minutos: roda uma vez por dia, a partir das 4h (horário de
 * Brasília) até as 8h. Se o servidor estava fora às 4h, roda assim que voltar (antes das 8h).
 * O que não der tempo fica pra noite seguinte (a leitura só pega o que ainda não foi lido).
 */
export async function talvezRodarLeituraNoturna(): Promise<void> {
  const { dia, hora } = agoraSaoPaulo()
  if (hora < HORA_LEITURA_NOTURNA || hora >= HORA_FIM_LEITURA_NOTURNA) return
  const ja = db.prepare('SELECT dia FROM relatorio_execucoes WHERE dia = ?').get(dia)
  if (ja || rodando) return
  db.prepare('INSERT INTO relatorio_execucoes (dia, inicio) VALUES (?, ?)').run(dia, nowMs())
  const resumo = await gravarRelatorioAjustes('noturna')
  db.prepare('UPDATE relatorio_execucoes SET fim = ?, resumo_json = ? WHERE dia = ?').run(
    nowMs(),
    JSON.stringify(resumo),
    dia,
  )
  if (resumo.versoesNovas > 0 || resumo.erros.length > 0) {
    console.log('[relatorio-ajustes] leitura noturna', {
      novas: resumo.versoesNovas,
      chats: resumo.chatsGravados,
      erros: resumo.erros.length,
      ms: resumo.duracaoMs,
      interrompida: Boolean(resumo.interrompida),
    })
  }
}

export function resumoRelatorio(): Record<string, unknown> {
  const um = <T>(sql: string) => db.prepare(sql).get() as T
  const total = um<{ n: number }>('SELECT COUNT(*) AS n FROM relatorio_ajustes').n
  const fotos = um<{ n: number }>('SELECT COUNT(*) AS n FROM (SELECT DISTINCT piece_id, slot FROM relatorio_ajustes)').n
  const comAlteracao = um<{ n: number }>(
    'SELECT COUNT(*) AS n FROM (SELECT piece_id, slot FROM relatorio_ajustes GROUP BY piece_id, slot HAVING MAX(versao) > 1)',
  ).n
  const porModo = db
    .prepare('SELECT modo, COUNT(*) AS n FROM relatorio_ajustes GROUP BY modo ORDER BY n DESC')
    .all()
  const porRostos = db
    .prepare('SELECT n_rostos, COUNT(*) AS n FROM relatorio_ajustes GROUP BY n_rostos ORDER BY n_rostos')
    .all()
  const chats = um<{ n: number }>('SELECT COUNT(*) AS n FROM relatorio_chats').n
  const execucoes = db
    .prepare('SELECT dia, inicio, fim, resumo_json FROM relatorio_execucoes ORDER BY dia DESC LIMIT 7')
    .all() as Array<{ dia: string; inicio: number; fim: number | null; resumo_json: string }>
  return {
    versoes: total,
    fotos,
    fotosComAlteracao: comAlteracao,
    porModo,
    porRostos,
    chats,
    ultimasExecucoes: execucoes.map((e) => ({ ...e, resumo_json: undefined, resumo: parseJson(e.resumo_json, {}) })),
  }
}

/** Página do relatório pra exportar/treinar (ordem de id; `desde` = último id já lido). */
export function paginaRelatorio(desde: number, limite: number): { itens: unknown[]; proximo: number | null } {
  const rows = db
    .prepare(
      `SELECT id, piece_id, slot, versao, motivo, lido_em, salvo_em, dados_json
         FROM relatorio_ajustes WHERE id > ? ORDER BY id LIMIT ?`,
    )
    .all(desde, limite) as Array<{
      id: number
      piece_id: number
      slot: number
      versao: number
      motivo: string
      lido_em: number
      salvo_em: number
      dados_json: string
    }>
  const itens = rows.map(({ dados_json, ...r }) => ({ ...r, ...parseJson<Record<string, unknown>>(dados_json, {}) }))
  return { itens, proximo: rows.length === limite ? rows[rows.length - 1].id : null }
}

export function paginaChats(desde: number, limite: number): { itens: unknown[]; proximo: number | null } {
  const rows = db
    .prepare(
      `SELECT rowid AS id, workbook_id, order_key, order_id, capturado_em, n_mensagens, mensagens_json
         FROM relatorio_chats WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    )
    .all(desde, limite) as Array<{ id: number; mensagens_json: string } & Record<string, unknown>>
  const itens = rows.map(({ mensagens_json, ...r }) => ({ ...r, mensagens: parseJson(mensagens_json, []) }))
  return { itens, proximo: rows.length === limite ? Number(rows[rows.length - 1].id) : null }
}
