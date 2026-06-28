import crypto from 'node:crypto'
import { copyFileSync, existsSync, unlinkSync } from 'node:fs'
import path from 'node:path'

import { Router } from 'express'

import { requireAuth } from '../auth.js'
import { db, nowMs } from '../db.js'
import { env } from '../env.js'
import { isShopeeWorkbookId, SHOPEE_WORKBOOK_ID } from '../shopee-workbook.js'

const router = Router()
const imagesDir = path.join(env.dataDir, 'images')

interface WorkbookRow {
  id: string
  name: string
  created_at: number
  updated_at: number
  column_widths: string
}

interface ImageRow {
  workbook_id: string
  order_id: string
  col: number
  file_name: string
  mime: string
  storage_path: string
  updated_at: number
}

function newWorkbookId(): string {
  return 'wb_' + crypto.randomBytes(8).toString('hex')
}

function serializeWorkbook(row: WorkbookRow & { count?: number }) {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    columnWidths: JSON.parse(row.column_widths || '{}') as Record<string, number>,
    count: row.count ?? 0,
    system: isShopeeWorkbookId(row.id),
  }
}

router.get('/workbooks', requireAuth, (_req, res) => {
  const rows = db
    .prepare(
      `SELECT w.id, w.name, w.created_at, w.updated_at, w.column_widths,
              (SELECT COUNT(*) FROM orders o WHERE o.workbook_id = w.id) AS count
         FROM workbooks w
         ORDER BY CASE WHEN w.id = ? THEN 0 ELSE 1 END, w.updated_at DESC`,
    )
    .all(SHOPEE_WORKBOOK_ID) as Array<WorkbookRow & { count: number }>
  res.json(rows.map(serializeWorkbook))
})

router.post('/workbooks', requireAuth, (req, res) => {
  const name = String((req.body as { name?: unknown }).name ?? '').trim() || 'Sem nome'
  const id = newWorkbookId()
  const now = nowMs()
  db.prepare(
    'INSERT INTO workbooks (id, name, created_at, updated_at, column_widths) VALUES (?, ?, ?, ?, ?)',
  ).run(id, name, now, now, '{}')
  res.json(serializeWorkbook({ id, name, created_at: now, updated_at: now, column_widths: '{}', count: 0 }))
})

router.patch('/workbooks/:id', requireAuth, (req, res) => {
  const id = req.params.id
  if (isShopeeWorkbookId(id)) {
    res.status(403).json({ error: 'A planilha Shopee automática não pode ser renomeada' })
    return
  }
  const name = String((req.body as { name?: unknown }).name ?? '').trim()
  if (!name) {
    res.status(400).json({ error: 'Nome obrigatório' })
    return
  }
  const now = nowMs()
  const result = db
    .prepare('UPDATE workbooks SET name = ?, updated_at = ? WHERE id = ?')
    .run(name, now, id)
  if (result.changes === 0) {
    res.status(404).json({ error: 'Planilha não encontrada' })
    return
  }
  res.json({ ok: true, id, name, updatedAt: now })
})

router.delete('/workbooks/:id', requireAuth, (req, res) => {
  const id = req.params.id
  if (isShopeeWorkbookId(id)) {
    res.status(403).json({ error: 'A planilha Shopee automática não pode ser excluída' })
    return
  }
  const exists = db.prepare('SELECT id FROM workbooks WHERE id = ?').get(id)
  if (!exists) {
    res.status(404).json({ error: 'Planilha não encontrada' })
    return
  }
  // Coletar storage_paths das imagens antes do cascade pra apagar arquivos em disco.
  const imageRows = db
    .prepare('SELECT storage_path FROM images WHERE workbook_id = ?')
    .all(id) as Array<{ storage_path: string }>

  const txn = db.transaction(() => {
    // O cascade FK apaga orders e images quando workbooks é deletado.
    db.prepare('DELETE FROM workbooks WHERE id = ?').run(id)
  })
  txn()

  for (const row of imageRows) {
    try {
      if (existsSync(row.storage_path)) unlinkSync(row.storage_path)
    } catch {
      // ignore — arquivo já removido ou inacessível
    }
  }
  res.json({ ok: true })
})

