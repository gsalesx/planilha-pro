import { db, nowMs } from './db.js'

/** ID fixo — planilha automática da Shopee (não pode ser excluída). */
export const SHOPEE_WORKBOOK_ID = 'wb_shopee'
export const SHOPEE_WORKBOOK_NAME = 'Shopee — automática'

export function isShopeeWorkbookId(id: string): boolean {
  return id === SHOPEE_WORKBOOK_ID
}

/** Garante que a planilha Shopee existe após boot / migration. */
export function ensureShopeeWorkbook(): void {
  const exists = db.prepare('SELECT id FROM workbooks WHERE id = ?').get(SHOPEE_WORKBOOK_ID)
  if (exists) return
  const now = nowMs()
  db.prepare(
    'INSERT INTO workbooks (id, name, created_at, updated_at, column_widths) VALUES (?, ?, ?, ?, ?)',
  ).run(SHOPEE_WORKBOOK_ID, SHOPEE_WORKBOOK_NAME, now, now, '{}')
  console.log('[shopee] planilha automática criada:', SHOPEE_WORKBOOK_ID)
}
