import { existsSync, statSync, unlinkSync } from 'node:fs'

import { Router } from 'express'

import { recordAudit } from '../audit.js'
import { requireAuth } from '../auth.js'
import { db, nowMs } from '../db.js'
import { env } from '../env.js'

const router = Router()

interface OrderRow {
  order_key: string
  id: string
  row_json: string
  styles_json: string
  disappeared: number
  sheet_date: string
  product_image_url: string
  position: number
  updated_at: number
}

interface ImageRow {
  order_id: string
  col: number
  file_name: string
  mime: string
  storage_path: string
  updated_at: number
}

interface CellStyle {
  bg?: string
  comment?: string
}

interface CellPatch {
  col?: unknown
  value?: unknown
}

interface StylePatch {
  col?: unknown
  bg?: unknown
  comment?: unknown
  clearBg?: unknown
  clearComment?: unknown
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

function uniqueOrderKey(rawKey: unknown, visibleId: string, position: number, used: Set<string>): string {
  const baseRaw = typeof rawKey === 'string' && rawKey.trim() ? rawKey.trim() : visibleId
  const base = (baseRaw || `order-${position}`).replace(/\s+/g, ' ').trim()
  let key = base
  let suffix = 2
  while (used.has(key)) {
    key = `${base}__${suffix}`
    suffix++
  }
  used.add(key)
  return key
}

function resolveOrderKey(workbookId: string, ref: string): { ok: true; key: string } | { ok: false; status: number; error: string } {
  const exact = db
    .prepare('SELECT order_key FROM orders WHERE workbook_id = ? AND order_key = ?')
    .get(workbookId, ref) as { order_key: string } | undefined
  if (exact) return { ok: true, key: exact.order_key }

  const matches = db
    .prepare('SELECT order_key FROM orders WHERE workbook_id = ? AND id = ?')
    .all(workbookId, ref) as Array<{ order_key: string }>
  if (matches.length === 1) return { ok: true, key: matches[0].order_key }
  if (matches.length > 1) return { ok: false, status: 409, error: 'ID de pedido duplicado; use a chave interna da linha' }
  return { ok: false, status: 404, error: 'Pedido não encontrado' }
}

function buildWorkbookPayload(workbookId: string, since?: number) {
  const wb = getWorkbook(workbookId)
  if (!wb) return null
  if (since != null && wb.updated_at <= since) {
    return { unchanged: true as const, updatedAt: wb.updated_at }
  }

  const orders = db
    .prepare(
      'SELECT order_key, id, row_json, styles_json, disappeared, sheet_date, product_image_url, position, updated_at FROM orders WHERE workbook_id = ? ORDER BY position ASC',
    )
    .all(workbookId) as OrderRow[]

  const images = db
    .prepare('SELECT order_id, col, file_name, mime, storage_path, updated_at FROM images WHERE workbook_id = ?')
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
      key: o.order_key,
      id: o.id,
      row: JSON.parse(o.row_json),
      styles: JSON.parse(o.styles_json || '{}'),
      disappeared: o.disappeared === 1,
      sheetDate: o.sheet_date || '',
      productImageUrl: o.product_image_url || '',
      position: o.position,
      updatedAt: o.updated_at,
      images: (imagesByOrder.get(o.order_key) ?? []).map((i) => ({
        col: i.col,
        url: `/api/workbooks/${encodeURIComponent(workbookId)}/images/${encodeURIComponent(o.order_key)}/${i.col}`,
        fileName: i.file_name,
        mime: i.mime,
        size: fileSize(i.storage_path),
        updatedAt: i.updated_at,
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
      key?: string
      id: string
      row: unknown[]
      styles?: Record<string, CellStyle>
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
  const existingImages = db
    .prepare('SELECT order_id, col, file_name, mime, storage_path, updated_at FROM images WHERE workbook_id = ?')
    .all(workbookId) as ImageRow[]
  const txn = db.transaction(() => {
    db.prepare('DELETE FROM orders WHERE workbook_id = ?').run(workbookId)
    const insertOrder = db.prepare(
      'INSERT INTO orders (workbook_id, order_key, id, row_json, styles_json, disappeared, sheet_date, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    const usedKeys = new Set<string>()
    orders.forEach((order, position) => {
      const visibleId = String(order.id || '').trim() || `order-${position}-${now}`
      const key = uniqueOrderKey(order.key, visibleId, position, usedKeys)
      insertOrder.run(
        workbookId,
        key,
        visibleId,
        JSON.stringify(order.row ?? []),
        JSON.stringify(order.styles ?? {}),
        order.disappeared ? 1 : 0,
        order.sheetDate ?? '',
        position,
        now,
      )
    })
    const insertImage = db.prepare(
      'INSERT INTO images (workbook_id, order_id, col, file_name, mime, storage_path, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    for (const img of existingImages) {
      if (!usedKeys.has(img.order_id)) continue
      insertImage.run(workbookId, img.order_id, img.col, img.file_name, img.mime, img.storage_path, img.updated_at)
    }
    db.prepare('UPDATE workbooks SET updated_at = ?, column_widths = ? WHERE id = ?').run(
      now,
      JSON.stringify(columnWidths ?? {}),
      workbookId,
    )
  })
  const antes = db
    .prepare('SELECT COUNT(*) AS n FROM orders WHERE workbook_id = ?')
    .get(workbookId) as { n: number }
  txn()
  // Replace apaga e reinsere o workbook inteiro (é o autosave da UI): sem registro, uma
  // linha que muda de data ou some aqui é indistinguível de escrita do sync.
  recordAudit({
    source: 'api',
    event: 'planilha.substituida',
    level: orders.length < antes.n ? 'warn' : 'info',
    workbookId,
    detail: { linhasAntes: antes.n, linhasDepois: orders.length },
  })

  res.json({ ok: true, updatedAt: now, count: orders.length })
})

router.patch('/workbooks/:workbookId/orders/:id', requireAuth, (req, res) => {
  const workbookId = req.params.workbookId
  const id = req.params.id
  const resolved = resolveOrderKey(workbookId, id)
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error })
    return
  }
  const patch = req.body as {
    row?: unknown[]
    cells?: CellPatch[]
    styles?: Record<string, CellStyle>
    stylePatches?: StylePatch[]
    disappeared?: boolean
  }

  const cellPatches = Array.isArray(patch.cells) ? patch.cells : null
  const stylePatches = Array.isArray(patch.stylePatches) ? patch.stylePatches : null
  if (cellPatches) {
    for (const item of cellPatches) {
      const col = Number(item.col)
      if (!Number.isInteger(col) || col < 0 || col > 200) {
        res.status(400).json({ error: 'Coluna inválida em cells[]' })
        return
      }
    }
  }

  if (stylePatches) {
    for (const item of stylePatches) {
      const col = Number(item.col)
      if (!Number.isInteger(col) || col < 0 || col > 200) {
        res.status(400).json({ error: 'Coluna inválida em stylePatches[]' })
        return
      }
    }
  }

  const hasRowPatch = cellPatches !== null || Array.isArray(patch.row)
  const hasStylePatch = stylePatches !== null || (!!patch.styles && typeof patch.styles === 'object' && !Array.isArray(patch.styles))
  const hasDisappearedPatch = typeof patch.disappeared === 'boolean'
  if (!hasRowPatch && !hasStylePatch && !hasDisappearedPatch) {
    res.status(400).json({ error: 'Nada para atualizar' })
    return
  }

  const now = nowMs()
  const txn = db.transaction(() => {
    const current = db
      .prepare('SELECT row_json, styles_json FROM orders WHERE workbook_id = ? AND order_key = ?')
      .get(workbookId, resolved.key) as { row_json: string; styles_json: string } | undefined
    if (!current) throw new Error('Pedido não encontrado')

    const sets: string[] = []
    const params: unknown[] = []
    if (cellPatches) {
      const row = JSON.parse(current.row_json || '[]') as unknown[]
      for (const item of cellPatches) {
        const col = Number(item.col)
        while (row.length <= col) row.push(null)
        row[col] = item.value ?? null
      }
      sets.push('row_json = ?')
      params.push(JSON.stringify(row))
    } else if (Array.isArray(patch.row)) {
      sets.push('row_json = ?')
      params.push(JSON.stringify(patch.row))
    }

    if (stylePatches) {
      const styles = JSON.parse(current.styles_json || '{}') as Record<string, CellStyle>
      for (const item of stylePatches) {
        const key = String(Number(item.col))
        const next = { ...(styles[key] ?? {}) }
        if (typeof item.bg === 'string') next.bg = item.bg
        if (item.clearBg === true) delete next.bg
        if (typeof item.comment === 'string') next.comment = item.comment
        if (item.clearComment === true) delete next.comment
        if (Object.keys(next).length === 0) delete styles[key]
        else styles[key] = next
      }
      sets.push('styles_json = ?')
      params.push(JSON.stringify(styles))
    } else if (patch.styles && typeof patch.styles === 'object' && !Array.isArray(patch.styles)) {
      sets.push('styles_json = ?')
      params.push(JSON.stringify(patch.styles))
    }

    if (hasDisappearedPatch) {
      sets.push('disappeared = ?')
      params.push(patch.disappeared ? 1 : 0)
    }

    sets.push('updated_at = ?')
    params.push(now, workbookId, resolved.key)
    db.prepare(
      `UPDATE orders SET ${sets.join(', ')} WHERE workbook_id = ? AND order_key = ?`,
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
    key: o.order_key,
    id: o.id,
    row: JSON.parse(o.row_json) as unknown[],
    styles: JSON.parse(o.styles_json || '{}'),
    disappeared: o.disappeared === 1,
    sheetDate: o.sheet_date || '',
    productImageUrl: o.product_image_url || '',
    position: o.position,
    updatedAt: o.updated_at,
    images: (db
      .prepare('SELECT col, file_name, mime, storage_path, updated_at FROM images WHERE workbook_id = ? AND order_id = ?')
      .all(workbookId, o.order_key) as ImageRow[]).map((i) => ({
      col: i.col,
      url: `/api/workbooks/${encodeURIComponent(workbookId)}/images/${encodeURIComponent(o.order_key)}/${i.col}`,
      fileName: i.file_name,
      mime: i.mime,
      size: fileSize(i.storage_path),
      updatedAt: i.updated_at,
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
      `SELECT order_key, id, row_json, styles_json, disappeared, sheet_date, product_image_url, position, updated_at
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
  const sheetDate = typeof body.sheetDate === 'string' ? body.sheetDate : ''
  const now = nowMs()
  const maxPos = (db
    .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM orders WHERE workbook_id = ?')
    .get(workbookId) as { m: number }).m
  const txn = db.transaction(() => {
    const orderKey = uniqueOrderKey(undefined, id, maxPos + 1, new Set(
      (db.prepare('SELECT order_key FROM orders WHERE workbook_id = ?').all(workbookId) as Array<{ order_key: string }>)
        .map((row) => row.order_key),
    ))
    db.prepare(
      'INSERT INTO orders (workbook_id, order_key, id, row_json, styles_json, disappeared, sheet_date, position, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      workbookId,
      orderKey,
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
    .prepare('SELECT order_key, id, row_json, styles_json, disappeared, sheet_date, product_image_url, position, updated_at FROM orders WHERE workbook_id = ? ORDER BY position DESC LIMIT 1')
    .get(workbookId) as OrderRow
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
      let matches = db
        .prepare('SELECT order_key, row_json FROM orders WHERE workbook_id = ? AND id = ?')
        .all(workbookId, id) as Array<{ order_key: string; row_json: string }>
      if (matches.length === 0) {
        matches = db
          .prepare('SELECT order_key, row_json FROM orders WHERE workbook_id = ? AND order_key = ?')
          .all(workbookId, id) as Array<{ order_key: string; row_json: string }>
      }
      if (matches.length === 0) {
        results.push({ id, ok: false, error: 'não encontrado' })
        continue
      }
      for (const existing of matches) {
        const row = JSON.parse(existing.row_json) as unknown[]
        while (row.length <= STATUS_COL) row.push(null)
        const statusAnterior = row[STATUS_COL]
        row[STATUS_COL] = upd.status
        db.prepare(
          'UPDATE orders SET row_json = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?',
        ).run(JSON.stringify(row), now, workbookId, existing.order_key)
        recordAudit({
          source: 'api',
          event: 'status.alterado',
          workbookId,
          orderKey: existing.order_key,
          orderSn: id,
          detail: { de: statusAnterior, para: upd.status, linhasDoPedido: matches.length },
        })
      }
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
         INNER JOIN orders o ON o.workbook_id = i.workbook_id AND o.order_key = i.order_id
         WHERE i.workbook_id = ? AND o.sheet_date = ?`,
    )
    .all(workbookId, sheetDate) as Array<{ storage_path: string }>

  const now = nowMs()
  let deletedCount = 0
  const apagadas = db
    .prepare('SELECT order_key, id FROM orders WHERE workbook_id = ? AND sheet_date = ?')
    .all(workbookId, sheetDate) as Array<{ order_key: string; id: string }>
  const txn = db.transaction(() => {
    const result = db
      .prepare('DELETE FROM orders WHERE workbook_id = ? AND sheet_date = ?')
      .run(workbookId, sheetDate)
    deletedCount = result.changes
    db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  })
  txn()
  recordAudit({
    source: 'api',
    event: 'pedidos.apagados',
    level: 'warn',
    workbookId,
    detail: { motivo: 'DELETE por data', sheetDate, quantidade: deletedCount, linhas: apagadas },
  })

  for (const row of imagePaths) {
    try {
      if (existsSync(row.storage_path)) unlinkSync(row.storage_path)
    } catch {
      // ignore
    }
  }

  res.json({ ok: true, deleted: deletedCount, sheetDate, updatedAt: now })
})

/** DELETE /workbooks/:workbookId/orders-batch — body { keys: string[] } (order_key exato).
 *  Apaga só os pedidos listados (e imagens em disco) — usado pra reverter import errado sem
 *  arriscar apagar pedido legítimo que caia na mesma sheet_date. */
router.delete('/workbooks/:workbookId/orders-batch', requireAuth, (req, res) => {
  const workbookId = req.params.workbookId
  if (!getWorkbook(workbookId)) {
    res.status(404).json({ error: 'Planilha não encontrada' })
    return
  }
  const keys = (req.body as { keys?: unknown })?.keys
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string')) {
    res.status(400).json({ error: 'keys (string[]) obrigatório' })
    return
  }

  const placeholders = keys.map(() => '?').join(',')
  const imagePaths = db
    .prepare(
      `SELECT storage_path FROM images WHERE workbook_id = ? AND order_id IN (${placeholders})`,
    )
    .all(workbookId, ...keys) as Array<{ storage_path: string }>

  const now = nowMs()
  let deletedCount = 0
  const apagadas = db
    .prepare(`SELECT order_key, id, row_json, sheet_date, position FROM orders WHERE workbook_id = ? AND order_key IN (${placeholders})`)
    .all(workbookId, ...keys) as Array<Record<string, unknown>>
  const txn = db.transaction(() => {
    const result = db
      .prepare(`DELETE FROM orders WHERE workbook_id = ? AND order_key IN (${placeholders})`)
      .run(workbookId, ...keys)
    deletedCount = result.changes
    db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  })
  txn()
  // Guarda o conteúdo da linha apagada: é a única chance de reconstruir depois.
  recordAudit({
    source: 'api',
    event: 'pedidos.apagados',
    level: 'warn',
    workbookId,
    detail: { motivo: 'DELETE por keys', pedidas: keys, quantidade: deletedCount, linhas: apagadas },
  })

  for (const row of imagePaths) {
    try {
      if (existsSync(row.storage_path)) unlinkSync(row.storage_path)
    } catch {
      // ignore
    }
  }

  res.json({ ok: true, deleted: deletedCount, requested: keys.length, updatedAt: now })
})

router.get('/health', (_req, res) => {
  res.json({ ok: true, dataDir: env.dataDir })
})

export default router
