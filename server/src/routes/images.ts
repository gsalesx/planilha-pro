import crypto from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { Router } from 'express'
import multer from 'multer'
import sharp from 'sharp'

import { requireAuth } from '../auth.js'
import { db, nowMs } from '../db.js'
import { env } from '../env.js'

const router = Router()
const imagesDir = path.join(env.dataDir, 'images')
const thumbsDir = path.join(imagesDir, '_thumbs')
mkdirSync(imagesDir, { recursive: true })
mkdirSync(thumbsDir, { recursive: true })

const THUMB_MAX = 400
const THUMB_MIN = 64
const THUMB_QUALITY = 70

function parseThumbSize(raw: unknown): number | null {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const n = Number(raw)
  if (!Number.isFinite(n)) return null
  return Math.max(THUMB_MIN, Math.min(THUMB_MAX, Math.trunc(n)))
}

function thumbPathFor(storagePath: string, size: number): string {
  const base = path.basename(storagePath, path.extname(storagePath))
  return path.join(thumbsDir, `${base}_t${size}.jpg`)
}

function purgeThumbs(storagePath: string): void {
  const base = path.basename(storagePath, path.extname(storagePath))
  try {
    for (const f of readdirSync(thumbsDir)) {
      if (f.startsWith(`${base}_t`)) {
        try { unlinkSync(path.join(thumbsDir, f)) } catch { /* ignore */ }
      }
    }
  } catch {
    // ignore
  }
}

async function ensureThumb(storagePath: string, size: number): Promise<string | null> {
  const target = thumbPathFor(storagePath, size)
  try {
    const orig = statSync(storagePath)
    if (existsSync(target)) {
      const t = statSync(target)
      if (t.mtimeMs >= orig.mtimeMs && t.size > 0) return target
    }
  } catch {
    return null
  }
  try {
    await sharp(storagePath)
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: THUMB_QUALITY, progressive: true })
      .toFile(target)
    return target
  } catch {
    return null
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
})

router.post(
  '/workbooks/:workbookId/images/:orderId/:col',
  requireAuth,
  upload.single('image'),
  (req, res) => {
    const workbookId = req.params.workbookId
    const orderId = req.params.orderId
    const col = Number(req.params.col)
    if (!req.file) {
      res.status(400).json({ error: 'Envie multipart "image"' })
      return
    }
    if (!req.file.mimetype.startsWith('image/')) {
      res.status(400).json({ error: 'Arquivo precisa ser imagem' })
      return
    }
    if (!Number.isFinite(col) || col < 0 || col > 30) {
      res.status(400).json({ error: 'Coluna inválida' })
      return
    }

    const orderExists = db
      .prepare('SELECT id FROM orders WHERE workbook_id = ? AND id = ?')
      .get(workbookId, orderId)
    if (!orderExists) {
      res.status(404).json({ error: 'Pedido não encontrado' })
      return
    }

    const extension =
      req.file.mimetype === 'image/png' ? '.png' : req.file.mimetype === 'image/webp' ? '.webp' : '.jpg'
    const fileName = `${orderId.replace(/[^A-Za-z0-9_-]/g, '_')}_c${col}_${crypto.randomBytes(4).toString('hex')}${extension}`
    const storagePath = path.join(imagesDir, fileName)
    writeFileSync(storagePath, req.file.buffer)

    const now = nowMs()
    const txn = db.transaction(() => {
      const existing = db
        .prepare('SELECT storage_path FROM images WHERE workbook_id = ? AND order_id = ? AND col = ?')
        .get(workbookId, orderId, col) as { storage_path: string } | undefined
      if (existing) {
        try {
          unlinkSync(existing.storage_path)
        } catch {
          // ignore
        }
        purgeThumbs(existing.storage_path)
      }
      db.prepare(
        `INSERT INTO images (workbook_id, order_id, col, file_name, mime, storage_path, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(workbook_id, order_id, col) DO UPDATE SET
           file_name = excluded.file_name,
           mime = excluded.mime,
           storage_path = excluded.storage_path,
           updated_at = excluded.updated_at`,
      ).run(workbookId, orderId, col, req.file!.originalname || fileName, req.file!.mimetype, storagePath, now)
      db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
    })
    txn()

    res.json({
      ok: true,
      url: `/api/workbooks/${encodeURIComponent(workbookId)}/images/${encodeURIComponent(orderId)}/${col}`,
      updatedAt: now,
    })
  },
)

router.delete('/workbooks/:workbookId/images/:orderId/:col', requireAuth, (req, res) => {
  const workbookId = req.params.workbookId
  const orderId = req.params.orderId
  const col = Number(req.params.col)
  const existing = db
    .prepare('SELECT storage_path FROM images WHERE workbook_id = ? AND order_id = ? AND col = ?')
    .get(workbookId, orderId, col) as { storage_path: string } | undefined
  if (!existing) {
    res.status(404).json({ error: 'Imagem não encontrada' })
    return
  }
  const now = nowMs()
  const txn = db.transaction(() => {
    try {
      unlinkSync(existing.storage_path)
    } catch {
      // ignore
    }
    purgeThumbs(existing.storage_path)
    db.prepare('DELETE FROM images WHERE workbook_id = ? AND order_id = ? AND col = ?').run(
      workbookId,
      orderId,
      col,
    )
    db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  })
  txn()
  res.json({ ok: true, updatedAt: now })
})

router.get('/workbooks/:workbookId/images/:orderId/:col', requireAuth, async (req, res) => {
  const workbookId = req.params.workbookId
  const orderId = req.params.orderId
  const col = Number(req.params.col)
  const row = db
    .prepare('SELECT storage_path, mime FROM images WHERE workbook_id = ? AND order_id = ? AND col = ?')
    .get(workbookId, orderId, col) as { storage_path: string; mime: string } | undefined
  if (!row || !existsSync(row.storage_path)) {
    res.status(404).end()
    return
  }
  // ?thumb=N → JPEG progressivo NxN max (cache em disco, regenera se foto mudar)
  const thumbSize = parseThumbSize(req.query.thumb)
  if (thumbSize != null) {
    const target = await ensureThumb(row.storage_path, thumbSize)
    if (target) {
      res.setHeader('content-type', 'image/jpeg')
      res.setHeader('cache-control', 'private, max-age=86400')
      createReadStream(target).pipe(res)
      return
    }
    // se falhou em gerar, cai pra full em vez de quebrar
  }
  res.setHeader('content-type', row.mime)
  res.setHeader('cache-control', 'private, max-age=86400')
  createReadStream(row.storage_path).pipe(res)
})

export default router
