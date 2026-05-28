import { existsSync, statSync, unlinkSync } from 'node:fs'

import { Router } from 'express'

import { requireAuth } from '../auth.js'
import { db, nowMs } from '../db.js'
import { env } from '../env.js'

const router = Router()

interface OrderRow {
  id: string
  row_json: string
  styles_json: string
  disappeared: number
  sheet_date: string
  position: number
  updated_at: number
}

interface ImageRow {
  order_id: string
  col: number
  file_name: string
  mime: string
  storage_path: string
}

function fileSize(p: string): number {
  try {
    return statSync(p).size
  } catch {
    return 0
  }
}

interface WorkbookRow {
  id: string
  name: string
  updated_at: number
  column_widths: string
}

function getWorkbook(id: string): WorkbookRow | undefined {
  return db
    .prepare('SELECT id, name, updated_at, column_widths FROM workbooks WHERE id = ?')
    .get(id) as WorkbookRow | undefined
}

function buildWorkbookPayload(workbookId: string, since?: number) {
  const wb = getWorkbook(workbookId)
  if (!wb) return null
  if (since != null && wb.updated_at <= since) {
    return { unchanged: true as const, updatedAt: wb.updated_at }
  }

  const orders = db
    .prepare(
      'SELECT id, row_json, styles_json, disappeared, sheet_date, position, updated_at FROM orders WHERE workbook_id = ? ORDER BY position ASC',
    )
    .all(workbookId) as OrderRow[]

  const images = db
    .prepare('SELECT order_id, col, file_name, mime, storage_path FROM images WHERE workbook_id = ?')
    .all(workbookId) as ImageRow[]
  const imagesByOrder = new Map<string, ImageRow[]>()
  for (const img of images) {
    const list = imagesByOrder.get(img.order_id) ?? []
    list.push(img)
    imagesByOrder.set(img.order_id, list)
  }

  return {
    unchanged: false as const,
    updatedAt: wb.updated_at,
    name: wb.name,
    columnWidths: JSON.parse(wb.column_widths || '{}') as Record<string, number>,
    orders: orders.map((o) => ({
      id: o.id,
      row: JSON.parse(o.row_json),
      styles: JSON.parse(o.styles_json || '{}'),
      disappeared: o.disappeared === 1,
      sheetDate: o.sheet_date || '',
      position: o.position,
      updatedAt: o.updated_at,
      images: (imagesByOrder.get(o.id) ?? []).map((i) => ({
        col: i.col,
        url: `/api/workbooks/${encodeURIComponent(workbookId)}/images/${encodeURIComponent(o.id)}/${i.col}`,
        fileName: i.file_name,
        mime: i.mime,
        size: fileSize(i.storage_path),
      })),
    })),
  }
}

router.get('/workbooks/:workbookId/data', requireAuth, (req, res) => {
  const since = req.query.since ? Number(req.query.since) : undefined
  const payload = buildWorkbookPayload(req.params.workbookId, since)
  if (!payload) {
    res.status(404).json({ error: 'Planilha não encontrada' })
    return
  }
  res.json(payload)
})

router.post('/workbooks/:workbookId/replace', requireAuth, (req, res) => {
  const workbookId = req.params.workbookId
  if (!getWorkbook(workbookId)) {
    res.status(404).json({ error: 'Planilha não encontrada' })
    return
  }
  const { orders, columnWidths } = req.body as {
    orders?: Array<{
      id: string
      row: unknown[]
      styles?: Record<string, { bg?: string }>
      disappeared?: boolean
      sheetDate?: string
    }>
    columnWidths?: Record<string, number>
  }

  if (!Array.isArray(orders)) {
    res.status(400).json({ error: 'Envie orders[]' })
    return
  }

  const now = nowMs()
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM orders WHERE workbook_id = ?').run(workbookId)
    const insertOrder = db.prepare(
      'INSERT INTO orders (workbook_id, id, row_json, styles_json, disappeared, sheet_date, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    orders.forEach((order, position) => {
      insertOrder.run(
        workbookId,
        order.id,
        JSON.stringify(order.row ?? []),
        JSON.stringify(order.styles ?? {}),
        order.disappeared ? 1 : 0,
        order.sheetDate ?? '',
        position,
        now,
      )
    })
    db.prepare('UPDATE workbooks SET updated_at = ?, column_widths = ? WHERE id = ?').run(
      now,
      JSON.stringify(columnWidths ?? {}),
      workbookId,
    )
  })
  txn()

  res.json({ ok: true, updatedAt: now, count: orders.length })
})

