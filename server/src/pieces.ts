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
import { SHOPEE_COL_MODEL, SHOPEE_COL_PRODUCT } from './shopee-columns.js'

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

export interface PieceWithPhotos extends OrderPieceRow {
  photos: { 1: boolean; 2: boolean }
}

function attachPhotos(piece: OrderPieceRow): PieceWithPhotos {
  const rows = db.prepare('SELECT slot FROM piece_images WHERE piece_id = ?').all(piece.id) as Array<{
    slot: number
  }>
  const slots = new Set(rows.map((r) => r.slot))
  return { ...piece, photos: { 1: slots.has(1), 2: slots.has(2) } }
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
       VALUES (?, ?, ?, ?, ?, ?, ?, '', '', '#000000', '', ?, ?)`,
    )
    .run(workbookId, orderKey, seq, tipo, genero, tamanho, molde, source, now)
  return {
    id: Number(info.lastInsertRowid),
    workbook_id: workbookId,
    order_key: orderKey,
    seq,
    tipo,
    genero,
    tamanho,
    molde,
    emoji1: '',
    emoji2: '',
    cor: '#000000',
    nota: '',
    source,
    updated_at: now,
  }
}

/**
 * 1ª chamada por pedido: deriva peças do SKU/Modelo e persiste. Chamadas seguintes retornam
 * o que já está salvo (edição manual do usuário não é sobrescrita). Se o parser falhar,
 * registra pendência em parse_issues e retorna lista vazia + motivo.
 */
export function ensurePieces(
  workbookId: string,
  orderKey: string,
): { pieces: PieceWithPhotos[]; autoFailed?: string } {
  const existing = listPieces(workbookId, orderKey)
  if (existing.length > 0) return { pieces: existing }

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
  const result = parseOrderPieces(sku, modelName)
  if (!result.ok) {
    recordParseIssueIfNeeded(workbookId, orderKey, orderRow.id, sku, modelName)
    return { pieces: [], autoFailed: result.reason }
  }

  const created = result.pieces.map((p, i) =>
    insertPiece(workbookId, orderKey, i + 1, p.tipo, p.genero ?? null, p.tamanho, p.molde, 'auto'),
  )
  return { pieces: created.map(attachPhotos) }
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
