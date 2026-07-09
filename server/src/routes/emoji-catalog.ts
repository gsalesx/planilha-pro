import crypto from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { Router } from 'express'
import multer from 'multer'

import { requireAuth } from '../auth.js'
import { db, nowMs } from '../db.js'
import { env } from '../env.js'
import { findAliasConflict, listCatalog, looksLikeEmoji, searchByName, type EmojiCatalogRow } from '../emoji-catalog.js'

function firstInvalidAlias(aliases: string[]): string | null {
  return aliases.find((a) => !looksLikeEmoji(a)) ?? null
}

const router = Router()
const customDir = path.join(env.dataDir, 'emoji-custom')
mkdirSync(customDir, { recursive: true })

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 },
})

/** GET /api/emoji-catalog?q=busca — lista tudo (ou filtra por nome). */
router.get('/emoji-catalog', requireAuth, (req, res) => {
  const q = typeof req.query.q === 'string' ? req.query.q : ''
  const items = q.trim() ? searchByName(q) : listCatalog()
  res.json({ ok: true, items })
})

/** POST /api/emoji-catalog — multipart: image + name (+ aliases[] opcional). Emoji customizado. */
router.post('/emoji-catalog', requireAuth, upload.single('image'), (req, res) => {
  const name = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
  if (!req.file) {
    res.status(400).json({ error: 'Envie multipart "image"' })
    return
  }
  if (!req.file.mimetype.startsWith('image/')) {
    res.status(400).json({ error: 'Arquivo precisa ser imagem' })
    return
  }
  if (!name) {
    res.status(400).json({ error: 'Nome obrigatório' })
    return
  }
  const existing = db.prepare('SELECT id FROM emoji_catalog WHERE name = ?').get(name)
  if (existing) {
    res.status(409).json({ error: `Já existe um emoji com o nome "${name}"` })
    return
  }
  let aliases: string[] = []
  const rawAliases = req.body?.aliases
  if (typeof rawAliases === 'string' && rawAliases.trim()) {
    try {
      const parsed = JSON.parse(rawAliases)
      if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === 'string')
    } catch {
      aliases = [rawAliases.trim()]
    }
  }
  aliases = [...new Set(aliases.map((a) => a.trim()).filter(Boolean))]
  const invalid = firstInvalidAlias(aliases)
  if (invalid) {
    res.status(400).json({ error: `"${invalid}" não parece um emoji válido` })
    return
  }
  const conflict = aliases.length ? findAliasConflict(aliases, null) : null
  if (conflict) {
    res.status(409).json({ error: `Atalho "${conflict.alias}" já está mapeado pra "${conflict.name}"` })
    return
  }

  const extension =
    req.file.mimetype === 'image/png' ? '.png' : req.file.mimetype === 'image/webp' ? '.webp' : '.jpg'
  const fileName = `${crypto.randomBytes(8).toString('hex')}${extension}`
  const storagePath = path.join(customDir, fileName)
  writeFileSync(storagePath, req.file.buffer)

  const now = nowMs()
  const info = db
    .prepare(
      `INSERT INTO emoji_catalog (name, aliases, image_path, source, created_at)
       VALUES (?, ?, ?, 'custom', ?)`,
    )
    .run(name, JSON.stringify(aliases), `/api/emoji-catalog/custom/${fileName}`, now)

  const row = db.prepare('SELECT * FROM emoji_catalog WHERE id = ?').get(info.lastInsertRowid) as EmojiCatalogRow
  res.json({ ok: true, item: { id: row.id, name: row.name, aliases, imageUrl: row.image_path, source: 'custom' } })
})

/** GET /api/emoji-catalog/custom/:fileName — serve o binário do emoji custom. */
router.get('/emoji-catalog/custom/:fileName', requireAuth, (req, res) => {
  const fileName = req.params.fileName
  const storagePath = path.join(customDir, fileName)
  if (!fileName.match(/^[a-f0-9]+\.(png|webp|jpg)$/) || !existsSync(storagePath)) {
    res.status(404).end()
    return
  }
  // fileName tem hash aleatório (crypto.randomBytes) — mesmo nome NUNCA muda de
  // conteúdo, pode cachear agressivo igual ao builtin.
  res.setHeader('cache-control', 'private, max-age=604800, immutable')
  createReadStream(storagePath).pipe(res)
})

/** PATCH /api/emoji-catalog/:id — body { aliases?: string[]; name?: string }.
 *  Renomear só é permitido pra source='custom' (o nome do builtin É o
 *  contrato com Moldes/EMOJIS/ do Criador de artes). */
router.patch('/emoji-catalog/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'id inválido' })
    return
  }
  const row = db.prepare('SELECT * FROM emoji_catalog WHERE id = ?').get(id) as EmojiCatalogRow | undefined
  if (!row) {
    res.status(404).json({ error: 'Emoji não encontrado' })
    return
  }
  const body = (req.body ?? {}) as Record<string, unknown>
  const updates: string[] = []
  const params: unknown[] = []
  if (Array.isArray(body.aliases)) {
    const aliases = [
      ...new Set(
        body.aliases
          .filter((a): a is string => typeof a === 'string')
          .map((a) => a.trim())
          .filter(Boolean),
      ),
    ]
    const invalid = firstInvalidAlias(aliases)
    if (invalid) {
      res.status(400).json({ error: `"${invalid}" não parece um emoji válido` })
      return
    }
    const conflict = findAliasConflict(aliases, id)
    if (conflict) {
      res.status(409).json({ error: `Atalho "${conflict.alias}" já está mapeado pra "${conflict.name}"` })
      return
    }
    updates.push('aliases = ?')
    params.push(JSON.stringify(aliases))
  }
  if (typeof body.name === 'string' && body.name.trim() && body.name.trim() !== row.name) {
    if (row.source === 'builtin') {
      res.status(400).json({ error: 'Não é possível renomear um emoji padrão' })
      return
    }
    updates.push('name = ?')
    params.push(body.name.trim())
  }
  if (updates.length === 0) {
    res.status(400).json({ error: 'Nada pra atualizar' })
    return
  }
  try {
    db.prepare(`UPDATE emoji_catalog SET ${updates.join(', ')} WHERE id = ?`).run(...params, id)
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : 'Falha ao atualizar' })
    return
  }
  const updated = db.prepare('SELECT * FROM emoji_catalog WHERE id = ?').get(id) as EmojiCatalogRow
  let aliases: string[] = []
  try {
    aliases = JSON.parse(updated.aliases)
  } catch {
    aliases = []
  }
  res.json({
    ok: true,
    item: { id: updated.id, name: updated.name, aliases, imageUrl: updated.image_path, source: updated.source },
  })
})

/** DELETE /api/emoji-catalog/:id — só emoji customizado (protege o catálogo builtin). */
router.delete('/emoji-catalog/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id)
  const row = db.prepare('SELECT * FROM emoji_catalog WHERE id = ?').get(id) as EmojiCatalogRow | undefined
  if (!row) {
    res.status(404).json({ error: 'Emoji não encontrado' })
    return
  }
  if (row.source !== 'custom') {
    res.status(400).json({ error: 'Não é possível remover um emoji padrão' })
    return
  }
  const fileName = path.basename(row.image_path)
  try {
    unlinkSync(path.join(customDir, fileName))
  } catch {
    // ignore
  }
  db.prepare('DELETE FROM emoji_catalog WHERE id = ?').run(id)
  res.json({ ok: true })
})

export default router
