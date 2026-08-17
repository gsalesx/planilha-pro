/**
 * Registro dos workbooks automáticos de marketplace.
 * Shopee / TikTok / Mercado Livre — cada um independente, mesmo layout.
 */
import { db, nowMs } from './db.js'
import { marketplaceHeaders } from './marketplace-columns.js'

export type MarketplaceChannel = 'shopee' | 'tiktok' | 'mercadolivre'

export interface MarketplaceWorkbookDef {
  id: string
  name: string
  channel: MarketplaceChannel
  /** Título da coluna H (status do canal). */
  statusHeader: string
}

export const SHOPEE_WORKBOOK_ID = 'wb_shopee'
export const TIKTOK_WORKBOOK_ID = 'wb_tiktok'
export const MERCADOLIVRE_WORKBOOK_ID = 'wb_mercadolivre'

export const MARKETPLACE_WORKBOOKS: readonly MarketplaceWorkbookDef[] = [
  {
    id: SHOPEE_WORKBOOK_ID,
    name: 'Shopee — automática',
    channel: 'shopee',
    statusHeader: 'Status Shopee',
  },
  {
    id: TIKTOK_WORKBOOK_ID,
    name: 'TikTok — automática',
    channel: 'tiktok',
    statusHeader: 'Status TikTok',
  },
  {
    id: MERCADOLIVRE_WORKBOOK_ID,
    name: 'Mercado Livre — automática',
    channel: 'mercadolivre',
    statusHeader: 'Status Mercado Livre',
  },
] as const

const BY_ID = new Map(MARKETPLACE_WORKBOOKS.map((w) => [w.id, w]))

export function isMarketplaceWorkbookId(id: string): boolean {
  return BY_ID.has(id)
}

export function isShopeeWorkbookId(id: string): boolean {
  return id === SHOPEE_WORKBOOK_ID
}

export function channelOfWorkbook(id: string): MarketplaceChannel | null {
  return BY_ID.get(id)?.channel ?? null
}

export function marketplaceDef(id: string): MarketplaceWorkbookDef | undefined {
  return BY_ID.get(id)
}

export function headersForMarketplaceWorkbook(id: string): string[] | null {
  const def = BY_ID.get(id)
  return def ? marketplaceHeaders(def.statusHeader) : null
}

/** Garante que as 3 planilhas de sistema existam após boot. */
export function ensureMarketplaceWorkbooks(): void {
  const now = nowMs()
  const insert = db.prepare(
    'INSERT OR IGNORE INTO workbooks (id, name, created_at, updated_at, column_widths) VALUES (?, ?, ?, ?, ?)',
  )
  for (const w of MARKETPLACE_WORKBOOKS) {
    const info = insert.run(w.id, w.name, now, now, '{}')
    if (info.changes > 0) {
      console.log(`[marketplace] planilha automática criada: ${w.id} (${w.name})`)
    }
  }
}
