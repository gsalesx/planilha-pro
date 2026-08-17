/**
 * Layout da planilha automática Shopee — reexporta do registry de marketplace
 * para manter imports existentes (`isShopeeWorkbookId`, filtros, etc.).
 */
export {
  SHOPEE_WORKBOOK_ID,
  DEFAULT_PHOTO_COLUMN_INDEX,
  DEFAULT_PHOTO_COLUMN_INDICES,
  DEFAULT_MIN_COLUMN_COUNT,
  isShopeeWorkbookId,
  isMarketplaceWorkbookId,
  channelOfWorkbook,
  marketplaceDef,
  marketplaceStatusMatchValues,
  workbookLayout,
  photoColumnIndicesForWorkbook,
  headersForWorkbook,
  type MarketplaceChannel,
  type MarketplaceStatusFilterOption,
  type MarketplaceWorkbookDef,
  type WorkbookLayout,
} from './marketplace'

import {
  marketplaceDef,
  marketplaceHeaders,
  marketplaceStatusMatchValues,
  SHOPEE_WORKBOOK_ID,
  type MarketplaceStatusFilterOption,
} from './marketplace'

export const SHOPEE_PHOTO_COLUMN_START = 8
export const SHOPEE_PHOTO_COLUMN_INDICES = Array.from({ length: 10 }, (_, i) => SHOPEE_PHOTO_COLUMN_START + i)
export const SHOPEE_MIN_COLUMN_COUNT = 18
export const SHOPEE_STATUS_COLUMN_INDEX = 7

export type ShopeeStatusFilterOption = MarketplaceStatusFilterOption

const shopeeDef = marketplaceDef(SHOPEE_WORKBOOK_ID)!

export const SHOPEE_STATUS_FILTER_OPTIONS = shopeeDef.statusFilterOptions
export const SHOPEE_DEFAULT_STATUS_FILTER = shopeeDef.defaultStatusFilter

export function shopeeStatusMatchValues(filterValue: string): string[] {
  return marketplaceStatusMatchValues(SHOPEE_WORKBOOK_ID, filterValue)
}

export const SHOPEE_HEADERS = marketplaceHeaders('Status Shopee')
