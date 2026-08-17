/**
 * Layout da planilha automática Shopee (wb_shopee).
 * Constantes reexportadas do layout compartilhado de marketplace — valores idênticos.
 */
export {
  MP_COL_ORDER_ID as SHOPEE_COL_ORDER_ID,
  MP_COL_PRODUCT as SHOPEE_COL_PRODUCT,
  MP_COL_MODEL as SHOPEE_COL_MODEL,
  MP_COL_QTY as SHOPEE_COL_QTY,
  MP_COL_USERNAME as SHOPEE_COL_USERNAME,
  MP_COL_INTERNAL_STATUS as SHOPEE_COL_INTERNAL_STATUS,
  MP_COL_RECIPIENT as SHOPEE_COL_RECIPIENT,
  MP_COL_MARKETPLACE_STATUS as SHOPEE_COL_SHOPEE_STATUS,
  MP_PHOTO_COL_START as SHOPEE_PHOTO_COL_START,
  MP_PHOTO_COUNT as SHOPEE_PHOTO_COUNT,
  MP_ROW_COLS as SHOPEE_ROW_COLS,
  MP_INTERNAL_STATUS_CANCELLED as SHOPEE_INTERNAL_STATUS_CANCELLED,
  MP_INTERNAL_STATUS_SHIPPED as SHOPEE_INTERNAL_STATUS_SHIPPED,
  emptyMarketplaceRow as emptyShopeeRow,
} from './marketplace-columns.js'

import { marketplaceHeaders } from './marketplace-columns.js'

export const SHOPEE_HEADERS = marketplaceHeaders('Status Shopee')
