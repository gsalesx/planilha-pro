/**
 * Peças por pedido — Fase 2 da migração SKU→peça (ver server/src/sku-rules.ts e memória
 * `planilha-pro-migracao-sku-pecas-2026-07-08` no repo Criador de artes). Usado pelo picker
 * dentro do chat Shopee (src/shopee-chat-panel.ts): auto-deriva peças pelo SKU/Modelo do
 * pedido na 1ª abertura, depois persiste — override manual e emoji/cor ficam salvos entre
 * sessões (não recalcula de novo uma vez que existe linha em order_pieces).
 */

import { db, nowMs } from './db.js'
import {
  buildMolde,
  parseOrderPieces,
  recordParseIssueIfNeeded,
  type Genero,
  type PecaTipo,
  type Tamanho,
} from './sku-rules.js'
import { SHOPEE_COL_MODEL, SHOPEE_COL_PRODUCT, SHOPEE_COL_QTY } from './shopee-columns.js'

export interface OrderPieceRow {
  id: number
  workbook_id: string
  order_key: string
  seq: number
  tipo: PecaTipo
  genero: Genero | null
  tamanho: Tamanho
  molde: string
  emoji1: string
  emoji2: string
  cor: string
  nota: string
  source: 'auto' | 'manual'
  updated_at: number
}

export type PhotoCrop = 'rosto' | 'coracao'

export interface PieceWithPhotos extends OrderPieceRow {
  photos: { 1: boolean; 2: boolean }
  /** Tipo de composição por foto — 'rosto' (recorte/silhueta) | 'coracao'. Mesmo
   * toggle por foto que a extensão Chrome antiga tinha (radiogroup "Recorte"/
   * "Coração"). null = sem foto nesse slot ainda. */
  crops: { 1: PhotoCrop | null; 2: PhotoCrop | null }
  /** URL do CDN Shopee pra foto escolhida mas AINDA NÃO baixada (hotlink direto —
   * ver piece_pending_photos). null = já confirmada/baixada, ou sem foto. */
  pendingUrls: { 1: string | null; 2: string | null }
  /** Slot já ajustado no picker web → timestamp da composta (serve de
   *  cache-buster na miniatura). null = ainda não ajustado. */
  compostas: { 1: number | null; 2: number | null }
}

function attachPhotos(piece: OrderPieceRow): PieceWithPhotos {
  const confirmed = db
    .prepare('SELECT slot, crop, composta_path, updated_at FROM piece_images WHERE piece_id = ?')
    .all(piece.id) as Array<{
      slot: number
      crop: string
      composta_path: string
      updated_at: number
    }>
  const pending = db
    .prepare('SELECT slot, url, crop FROM piece_pending_photos WHERE piece_id = ?')
    .all(piece.id) as Array<{ slot: number; url: string; crop: string }>
  const confirmedBySlot = new Map(confirmed.map((r) => [r.slot, r.crop as PhotoCrop]))
  const pendingBySlot = new Map(pending.map((r) => [r.slot, r]))
  // Slot já ajustado no picker web: a miniatura passa a mostrar o RESULTADO
  // (composta 900×900), não a foto crua — senão parecia que salvar não fez nada.
  const ajustadoBySlot = new Map(
    confirmed.filter((r) => r.composta_path).map((r) => [r.slot, r.updated_at]),
  )

  const slot1 = pendingBySlot.get(1)
  const slot2 = pendingBySlot.get(2)
  return {
    ...piece,
    photos: { 1: confirmedBySlot.has(1) || pendingBySlot.has(1), 2: confirmedBySlot.has(2) || pendingBySlot.has(2) },
    crops: {
      1: (slot1?.crop as PhotoCrop | undefined) ?? confirmedBySlot.get(1) ?? null,
      2: (slot2?.crop as PhotoCrop | undefined) ?? confirmedBySlot.get(2) ?? null,
    },
    pendingUrls: { 1: slot1?.url ?? null, 2: slot2?.url ?? null },
    compostas: { 1: ajustadoBySlot.get(1) ?? null, 2: ajustadoBySlot.get(2) ?? null },
  }
}

