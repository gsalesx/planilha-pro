import crypto from 'node:crypto'
import { createReadStream, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { Router } from 'express'

import { requireAuth } from '../auth.js'
import { db, nowMs } from '../db.js'
import { env } from '../env.js'
import {
  addManualPiece,
  deletePiece,
  ensurePieces,
  pieceExists,
  updatePiece,
  type PiecePatch,
} from '../pieces.js'
import { normalizeGenero, normalizeTamanho, type PecaTipo } from '../sku-rules.js'

const router = Router()
const imagesDir = path.join(env.dataDir, 'images')

/** Mesma regra do content.js da extensão: tira @resize/@crop/@quality pra pegar a foto original. */
function shopeeCdnOriginalUrl(url: string): string {
  let host = ''
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return url
  }
  if (!host.includes('shopee')) return url
  const at = url.indexOf('@')
  if (at === -1) return url
  const tail = url.slice(at)
  if (!/@resize|@crop|@quality|@format|!/i.test(tail)) return url
  return url.slice(0, at)
}

function parsePiecePatch(body: unknown): PiecePatch {
  const b = (body ?? {}) as Record<string, unknown>
  const patch: PiecePatch = {}
  if (typeof b.tipo === 'string' && ['CAMISOLA', 'SHORT', 'CONJ'].includes(b.tipo)) {
    patch.tipo = b.tipo as PecaTipo
  }
  if (b.genero === null) patch.genero = null
  else if (typeof b.genero === 'string') {
    const g = normalizeGenero(b.genero)
    if (g) patch.genero = g
  }
  if (typeof b.tamanho === 'string') {
    const t = normalizeTamanho(b.tamanho)
    if (t) patch.tamanho = t
  }
  if (typeof b.emoji1 === 'string') patch.emoji1 = b.emoji1.trim()
  if (typeof b.emoji2 === 'string') patch.emoji2 = b.emoji2.trim()
  if (typeof b.cor === 'string' && /^#[0-9a-fA-F]{6}$/.test(b.cor.trim())) patch.cor = b.cor.trim().toLowerCase()
  return patch
}

/** GET /api/workbooks/:wb/pieces/:orderKey — auto-deriva (1ª vez) ou retorna peças salvas. */
router.get('/workbooks/:wb/pieces/:orderKey', requireAuth, (req, res) => {
  const { wb, orderKey } = req.params
  const result = ensurePieces(wb, orderKey)
  res.json({ ok: true, ...result })
})

/** POST /api/workbooks/:wb/pieces/:orderKey — adiciona 1 peça manual (tipo SHORT M por padrão). */
router.post('/workbooks/:wb/pieces/:orderKey', requireAuth, (req, res) => {
  const { wb, orderKey } = req.params
  const orderRow = db
    .prepare('SELECT 1 FROM orders WHERE workbook_id = ? AND order_key = ?')
    .get(wb, orderKey)
  if (!orderRow) {
    res.status(404).json({ error: 'Pedido não encontrado' })
    return
  }
  const piece = addManualPiece(wb, orderKey)
  res.json({ ok: true, piece })
})

/** PATCH /api/pieces/:id — override manual de tipo/genero/tamanho/emoji1/emoji2/cor. */
router.patch('/pieces/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'id inválido' })
    return
  }
  const patch = parsePiecePatch(req.body)
  const updated = updatePiece(id, patch)
  if (!updated) {
    res.status(404).json({ error: 'Peça não encontrada' })
    return
  }
  res.json({ ok: true, piece: updated })
})

/** DELETE /api/pieces/:id */
router.delete('/pieces/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id)
  const removed = deletePiece(id)
  if (!removed) {
    res.status(404).json({ error: 'Peça não encontrada' })
    return
  }
  res.json({ ok: true })
})

/** POST /api/pieces/:id/photo/:slot — { url } de uma foto do chat Shopee; baixa e guarda no servidor. */
router.post('/pieces/:id/photo/:slot', requireAuth, async (req, res) => {
  const pieceId = Number(req.params.id)
  const slot = Number(req.params.slot)
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
  if (!Number.isFinite(pieceId) || pieceId <= 0 || (slot !== 1 && slot !== 2) || !url) {
    res.status(400).json({ error: 'id, slot (1|2) e url obrigatórios' })
    return
  }
  if (!pieceExists(pieceId)) {
    res.status(404).json({ error: 'Peça não encontrada' })
    return
  }
  try {
    const fullUrl = shopeeCdnOriginalUrl(url)
    const response = await fetch(fullUrl)
    if (!response.ok) throw new Error(`Download da imagem: HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const mime = response.headers.get('content-type') || 'image/jpeg'
    const ext = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg'
    const fileName = `piece_${pieceId}_s${slot}_${crypto.randomBytes(4).toString('hex')}${ext}`
    const storagePath = path.join(imagesDir, fileName)
    writeFileSync(storagePath, buffer)

    const now = nowMs()
    const txn = db.transaction(() => {
      const existing = db
        .prepare('SELECT storage_path FROM piece_images WHERE piece_id = ? AND slot = ?')
        .get(pieceId, slot) as { storage_path: string } | undefined
      if (existing) {
        try {
          unlinkSync(existing.storage_path)
        } catch {
          // ignore
        }
      }
      db.prepare(
        `INSERT INTO piece_images (piece_id, slot, file_name, mime, storage_path, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(piece_id, slot) DO UPDATE SET
           file_name = excluded.file_name, mime = excluded.mime,
           storage_path = excluded.storage_path, updated_at = excluded.updated_at`,
      ).run(pieceId, slot, fileName, mime, storagePath, now)
    })
    txn()

    res.json({ ok: true, url: `/api/pieces/${pieceId}/photo/${slot}?t=${now}`, updatedAt: now })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao baixar imagem do chat',
    })
  }
})

/** DELETE /api/pieces/:id/photo/:slot */
router.delete('/pieces/:id/photo/:slot', requireAuth, (req, res) => {
  const pieceId = Number(req.params.id)
  const slot = Number(req.params.slot)
  const existing = db
    .prepare('SELECT storage_path FROM piece_images WHERE piece_id = ? AND slot = ?')
    .get(pieceId, slot) as { storage_path: string } | undefined
  if (!existing) {
    res.status(404).json({ error: 'Foto não encontrada' })
    return
  }
  try {
    unlinkSync(existing.storage_path)
  } catch {
    // ignore
  }
  db.prepare('DELETE FROM piece_images WHERE piece_id = ? AND slot = ?').run(pieceId, slot)
  res.json({ ok: true })
})

/** GET /api/pieces/:id/photo/:slot — serve o binário salvo. */
router.get('/pieces/:id/photo/:slot', requireAuth, (req, res) => {
  const pieceId = Number(req.params.id)
  const slot = Number(req.params.slot)
  const row = db
    .prepare('SELECT storage_path, mime FROM piece_images WHERE piece_id = ? AND slot = ?')
    .get(pieceId, slot) as { storage_path: string; mime: string } | undefined
  if (!row || !existsSync(row.storage_path)) {
    res.status(404).end()
    return
  }
  res.setHeader('content-type', row.mime)
  res.setHeader('cache-control', 'private, max-age=86400')
  createReadStream(row.storage_path).pipe(res)
})

export default router
