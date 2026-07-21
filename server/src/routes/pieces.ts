import crypto from 'node:crypto'
import { copyFileSync, createReadStream, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { Router } from 'express'
import multer from 'multer'

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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } })

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Download do CDN Shopee com retry — 429/503 e falha de rede são comuns quando
 * o "Confirmar pedido" baixa várias originais em sequência. Respeita Retry-After
 * quando a Shopee manda; senão backoff 0.8s → 2s → 5s.
 */
async function fetchShopeeCdn(url: string): Promise<Response> {
  const delaysMs = [0, 800, 2000, 5000]
  let lastError: Error | null = null
  for (let i = 0; i < delaysMs.length; i++) {
    if (delaysMs[i] > 0) await sleep(delaysMs[i])
    try {
      const response = await fetch(url, {
        headers: {
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        redirect: 'follow',
      })
      if (response.status === 429 || response.status === 503) {
        lastError = new Error(`HTTP ${response.status}`)
        const retryAfter = Number(response.headers.get('retry-after'))
        if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 30) {
          await sleep(retryAfter * 1000)
        }
        continue
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      // 4xx (exceto 429 já tratado) não vale insistir
      if (lastError.message.startsWith('HTTP 4') && !lastError.message.includes('429')) {
        throw lastError
      }
    }
  }
  throw lastError ?? new Error('falha ao baixar do CDN')
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
 * POST /api/pieces/:id/copy-from/:sourceId — copia fotos (slots 1/2) + emoji1/emoji2 + cor
 * da peça de origem pra peça de destino. Usado quando o pedido tem N peças (ex.: camisola +
 * short) com as MESMAS fotos/emojis/cor — copiar da 1ª peça em vez de escolher tudo de novo.
 * Não mexe em tipo/gênero/tamanho (cada peça mantém o seu molde).
 */
router.post('/pieces/:id/copy-from/:sourceId', requireAuth, (req, res) => {
  const targetId = Number(req.params.id)
  const sourceId = Number(req.params.sourceId)
  if (!Number.isFinite(targetId) || !Number.isFinite(sourceId) || targetId === sourceId) {
    res.status(400).json({ error: 'ids inválidos' })
    return
  }
  const source = db
    .prepare('SELECT emoji1, emoji2, cor FROM order_pieces WHERE id = ?')
    .get(sourceId) as { emoji1: string; emoji2: string; cor: string } | undefined
  if (!source || !pieceExists(targetId)) {
    res.status(404).json({ error: 'Peça não encontrada' })
    return
  }

  const now = nowMs()
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE order_pieces SET emoji1 = ?, emoji2 = ?, cor = ?, source = 'manual', updated_at = ? WHERE id = ?`,
    ).run(source.emoji1, source.emoji2, source.cor, now, targetId)

    // pendentes (ainda não baixadas) — só copia a referência de URL, sem download.
    const sourcePending = db
      .prepare('SELECT slot, url, crop FROM piece_pending_photos WHERE piece_id = ?')
      .all(sourceId) as Array<{ slot: number; url: string; crop: string }>
    for (const p of sourcePending) {
      db.prepare(
        `INSERT INTO piece_pending_photos (piece_id, slot, url, crop, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(piece_id, slot) DO UPDATE SET
           url = excluded.url, crop = excluded.crop, updated_at = excluded.updated_at`,
      ).run(targetId, p.slot, p.url, p.crop, now)
    }
    const pendingSlots = new Set(sourcePending.map((p) => p.slot))

    // confirmadas (já baixadas) — só pro slot que não ganhou uma pendente acima.
    const sourceImages = db
      .prepare('SELECT slot, mime, storage_path, crop FROM piece_images WHERE piece_id = ?')
      .all(sourceId) as Array<{ slot: number; mime: string; storage_path: string; crop: string }>
    for (const img of sourceImages) {
      if (pendingSlots.has(img.slot) || !existsSync(img.storage_path)) continue
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
        `INSERT INTO piece_images (piece_id, slot, file_name, mime, storage_path, crop, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(piece_id, slot) DO UPDATE SET
           file_name = excluded.file_name, mime = excluded.mime,
           storage_path = excluded.storage_path, crop = excluded.crop, updated_at = excluded.updated_at`,
      ).run(targetId, img.slot, fileName, img.mime, newPath, img.crop, now)
    }
  })
  txn()

  res.json({ ok: true })
})

/** POST /api/pieces/:id/photo/:slot — { url } de uma foto do chat Shopee. NÃO baixa nada
 * ainda — só guarda a referência (piece_pending_photos) e o preview usa o hotlink direto
 * do CDN da Shopee. O download de verdade só acontece em POST .../confirm, pra não gastar
 * tempo/disco em foto de pedido que o operador pode nem confirmar. */
router.post('/pieces/:id/photo/:slot', requireAuth, (req, res) => {
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
  const fullUrl = shopeeCdnOriginalUrl(url)
  const now = nowMs()
  db.prepare(
    `INSERT INTO piece_pending_photos (piece_id, slot, url, crop, updated_at)
     VALUES (?, ?, ?, 'rosto', ?)
     ON CONFLICT(piece_id, slot) DO UPDATE SET url = excluded.url, updated_at = excluded.updated_at`,
  ).run(pieceId, slot, fullUrl, now)
  res.json({ ok: true, url: fullUrl, pending: true, updatedAt: now })
})

/** POST /api/pieces/:id/photo/:slot/upload — multipart "image", pro caso do cliente
 * mandar um link (Drive etc.) que o operador baixa na mão e sobe aqui, em vez de vir
 * do chat Shopee. Diferente da rota de URL acima: aqui NÃO fica pendente — já grava
 * direto em piece_images (o operador já baixou o arquivo de propósito, não faz sentido
 * adiar). Substitui qualquer pendência/confirmada anterior do mesmo slot. */
router.post('/pieces/:id/photo/:slot/upload', requireAuth, upload.single('image'), (req, res) => {
  const pieceId = Number(req.params.id)
  const slot = Number(req.params.slot)
  if (!Number.isFinite(pieceId) || pieceId <= 0 || (slot !== 1 && slot !== 2)) {
    res.status(400).json({ error: 'id/slot inválidos' })
    return
  }
  if (!req.file) {
    res.status(400).json({ error: 'Envie multipart "image"' })
    return
  }
  if (!req.file.mimetype.startsWith('image/')) {
    res.status(400).json({ error: 'Arquivo precisa ser imagem' })
    return
  }
  if (!pieceExists(pieceId)) {
    res.status(404).json({ error: 'Peça não encontrada' })
    return
  }
  const extension =
    req.file.mimetype === 'image/png' ? '.png' : req.file.mimetype === 'image/webp' ? '.webp' : '.jpg'
  const fileName = `piece_${pieceId}_s${slot}_${crypto.randomBytes(4).toString('hex')}${extension}`
  const storagePath = path.join(imagesDir, fileName)
  writeFileSync(storagePath, req.file.buffer)

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
      `INSERT INTO piece_images (piece_id, slot, file_name, mime, storage_path, crop, updated_at)
       VALUES (?, ?, ?, ?, ?, 'rosto', ?)
       ON CONFLICT(piece_id, slot) DO UPDATE SET
         file_name = excluded.file_name, mime = excluded.mime,
         storage_path = excluded.storage_path, updated_at = excluded.updated_at`,
    ).run(pieceId, slot, fileName, req.file!.mimetype, storagePath, now)
    db.prepare('DELETE FROM piece_pending_photos WHERE piece_id = ? AND slot = ?').run(pieceId, slot)
  })
  txn()

  res.json({ ok: true, updatedAt: now })
})

/**
 * POST /api/workbooks/:workbookId/pieces/:orderKey/confirm — baixa e salva de verdade
 * TODAS as fotos pendentes das peças do pedido (piece_pending_photos → piece_images).
 * Chamado pelo botão "Confirmar pedido" ANTES de marcar status "Pronto" — até esse
 * clique, as fotos eram só hotlink do CDN da Shopee, nada gravado no nosso disco.
 */
router.post('/workbooks/:workbookId/pieces/:orderKey/confirm', requireAuth, async (req, res) => {
  const { workbookId, orderKey } = req.params
  const pieces = db
    .prepare('SELECT id FROM order_pieces WHERE workbook_id = ? AND order_key = ?')
    .all(workbookId, orderKey) as Array<{ id: number }>
  const errors: string[] = []

  let downloadIndex = 0
  for (const { id: pieceId } of pieces) {
    const pending = db
      .prepare('SELECT slot, url, crop FROM piece_pending_photos WHERE piece_id = ?')
      .all(pieceId) as Array<{ slot: number; url: string; crop: string }>
    for (const p of pending) {
      // Espaça downloads pra não estourar rate-limit do CDN (várias originais de uma vez).
      if (downloadIndex > 0) await sleep(250)
      downloadIndex++
      try {
        const response = await fetchShopeeCdn(p.url)
        const buffer = Buffer.from(await response.arrayBuffer())
        const mime = response.headers.get('content-type') || 'image/jpeg'
        const ext = mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg'
        const fileName = `piece_${pieceId}_s${p.slot}_${crypto.randomBytes(4).toString('hex')}${ext}`
        const storagePath = path.join(imagesDir, fileName)
        writeFileSync(storagePath, buffer)

        const now = nowMs()
        const txn = db.transaction(() => {
          const existing = db
            .prepare('SELECT storage_path FROM piece_images WHERE piece_id = ? AND slot = ?')
            .get(pieceId, p.slot) as { storage_path: string } | undefined
          if (existing) {
            try {
              unlinkSync(existing.storage_path)
            } catch {
              // ignore
            }
          }
          db.prepare(
            `INSERT INTO piece_images (piece_id, slot, file_name, mime, storage_path, crop, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(piece_id, slot) DO UPDATE SET
               file_name = excluded.file_name, mime = excluded.mime, storage_path = excluded.storage_path,
               crop = excluded.crop, updated_at = excluded.updated_at`,
          ).run(pieceId, p.slot, fileName, mime, storagePath, p.crop, now)
          db.prepare('DELETE FROM piece_pending_photos WHERE piece_id = ? AND slot = ?').run(pieceId, p.slot)
        })
        txn()
      } catch (error) {
        errors.push(`peça ${pieceId} slot ${p.slot}: ${error instanceof Error ? error.message : 'erro'}`)
      }
    }
  }

  if (errors.length) {
    res.status(502).json({ ok: false, error: errors.join('; ') })
    return
  }
  res.json({ ok: true })
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
  const now = nowMs()
  const pendingResult = db
    .prepare('UPDATE piece_pending_photos SET crop = ?, updated_at = ? WHERE piece_id = ? AND slot = ?')
    .run(crop, now, pieceId, slot)
  const confirmedResult = db
    .prepare('UPDATE piece_images SET crop = ?, updated_at = ? WHERE piece_id = ? AND slot = ?')
    .run(crop, now, pieceId, slot)
  if (pendingResult.changes === 0 && confirmedResult.changes === 0) {
    res.status(404).json({ error: 'Foto não encontrada nesse slot' })
    return
  }
  res.json({ ok: true, crop })
})

/** DELETE /api/pieces/:id/photo/:slot — limpa tanto a pendente quanto a confirmada. */
router.delete('/pieces/:id/photo/:slot', requireAuth, (req, res) => {
  const pieceId = Number(req.params.id)
  const slot = Number(req.params.slot)
  const existing = db
    .prepare('SELECT storage_path FROM piece_images WHERE piece_id = ? AND slot = ?')
    .get(pieceId, slot) as { storage_path: string } | undefined
  const hadPending = db
    .prepare('SELECT 1 FROM piece_pending_photos WHERE piece_id = ? AND slot = ?')
    .get(pieceId, slot)
  if (!existing && !hadPending) {
    res.status(404).json({ error: 'Foto não encontrada' })
    return
  }
  if (existing) {
    try {
      unlinkSync(existing.storage_path)
    } catch {
      // ignore
    }
    db.prepare('DELETE FROM piece_images WHERE piece_id = ? AND slot = ?').run(pieceId, slot)
  }
  db.prepare('DELETE FROM piece_pending_photos WHERE piece_id = ? AND slot = ?').run(pieceId, slot)
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