router.post('/workbooks/:id/duplicate', requireAuth, (req, res) => {
  const sourceId = req.params.id
  const source = db
    .prepare('SELECT id, name, column_widths FROM workbooks WHERE id = ?')
    .get(sourceId) as { id: string; name: string; column_widths: string } | undefined
  if (!source) {
    res.status(404).json({ error: 'Planilha não encontrada' })
    return
  }
  const requestedName = String((req.body as { name?: unknown }).name ?? '').trim()
  const newName = requestedName || `${source.name} (cópia)`
  const newId = newWorkbookId()
  const now = nowMs()

  // Buscar dados ANTES da transação pra montar lista de cópias de arquivo.
  const orders = db
    .prepare(
      'SELECT order_key, id, row_json, styles_json, disappeared, sheet_date, position, updated_at FROM orders WHERE workbook_id = ?',
    )
    .all(sourceId) as Array<{
      order_key: string
      id: string
      row_json: string
      styles_json: string
      disappeared: number
      sheet_date: string
      position: number
      updated_at: number
    }>
  const images = db
    .prepare(
      'SELECT order_id, col, file_name, mime, storage_path, updated_at FROM images WHERE workbook_id = ?',
    )
    .all(sourceId) as Array<Omit<ImageRow, 'workbook_id'>>

  // Copiar arquivos em disco com novos nomes (pra delete do clone não apagar do original).
  const fileCopies: Array<{ src: string; dest: string; row: Omit<ImageRow, 'workbook_id'> }> = []
  for (const img of images) {
    const ext = path.extname(img.storage_path) || '.jpg'
    const safeOrder = img.order_id.replace(/[^A-Za-z0-9_-]/g, '_')
    const destName = `${safeOrder}_c${img.col}_${crypto.randomBytes(4).toString('hex')}${ext}`
    const destPath = path.join(imagesDir, destName)
    fileCopies.push({ src: img.storage_path, dest: destPath, row: img })
  }
  // Copiar fisicamente (best-effort: pula arquivo faltando).
  const copied: typeof fileCopies = []
  for (const c of fileCopies) {
    try {
      if (existsSync(c.src)) {
        copyFileSync(c.src, c.dest)
        copied.push(c)
      }
    } catch (error) {
      console.warn(`[duplicate] falha copiando ${c.src}:`, error)
    }
  }

  const txn = db.transaction(() => {
    db.prepare(
      'INSERT INTO workbooks (id, name, created_at, updated_at, column_widths) VALUES (?, ?, ?, ?, ?)',
    ).run(newId, newName, now, now, source.column_widths)

    const insertOrder = db.prepare(
      'INSERT INTO orders (workbook_id, order_key, id, row_json, styles_json, disappeared, sheet_date, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    for (const o of orders) {
      insertOrder.run(newId, o.order_key, o.id, o.row_json, o.styles_json, o.disappeared, o.sheet_date, o.position, now)
    }

    const insertImage = db.prepare(
      'INSERT INTO images (workbook_id, order_id, col, file_name, mime, storage_path, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    for (const c of copied) {
      insertImage.run(newId, c.row.order_id, c.row.col, c.row.file_name, c.row.mime, c.dest, now)
    }
  })
  try {
    txn()
  } catch (error) {
    // Rollback dos arquivos copiados se a transação falhar.
    for (const c of copied) {
      try {
        unlinkSync(c.dest)
      } catch {
        // ignore
      }
    }
    throw error
  }

  res.json(
    serializeWorkbook({
      id: newId,
      name: newName,
      created_at: now,
      updated_at: now,
      column_widths: source.column_widths,
      count: orders.length,
    }),
  )
})

export default router
