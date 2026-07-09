import crypto from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, unlinkSync, writeFileSync } from 'node:fs'
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
  if (typeof b.nota === 'string') patch.nota = b.nota.trim().slice(0, 500)
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

/**
 * POST /api/pieces/:id/copy-from/:sourceId — copia fotos (slots 1/2) + emoji1/emoji2 da
 * peça de origem pra peça de destino. Usado quando o pedido tem N peças (ex.: camisola +
 * short) com as MESMAS fotos/emojis — copiar da 1ª peça em vez de escolher tudo de novo.
 * Não mexe em tipo/gênero/tamanho/cor (cada peça mantém o seu, igual ao "copiar imagens
 * do 1º" do picker_manual.py no Criador de artes).
 */
router.post('/pieces/:id/copy-from/:sourceId', requireAuth, (req, res) => {
  const targetId = Number(req.params.id)
  const sourceId = Number(req.params.sourceId)
  if (!Number.isFinite(targetId) || !Number.isFinite(sourceId) || targetId === sourceId) {
    res.status(400).json({ error: 'ids inválidos' })
    return
  }
  const source = db
    .prepare('SELECT emoji1, emoji2 FROM order_pieces WHERE id = ?')
    .get(sourceId) as { emoji1: string; emoji2: string } | undefined
  if (!source || !pieceExists(targetId)) {
    res.status(404).json({ error: 'Peça não encontrada' })
    return
  }

  const now = nowMs()
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE order_pieces SET emoji1 = ?, emoji2 = ?, source = 'manual', updated_at = ? WHERE id = ?`,
    ).run(source.emoji1, source.emoji2, now, targetId)

    const sourceImages = db
      .prepare('SELECT slot, mime, storage_path FROM piece_images WHERE piece_id = ?')
      .all(sourceId) as Array<{ slot: number; mime: string; storage_path: string }>
    for (const img of sourceImages) {
      if (!existsSync(img.storage_path)) continue
      const ext = path.extname(img.storage_path) || '.jpg'
      const fileName = `piece_${targetId}_s${img.slot}_${crypto.randomBytes(4).toString('hex')}${ext}`
      const newPath = path.join(imagesDir, fileName)
      copyFileSync(img.storage_path, newPath)

      const existingTarget = db
        .prepare('SELECT storage_path FROM piece_images WHERE piece_id = ? AND slot = ?')
        .get(targetId, img.slot) as { storage_path: string } | undefined
      if (existingTarget) {
        try {
          unlinkSync(existingTarget.storage_path)
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
      ).run(targetId, img.slot, fileName, img.mime, newPath, now)
    }
  })
  txn()

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

/** PATCH /api/pieces/:id/photo/:slot — { crop: 'rosto'|'coracao' }. Troca só o TIPO de
 * composição da foto já escolhida (recorte/silhueta vs coração), sem reenviar a imagem —
 * mesmo toggle por foto que a extensão Chrome antiga tinha. */
router.patch('/pieces/:id/photo/:slot', requireAuth, (req, res) => {
  const pieceId = Number(req.params.id)
  const slot = Number(req.params.slot)
  const crop = req.body?.crop
  if (!Number.isFinite(pieceId) || pieceId <= 0 || (slot !== 1 && slot !== 2)) {
    res.status(400).json({ error: 'id/slot inválidos' })
    return
  }
  if (crop !== 'rosto' && crop !== 'coracao') {
    res.status(400).json({ error: "crop precisa ser 'rosto' ou 'coracao'" })
    return
  }
  const result = db
    .prepare('UPDATE piece_images SET crop = ?, updated_at = ? WHERE piece_id = ? AND slot = ?')
    .run(crop, nowMs(), pieceId, slot)
  if (result.changes === 0) {
    res.status(404).json({ error: 'Foto não encontrada nesse slot' })
    return
  }
  res.json({ ok: true, crop })
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
