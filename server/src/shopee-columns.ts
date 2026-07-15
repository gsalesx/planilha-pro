/** Layout da planilha automática Shopee (wb_shopee). */

export const SHOPEE_COL_ORDER_ID = 0 // A
export const SHOPEE_COL_PRODUCT = 1 // B
export const SHOPEE_COL_MODEL = 2 // C
export const SHOPEE_COL_QTY = 3 // D
export const SHOPEE_COL_USERNAME = 4 // E
export const SHOPEE_COL_INTERNAL_STATUS = 5 // F — fluxo manual (Pronto, Separado…)
export const SHOPEE_COL_RECIPIENT = 6 // G
export const SHOPEE_COL_SHOPEE_STATUS = 7 // H — READY_TO_SHIP, SHIPPED, CANCELLED…
export const SHOPEE_PHOTO_COL_START = 8 // I — Foto 1
export const SHOPEE_PHOTO_COUNT = 10
export const SHOPEE_ROW_COLS = SHOPEE_PHOTO_COL_START + SHOPEE_PHOTO_COUNT // 18 (A–R)

export const SHOPEE_HEADERS = [
  'ID do pedido',
  'SKU',
  'Modelo',
  'Qnt.',
  'Nome de usuário',
  'Status',
  'Nome do destinatário',
  'Status Shopee',
  ...Array.from({ length: SHOPEE_PHOTO_COUNT }, (_, i) => `Foto ${i + 1}`),
]

export const SHOPEE_INTERNAL_STATUS_CANCELLED = 'Cancelado'
export const SHOPEE_INTERNAL_STATUS_SHIPPED = 'Concluído'

export function emptyShopeeRow(): string[] {
  return Array.from({ length: SHOPEE_ROW_COLS }, () => '')
}
