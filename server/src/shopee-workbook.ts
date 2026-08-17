/**
 * Planilha automática Shopee — reexporta do registry de marketplace.
 * Mantém os mesmos exports para não quebrar imports existentes.
 */
export {
  SHOPEE_WORKBOOK_ID,
  isShopeeWorkbookId,
  ensureMarketplaceWorkbooks,
} from './marketplace.js'

import { ensureMarketplaceWorkbooks, SHOPEE_WORKBOOK_ID } from './marketplace.js'

export const SHOPEE_WORKBOOK_NAME = 'Shopee — automática'

/** @deprecated Prefer ensureMarketplaceWorkbooks — cria as 3 planilhas de sistema. */
export function ensureShopeeWorkbook(): void {
  ensureMarketplaceWorkbooks()
}

// Garante que o ID exportado continue resolvendo (tree-shake safe).
void SHOPEE_WORKBOOK_ID
