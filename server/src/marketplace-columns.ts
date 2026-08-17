/**
 * Layout compartilhado das planilhas automáticas de marketplace
 * (Shopee / TikTok / Mercado Livre) — mesmos índices A–R.
 */

export const MP_COL_ORDER_ID = 0 // A
export const MP_COL_PRODUCT = 1 // B
export const MP_COL_MODEL = 2 // C
export const MP_COL_QTY = 3 // D
export const MP_COL_USERNAME = 4 // E
export const MP_COL_INTERNAL_STATUS = 5 // F — fluxo manual (Pronto, Separado…)
export const MP_COL_RECIPIENT = 6 // G
export const MP_COL_MARKETPLACE_STATUS = 7 // H — status do canal
export const MP_PHOTO_COL_START = 8 // I — Foto 1
export const MP_PHOTO_COUNT = 10
export const MP_ROW_COLS = MP_PHOTO_COL_START + MP_PHOTO_COUNT // 18 (A–R)

export const MP_INTERNAL_STATUS_CANCELLED = 'Cancelado'
export const MP_INTERNAL_STATUS_SHIPPED = 'Concluído'

export function emptyMarketplaceRow(): string[] {
  return Array.from({ length: MP_ROW_COLS }, () => '')
}

export function marketplaceHeaders(statusHeader: string): string[] {
  return [
    'ID do pedido',
    'SKU',
    'Modelo',
    'Qnt.',
    'Nome de usuário',
    'Status',
    'Nome do destinatário',
    statusHeader,
    ...Array.from({ length: MP_PHOTO_COUNT }, (_, i) => `Foto ${i + 1}`),
  ]
}
