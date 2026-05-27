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
    .prepare('SELECT order_id, col, file_name, mime FROM images WHERE workbook_id = ?')
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

router.get('/health', (_req, res) => {
  res.json({ ok: true, dataDir: env.dataDir })
})

export default router