router.patch('/workbooks/:workbookId/orders/:id', requireAuth, (req, res) => {
  const workbookId = req.params.workbookId
  const id = req.params.id
  const existing = db
    .prepare('SELECT id FROM orders WHERE workbook_id = ? AND id = ?')
    .get(workbookId, id) as { id: string } | undefined
  if (!existing) {
    res.status(404).json({ error: 'Pedido não encontrado' })
    return
  }
  const patch = req.body as {
    row?: unknown[]
    styles?: Record<string, { bg?: string }>
    disappeared?: boolean
  }
  const sets: string[] = []
  const params: unknown[] = []
  if (Array.isArray(patch.row)) {
    sets.push('row_json = ?')
    params.push(JSON.stringify(patch.row))
  }
  if (patch.styles && typeof patch.styles === 'object') {
    sets.push('styles_json = ?')
    params.push(JSON.stringify(patch.styles))
  }
  if (typeof patch.disappeared === 'boolean') {
    sets.push('disappeared = ?')
    params.push(patch.disappeared ? 1 : 0)
  }
  if (sets.length === 0) {
    res.status(400).json({ error: 'Nada para atualizar' })
    return
  }
  const now = nowMs()
  sets.push('updated_at = ?')
  params.push(now, workbookId, id)
  const txn = db.transaction(() => {
    db.prepare(
      `UPDATE orders SET ${sets.join(', ')} WHERE workbook_id = ? AND id = ?`,
    ).run(...params)
    db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  })
  txn()
  res.json({ ok: true, updatedAt: now })
})

/* ===========================================================
   Endpoints automation-friendly (escopados por workbook)
   =========================================================== */

const STATUS_COL = 5

function serializeOrderRow(workbookId: string, o: OrderRow) {
  return {
    id: o.id,
    row: JSON.parse(o.row_json) as unknown[],
    styles: JSON.parse(o.styles_json || '{}'),
    disappeared: o.disappeared === 1,
    sheetDate: o.sheet_date || '',
    position: o.position,
    updatedAt: o.updated_at,
    images: (db
      .prepare('SELECT col, file_name, mime, storage_path FROM images WHERE workbook_id = ? AND order_id = ?')
      .all(workbookId, o.id) as ImageRow[]).map((i) => ({
      col: i.col,
      url: `/api/workbooks/${encodeURIComponent(workbookId)}/images/${encodeURIComponent(o.id)}/${i.col}`,
      fileName: i.file_name,
      mime: i.mime,
      size: fileSize(i.storage_path),
    })),
  }
}

/** GET /workbooks/:workbookId/orders?status=Separado&sheetDate=27-05-2026 */
router.get('/workbooks/:workbookId/orders', requireAuth, (req, res) => {
  const workbookId = req.params.workbookId
  if (!getWorkbook(workbookId)) {
    res.status(404).json({ error: 'Planilha não encontrada' })
    return
  }
  const status = typeof req.query.status === 'string' ? req.query.status : null
  const sheetDate = typeof req.query.sheetDate === 'string' ? req.query.sheetDate : null

  const where: string[] = ['workbook_id = ?']
  const params: unknown[] = [workbookId]
  if (sheetDate) {
    where.push('sheet_date = ?')
    params.push(sheetDate)
  }
  const rows = db
    .prepare(
      `SELECT id, row_json, styles_json, disappeared, sheet_date, position, updated_at
         FROM orders WHERE ${where.join(' AND ')} ORDER BY position ASC`,
    )
    .all(...params) as OrderRow[]

  const filtered = status == null
    ? rows
    : rows.filter((o) => {
        const row = JSON.parse(o.row_json) as unknown[]
        const v = row[STATUS_COL]
        return v != null && String(v) === status
      })

  res.json(filtered.map((o) => serializeOrderRow(workbookId, o)))
})

/** POST /workbooks/:workbookId/orders — cria pedido novo. Body: {id, row, sheetDate?} */
router.post('/workbooks/:workbookId/orders', requireAuth, (req, res) => {
  const workbookId = req.params.workbookId
  if (!getWorkbook(workbookId)) {
    res.status(404).json({ error: 'Planilha não encontrada' })
    return
  }
  const body = req.body as {
    id?: unknown
    row?: unknown
    sheetDate?: unknown
    styles?: Record<string, { bg?: string }>
    disappeared?: boolean
  }
  const id = typeof body.id === 'string' ? body.id.trim() : ''
  if (!id) {
    res.status(400).json({ error: 'id obrigatório' })
    return
  }
  if (!Array.isArray(body.row)) {
    res.status(400).json({ error: 'row[] obrigatório' })
    return
  }
  const exists = db
    .prepare('SELECT id FROM orders WHERE workbook_id = ? AND id = ?')
    .get(workbookId, id)
  if (exists) {
    res.status(409).json({ error: 'Pedido com este id já existe' })
    return
  }
  const sheetDate = typeof body.sheetDate === 'string' ? body.sheetDate : ''
  const now = nowMs()
  const maxPos = (db
    .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM orders WHERE workbook_id = ?')
    .get(workbookId) as { m: number }).m
  const txn = db.transaction(() => {
    db.prepare(
      'INSERT INTO orders (workbook_id, id, row_json, styles_json, disappeared, sheet_date, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      workbookId,
      id,
      JSON.stringify(body.row),
      JSON.stringify(body.styles ?? {}),
      body.disappeared ? 1 : 0,
      sheetDate,
      maxPos + 1,
      now,
    )
    db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  })
  txn()
  const created = db
    .prepare('SELECT id, row_json, styles_json, disappeared, sheet_date, position, updated_at FROM orders WHERE workbook_id = ? AND id = ?')
    .get(workbookId, id) as OrderRow
  res.status(201).json(serializeOrderRow(workbookId, created))
})

