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

interface MetaRow {
  name: string
  updated_at: number
  column_widths: string
}

function getMeta(): MetaRow {
  return db
    .prepare('SELECT name, updated_at, column_widths FROM workbook_meta WHERE id = 1')
    .get() as MetaRow
}

function buildWorkbookPayload(since?: number) {
  const meta = getMeta()
  if (since != null && meta.updated_at <= since) {
    return { unchanged: true, updatedAt: meta.updated_at }
  }

  const orders = db
    .prepare(
      'SELECT id, row_json, styles_json, disappeared, sheet_date, position, updated_at FROM orders ORDER BY position ASC',
    )
    .all() as OrderRow[]

  const images = db.prepare('SELECT order_id, col, file_name, mime FROM images').all() as ImageRow[]
  const imagesByOrder = new Map<string, ImageRow[]>()
  for (const img of images) {
    const list = imagesByOrder.get(img.order_id) ?? []
    list.push(img)
    imagesByOrder.set(img.order_id, list)
  }

  return {
    unchanged: false,
    updatedAt: meta.updated_at,
    name: meta.name,
    columnWidths: JSON.parse(meta.column_widths || '{}') as Record<string, number>,
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
        url: `/api/images/${encodeURIComponent(o.id)}/${i.col}`,
        fileName: i.file_name,
        mime: i.mime,
      })),
    })),
  }
}

router.get('/workbook', requireAuth, (req, res) => {
  const since = req.query.since ? Number(req.query.since) : undefined
  res.json(buildWorkbookPayload(since))
})

router.post('/workbook/replace', requireAuth, (req, res) => {
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
    db.prepare('DELETE FROM orders').run()
    const insertOrder = db.prepare(
      'INSERT INTO orders (id, row_json, styles_json, disappeared, sheet_date, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    orders.forEach((order, position) => {
      insertOrder.run(
        order.id,
        JSON.stringify(order.row ?? []),
        JSON.stringify(order.styles ?? {}),
        order.disappeared ? 1 : 0,
        order.sheetDate ?? '',
        position,
        now,
      )
    })
    db.prepare('UPDATE workbook_meta SET updated_at = ?, column_widths = ? WHERE id = 1').run(
      now,
      JSON.stringify(columnWidths ?? {}),
    )
  })
  txn()

  res.json({ ok: true, updatedAt: now, count: orders.length })
})

router.patch('/orders/:id', requireAuth, (req, res) => {
  const id = req.params.id
  const existing = db.prepare('SELECT id FROM orders WHERE id = ?').get(id) as { id: string } | undefined
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
  params.push(now, id)
  const txn = db.transaction(() => {
    db.prepare(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    db.prepare('UPDATE workbook_meta SET updated_at = ? WHERE id = 1').run(now)
  })
  txn()
  res.json({ ok: true, updatedAt: now })
})

router.get('/health', (_req, res) => {
  res.json({ ok: true, dataDir: env.dataDir })
})

export default router