export function listPieces(workbookId: string, orderKey: string): PieceWithPhotos[] {
  const rows = db
    .prepare('SELECT * FROM order_pieces WHERE workbook_id = ? AND order_key = ? ORDER BY seq ASC')
    .all(workbookId, orderKey) as OrderPieceRow[]
  return rows.map(attachPhotos)
}

function nextSeq(workbookId: string, orderKey: string): number {
  const row = db
    .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM order_pieces WHERE workbook_id = ? AND order_key = ?')
    .get(workbookId, orderKey) as { m: number }
  return row.m + 1
}

/** Peça nova já nasce com CORAÇÃO nos 2 emojis — é o pedido mais comum de longe, evita
 * o operador ter que clicar toda vez pro caso padrão (ver src/shopee-chat-panel.ts,
 * favoritos fixos do picker). */
const DEFAULT_EMOJI_NAME = 'CORAÇÃO'

function insertPiece(
  workbookId: string,
  orderKey: string,
  seq: number,
  tipo: PecaTipo,
  genero: Genero | null,
  tamanho: Tamanho,
  molde: string,
  source: 'auto' | 'manual',
): OrderPieceRow {
  const now = nowMs()
  const info = db
    .prepare(
      `INSERT INTO order_pieces (workbook_id, order_key, seq, tipo, genero, tamanho, molde, emoji1, emoji2, cor, nota, source, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '#000000', '', ?, ?)`,
    )
    .run(workbookId, orderKey, seq, tipo, genero, tamanho, molde, DEFAULT_EMOJI_NAME, DEFAULT_EMOJI_NAME, source, now)
  return {
    id: Number(info.lastInsertRowid),
    workbook_id: workbookId,
    order_key: orderKey,
    seq,
    tipo,
    genero,
    tamanho,
    molde,
    emoji1: DEFAULT_EMOJI_NAME,
    emoji2: DEFAULT_EMOJI_NAME,
    cor: '#000000',
    nota: '',
    source,
    updated_at: now,
  }
}

/**
 * 1ª chamada por pedido: deriva peças do SKU/Modelo × quantidade (col D) e persiste.
 * Qnt=2 com camisola+short → camisola, short, camisola, short (conjunto na sequência).
 * Chamadas seguintes retornam o salvo (edição manual não é sobrescrita). Se o parser falhar,
 * registra pendência em parse_issues e retorna lista vazia + motivo.
 *
 * Exceção: se todas as peças ainda são `auto`, sem foto e a Qnt. indica mais unidades
 * do que o que foi gravado (bug antigo), re-deriva e sobrescreve.
 */
export function ensurePieces(
  workbookId: string,
  orderKey: string,
): { pieces: PieceWithPhotos[]; autoFailed?: string } {
  const orderRow = db
    .prepare('SELECT id, row_json FROM orders WHERE workbook_id = ? AND order_key = ?')
    .get(workbookId, orderKey) as { id: string; row_json: string } | undefined
  if (!orderRow) return { pieces: [] }

  let cells: string[]
  try {
    cells = JSON.parse(orderRow.row_json) as string[]
  } catch {
    return { pieces: [] }
  }

  const sku = (cells[SHOPEE_COL_PRODUCT] || '').trim()
  const modelName = (cells[SHOPEE_COL_MODEL] || '').trim()
  const qty = parseOrderQty(cells[SHOPEE_COL_QTY])
  const parsed = parseOrderPieces(sku, modelName)

  const existing = listPieces(workbookId, orderKey)
  if (existing.length > 0) {
    if (!shouldRebuildForQty(existing, parsed, qty)) {
      return { pieces: existing }
    }
    for (const p of existing) deletePiece(p.id)
  }

  if (!parsed.ok) {
    recordParseIssueIfNeeded(workbookId, orderKey, orderRow.id, sku, modelName)
    return { pieces: [], autoFailed: parsed.reason }
  }

  const expanded = expandPiecesByQty(parsed.pieces, qty)
  const created = expanded.map((p, i) =>
    insertPiece(workbookId, orderKey, i + 1, p.tipo, p.genero ?? null, p.tamanho, p.molde, 'auto'),
  )
  return { pieces: created.map(attachPhotos) }
}