/** PATCH /workbooks/:workbookId/orders — bulk update de status. Body: [{id, status}].
 *  Pelo design, via API so o status pode ser atualizado em pedidos existentes.
 *  Foto: usar POST /images. Etiquetas: so manual na UI. Demais campos: so na criacao. */
router.patch('/workbooks/:workbookId/orders', requireAuth, (req, res) => {
  const workbookId = req.params.workbookId
  if (!getWorkbook(workbookId)) {
    res.status(404).json({ error: 'Planilha não encontrada' })
    return
  }
  const body = req.body as Array<{ id?: unknown; status?: unknown }>
  if (!Array.isArray(body)) {
    res.status(400).json({ error: 'Body deve ser array [{id, status}]' })
    return
  }
  const now = nowMs()
  const results: Array<{ id: string; ok: boolean; error?: string }> = []
  const txn = db.transaction(() => {
    for (const upd of body) {
      const id = typeof upd.id === 'string' ? upd.id : ''
      if (!id) {
        results.push({ id: '', ok: false, error: 'id obrigatório' })
        continue
      }
      if (typeof upd.status !== 'string') {
        results.push({ id, ok: false, error: 'status (string) obrigatório' })
        continue
      }
      const existing = db
        .prepare('SELECT row_json FROM orders WHERE workbook_id = ? AND id = ?')
        .get(workbookId, id) as { row_json: string } | undefined
      if (!existing) {
        results.push({ id, ok: false, error: 'não encontrado' })
        continue
      }
      const row = JSON.parse(existing.row_json) as unknown[]
      while (row.length <= STATUS_COL) row.push(null)
      row[STATUS_COL] = upd.status
      db.prepare(
        'UPDATE orders SET row_json = ?, updated_at = ? WHERE workbook_id = ? AND id = ?',
      ).run(JSON.stringify(row), now, workbookId, id)
      results.push({ id, ok: true })
    }
    db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  })
  txn()
  res.json({ ok: true, updatedAt: now, results })
})

/** DELETE /workbooks/:workbookId/orders?sheetDate=DD-MM-YYYY
 *  Apaga apenas os pedidos daquela data (e os arquivos de imagem em disco).
 *  Os demais pedidos do workbook ficam intactos. */
router.delete('/workbooks/:workbookId/orders', requireAuth, (req, res) => {
  const workbookId = req.params.workbookId
  if (!getWorkbook(workbookId)) {
    res.status(404).json({ error: 'Planilha não encontrada' })
    return
  }
  const sheetDate = typeof req.query.sheetDate === 'string' ? req.query.sheetDate : ''
  if (!sheetDate) {
    res.status(400).json({ error: 'sheetDate (query param) obrigatório' })
    return
  }

  // Coletar storage_paths das imagens dos pedidos da data antes do cascade.
  const imagePaths = db
    .prepare(
      `SELECT i.storage_path AS storage_path
         FROM images i
         INNER JOIN orders o ON o.workbook_id = i.workbook_id AND o.id = i.order_id
         WHERE i.workbook_id = ? AND o.sheet_date = ?`,
    )
    .all(workbookId, sheetDate) as Array<{ storage_path: string }>

  const now = nowMs()
  let deletedCount = 0
  const txn = db.transaction(() => {
    const result = db
      .prepare('DELETE FROM orders WHERE workbook_id = ? AND sheet_date = ?')
      .run(workbookId, sheetDate)
    deletedCount = result.changes
    db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  })
  txn()

  for (const row of imagePaths) {
    try {
      if (existsSync(row.storage_path)) unlinkSync(row.storage_path)
    } catch {
      // ignore
    }
  }

  res.json({ ok: true, deleted: deletedCount, sheetDate, updatedAt: now })
})

router.get('/health', (_req, res) => {
  res.json({ ok: true, dataDir: env.dataDir })
})

export default router
