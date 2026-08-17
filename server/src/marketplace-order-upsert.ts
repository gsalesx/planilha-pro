/**
 * Upsert compartilhado de pedidos de marketplace (TikTok, ML…).
 * Reutiliza padrões do shopee-order-sync mas aceita unitRows já mapeados.
 */
import { type AuditSource, recordAudit } from './audit.js'
import { db, nowMs } from './db.js'
import {
  MP_COL_INTERNAL_STATUS,
  MP_COL_ORDER_ID,
  MP_COL_PRODUCT,
  MP_COL_MODEL,
  MP_COL_QTY,
  MP_COL_USERNAME,
  MP_COL_MARKETPLACE_STATUS,
  MP_ROW_COLS,
} from './marketplace-columns.js'

export interface MarketplaceUpsertInput {
  workbookId: string
  orderId: string
  sheetDate: string
  /** Cada sub-array = 1 linha, já no layout MP_COL_*. */
  unitRows: string[][]
  productImageUrls?: (string | undefined)[]
  applyInternalStatus?: (row: string[], marketplaceStatus: string) => void
  source?: AuditSource
  runId?: string | null
  rotina?: string
}

interface ExistingRow {
  order_key: string
  row_json: string
  sheet_date: string
  product_image_url: string
}

function orderKey(orderId: string, occurrence: number): string {
  return occurrence === 1 ? orderId : `${orderId}#${occurrence}`
}

function findByKey(workbookId: string, key: string): ExistingRow | undefined {
  return db
    .prepare(
      'SELECT order_key, row_json, sheet_date, product_image_url FROM orders WHERE workbook_id = ? AND order_key = ?',
    )
    .get(workbookId, key) as ExistingRow | undefined
}

function findBySn(workbookId: string, orderId: string): ExistingRow[] {
  return db
    .prepare(
      'SELECT order_key, row_json, sheet_date, product_image_url FROM orders WHERE workbook_id = ? AND id = ? ORDER BY order_key ASC',
    )
    .all(workbookId, orderId) as ExistingRow[]
}

function posicaoNova(orderId: string, workbookId: string): number {
  const irma = db
    .prepare('SELECT MAX(position) AS p FROM orders WHERE workbook_id = ? AND id = ?')
    .get(workbookId, orderId) as { p: number | null }
  if (irma?.p == null) {
    const fim = db
      .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM orders WHERE workbook_id = ?')
      .get(workbookId) as { m: number }
    return fim.m + 1
  }
  const alvo = irma.p + 1
  db.prepare('UPDATE orders SET position = position + 1 WHERE workbook_id = ? AND position >= ?')
    .run(workbookId, alvo)
  return alvo
}

export function marketplaceUpsertOrder(input: MarketplaceUpsertInput): 'created' | 'updated' | 'unchanged' {
  const { workbookId, orderId, sheetDate, unitRows, applyInternalStatus } = input
  if (!orderId) throw new Error('orderId ausente')
  const now = nowMs()
  let anyCreated = false
  let anyChanged = false
  const auditBase = {
    source: input.source ?? ('api' as AuditSource),
    runId: input.runId ?? null,
    workbookId,
    orderSn: orderId,
  }
  const updateStmt = db.prepare(
    'UPDATE orders SET row_json = ?, sheet_date = ?, product_image_url = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?',
  )
  const insertStmt = db.prepare(
    `INSERT INTO orders (workbook_id, order_key, id, row_json, styles_json, disappeared, sheet_date, product_image_url, position, updated_at, parent_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )

  for (let i = 0; i < unitRows.length; i++) {
    const occurrence = i + 1
    const key = orderKey(orderId, occurrence)
    let existing = findByKey(workbookId, key)
    if (!existing && occurrence === 1) {
      const legacy = findBySn(workbookId, orderId)
      if (legacy.length === 1) existing = legacy[0]
    }

    const row = unitRows[i]
    while (row.length < MP_ROW_COLS) row.push('')
    const marketplaceStatus = row[MP_COL_MARKETPLACE_STATUS] ?? ''
    const productImageUrl = input.productImageUrls?.[i] ?? ''

    if (existing) {
      const prev = JSON.parse(existing.row_json) as string[]
      while (prev.length < MP_ROW_COLS) prev.push('')
      row[MP_COL_INTERNAL_STATUS] = prev[MP_COL_INTERNAL_STATUS]
      row[MP_COL_ORDER_ID] = prev[MP_COL_ORDER_ID] || row[MP_COL_ORDER_ID]
      row[MP_COL_PRODUCT] = prev[MP_COL_PRODUCT]
      row[MP_COL_MODEL] = prev[MP_COL_MODEL]
      row[MP_COL_QTY] = prev[MP_COL_QTY]
      row[MP_COL_USERNAME] = prev[MP_COL_USERNAME]
      if (applyInternalStatus) applyInternalStatus(row, marketplaceStatus)
      const rowJson = JSON.stringify(row)
      const nextImg = productImageUrl || existing.product_image_url
      if (rowJson !== existing.row_json || sheetDate !== existing.sheet_date || nextImg !== existing.product_image_url) {
        updateStmt.run(rowJson, sheetDate, nextImg, now, workbookId, existing.order_key)
        anyChanged = true
        recordAudit({
          ...auditBase,
          event: 'order.atualizada',
          orderKey: existing.order_key,
          detail: { rotina: input.rotina, occurrence, marketplaceStatus, sheetDate },
        })
      }
    } else {
      if (applyInternalStatus) applyInternalStatus(row, marketplaceStatus)
      anyCreated = true
      anyChanged = true
      const position = posicaoNova(orderId, workbookId)
      const parentKey = occurrence === 1 ? null : orderId
      insertStmt.run(
        workbookId,
        key,
        orderId,
        JSON.stringify(row),
        '{}',
        0,
        sheetDate,
        productImageUrl,
        position,
        now,
        parentKey,
      )
      recordAudit({
        ...auditBase,
        event: 'order.criada',
        orderKey: key,
        detail: { rotina: input.rotina, occurrence, position, sheetDate },
      })
    }
  }

  if (anyChanged) {
    db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  }
  return anyCreated ? 'created' : anyChanged ? 'updated' : 'unchanged'
}