/** Quantidade da col D — vazio/ inválido = 1; teto 20 pra não explodir a UI. */
function parseOrderQty(raw: unknown): number {
  const n = Number(String(raw ?? '').trim().replace(',', '.'))
  if (!Number.isFinite(n) || n < 1) return 1
  return Math.min(Math.floor(n), 20)
}

/** Repete o conjunto derivado N vezes na sequência (1ª unidade completa, depois a 2ª…). */
function expandPiecesByQty<T>(unitPieces: T[], qty: number): T[] {
  if (qty <= 1) return unitPieces
  const out: T[] = []
  for (let u = 0; u < qty; u++) {
    for (const p of unitPieces) out.push(p)
  }
  return out
}

function shouldRebuildForQty(
  existing: PieceWithPhotos[],
  parsed: ReturnType<typeof parseOrderPieces>,
  qty: number,
): boolean {
  if (qty <= 1) return false
  if (!parsed.ok) return false
  if (!existing.every((p) => p.source === 'auto')) return false
  // Só bloqueia se já baixou foto de verdade (Confirmar pedido). Foto pendente
  // do chat ainda pode re-derivar — o operador não fechou a separação.
  const hasConfirmed = existing.some(
    (p) =>
      (Boolean(p.photos[1]) && !p.pendingUrls[1]) || (Boolean(p.photos[2]) && !p.pendingUrls[2]),
  )
  if (hasConfirmed) return false
  const expected = parsed.pieces.length * qty
  return existing.length < expected
}

/** Peça extra criada na mão (pedido sem SKU reconhecido, ou peça a mais que o parser não previu). */
export function addManualPiece(workbookId: string, orderKey: string): PieceWithPhotos {
  const seq = nextSeq(workbookId, orderKey)
  const tipo: PecaTipo = 'SHORT'
  const genero: Genero = 'MASCULINO'
  const tamanho: Tamanho = 'M'
  const molde = buildMolde(tipo, genero, tamanho)
  return attachPhotos(insertPiece(workbookId, orderKey, seq, tipo, genero, tamanho, molde, 'manual'))
}

export interface PiecePatch {
  tipo?: PecaTipo
  genero?: Genero | null
  tamanho?: Tamanho
  emoji1?: string
  emoji2?: string
  cor?: string
  nota?: string
}

export function updatePiece(pieceId: number, patch: PiecePatch): PieceWithPhotos | null {
  const existing = db.prepare('SELECT * FROM order_pieces WHERE id = ?').get(pieceId) as
    | OrderPieceRow
    | undefined
  if (!existing) return null

  const tipo = patch.tipo ?? existing.tipo
  const genero = patch.genero !== undefined ? patch.genero : existing.genero
  const tamanho = patch.tamanho ?? existing.tamanho
  const emoji1 = patch.emoji1 ?? existing.emoji1
  const emoji2 = patch.emoji2 ?? existing.emoji2
  const cor = patch.cor ?? existing.cor
  const nota = patch.nota ?? existing.nota
  const molde = buildMolde(tipo, genero, tamanho)
  const now = nowMs()

  db.prepare(
    `UPDATE order_pieces
     SET tipo = ?, genero = ?, tamanho = ?, molde = ?, emoji1 = ?, emoji2 = ?, cor = ?, nota = ?, source = 'manual', updated_at = ?
     WHERE id = ?`,
  ).run(tipo, genero, tamanho, molde, emoji1, emoji2, cor, nota, now, pieceId)

  return attachPhotos({
    ...existing,
    tipo,
    genero,
    tamanho,
    molde,
    emoji1,
    emoji2,
    cor,
    nota,
    source: 'manual',
    updated_at: now,
  })
}

/** Cascateia pra piece_images via FK (foreign_keys=ON no db.ts). */
export function deletePiece(pieceId: number): boolean {
  const result = db.prepare('DELETE FROM order_pieces WHERE id = ?').run(pieceId)
  return result.changes > 0
}

export function pieceExists(pieceId: number): boolean {
  return Boolean(db.prepare('SELECT id FROM order_pieces WHERE id = ?').get(pieceId))
}
