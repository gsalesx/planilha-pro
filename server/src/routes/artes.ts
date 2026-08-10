import crypto from 'node:crypto'

import { Router } from 'express'

import { requireAuth } from '../auth.js'
import { db, nowMs } from '../db.js'
import { addManualPiece, listPieces } from '../pieces.js'

const router = Router()

/** Sentinel usado como `order_pieces.workbook_id` pras peças criadas em artes.html —
 *  não existe um workbook de verdade com esse id (order_pieces não tem FK pra
 *  workbooks/orders, ver comentário em db.ts). Só serve pra namespacear essas peças
 *  longe de qualquer workbook real. */
export const ARTES_WORKBOOK_ID = 'artes-avulsas'

interface ArtProjectRow {
  id: string
  nome: string
  created_at: number
  updated_at: number
}

function pieceCount(projectId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM order_pieces WHERE workbook_id = ? AND order_key = ?')
    .get(ARTES_WORKBOOK_ID, projectId) as { n: number }
  return row.n
}

/** GET /api/artes/projects — histórico, mais recente primeiro. */
router.get('/artes/projects', requireAuth, (_req, res) => {
  const rows = db
    .prepare('SELECT * FROM art_projects ORDER BY updated_at DESC')
    .all() as ArtProjectRow[]
  res.json({ ok: true, projects: rows.map((r) => ({ ...r, pieces: pieceCount(r.id) })) })
})

/** POST /api/artes/projects — cria projeto novo (nome opcional, dá pra renomear depois). */
router.post('/artes/projects', requireAuth, (req, res) => {
  const nome = typeof req.body?.nome === 'string' ? req.body.nome.trim().slice(0, 200) : ''
  const id = `ap_${crypto.randomBytes(6).toString('hex')}`
  const now = nowMs()
  db.prepare('INSERT INTO art_projects (id, nome, created_at, updated_at) VALUES (?, ?, ?, ?)').run(
    id, nome, now, now,
  )
  res.json({ ok: true, project: { id, nome, created_at: now, updated_at: now, pieces: 0 } })
})

/** PATCH /api/artes/projects/:id — renomear. */
router.patch('/artes/projects/:id', requireAuth, (req, res) => {
  const { id } = req.params
  const nome = typeof req.body?.nome === 'string' ? req.body.nome.trim().slice(0, 200) : ''
  const now = nowMs()
  const result = db
    .prepare('UPDATE art_projects SET nome = ?, updated_at = ? WHERE id = ?')
    .run(nome, now, id)
  if (result.changes === 0) {
    res.status(404).json({ error: 'Projeto não encontrado' })
    return
  }
  res.json({ ok: true, id, nome, updated_at: now })
})

/** DELETE /api/artes/projects/:id — apaga o projeto e as peças dele (piece_images/
 *  piece_pending_photos/piece_arte_cache cascateiam via FK em order_pieces.id). */
router.delete('/artes/projects/:id', requireAuth, (req, res) => {
  const { id } = req.params
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM order_pieces WHERE workbook_id = ? AND order_key = ?').run(ARTES_WORKBOOK_ID, id)
    return db.prepare('DELETE FROM art_projects WHERE id = ?').run(id)
  })
  const result = txn()
  if (result.changes === 0) {
    res.status(404).json({ error: 'Projeto não encontrado' })
    return
  }
  res.json({ ok: true })
})

/** GET /api/artes/projects/:id/pieces — peças do projeto (mesmo formato de OrderPiece). */
router.get('/artes/projects/:id/pieces', requireAuth, (req, res) => {
  const project = db.prepare('SELECT id FROM art_projects WHERE id = ?').get(req.params.id)
  if (!project) {
    res.status(404).json({ error: 'Projeto não encontrado' })
    return
  }
  res.json({ ok: true, pieces: listPieces(ARTES_WORKBOOK_ID, req.params.id) })
})

/** POST /api/artes/projects/:id/pieces — adiciona 1 peça manual (padrão SHORT M). */
router.post('/artes/projects/:id/pieces', requireAuth, (req, res) => {
  const { id } = req.params
  const project = db.prepare('SELECT id FROM art_projects WHERE id = ?').get(id)
  if (!project) {
    res.status(404).json({ error: 'Projeto não encontrado' })
    return
  }
  const piece = addManualPiece(ARTES_WORKBOOK_ID, id)
  db.prepare('UPDATE art_projects SET updated_at = ? WHERE id = ?').run(nowMs(), id)
  res.json({ ok: true, piece })
})

export default router
