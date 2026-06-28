import { Router } from 'express'

import { requireAuth } from '../auth.js'
import { env } from '../env.js'
import {
  applyBulkSkuUpdates,
  fetchProductCatalog,
  type CatalogProduct,
} from '../shopee-product-catalog.js'

const router = Router()

function shopeeConfigured(): boolean {
  return Boolean(env.shopeePartnerId && env.shopeePartnerKey)
}

/** GET /api/shopee/products/catalog — todos os produtos com SKU e variantes */
router.get('/shopee/products/catalog', requireAuth, async (_req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  try {
    const products = await fetchProductCatalog()
    res.json({ ok: true, count: products.length, products })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao carregar produtos',
    })
  }
})

/** POST /api/shopee/products/sku — edição em massa de SKU (item + variantes) */
router.post('/shopee/products/sku', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const body = req.body as { updates?: unknown; products?: unknown }
  const updatesRaw = body.updates
  if (!Array.isArray(updatesRaw) || !updatesRaw.length) {
    res.status(400).json({ error: 'updates[] obrigatório' })
    return
  }
  const updates = updatesRaw
    .map((row) => {
      const r = row as { itemId?: unknown; sku?: unknown }
      const itemId = Number(r.itemId)
      const sku = typeof r.sku === 'string' ? r.sku.trim() : ''
      if (!Number.isFinite(itemId) || itemId <= 0 || !sku) return null
      return { itemId, sku }
    })
    .filter((row): row is { itemId: number; sku: string } => row != null)

  if (!updates.length) {
    res.status(400).json({ error: 'Nenhuma atualização válida' })
    return
  }

  let catalog: CatalogProduct[] = []
  if (Array.isArray(body.products)) {
    catalog = body.products as CatalogProduct[]
  } else {
    try {
      catalog = await fetchProductCatalog()
    } catch {
      catalog = []
    }
  }

  try {
    const results = await applyBulkSkuUpdates(updates, catalog)
    const failed = results.filter((r) => !r.ok)
    res.json({
      ok: failed.length === 0,
      updated: results.filter((r) => r.ok).length,
      failed: failed.length,
      results,
    })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao atualizar SKU',
    })
  }
})

export default router
