import { Router } from 'express'

import { requireAuth } from '../auth.js'
import { env } from '../env.js'
import {
  applyDaysToShipToAll,
  applyProductSkuUpdate,
  fetchProductCatalog,
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

/** POST /api/shopee/products/sku — um produto por vez (item_sku + variantes) */
router.post('/shopee/products/sku', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const body = req.body as { itemId?: unknown; sku?: unknown; updates?: unknown }

  let itemId = Number(body.itemId)
  let sku = typeof body.sku === 'string' ? body.sku.trim() : ''

  if ((!Number.isFinite(itemId) || itemId <= 0 || !sku) && Array.isArray(body.updates) && body.updates.length === 1) {
    const row = body.updates[0] as { itemId?: unknown; sku?: unknown }
    itemId = Number(row.itemId)
    sku = typeof row.sku === 'string' ? row.sku.trim() : ''
  }

  if (Array.isArray(body.updates) && body.updates.length > 1) {
    res.status(400).json({ error: 'Envie um produto por requisição (evita timeout)' })
    return
  }

  if (!Number.isFinite(itemId) || itemId <= 0 || !sku) {
    res.status(400).json({ error: 'itemId e sku obrigatórios' })
    return
  }

  try {
    await applyProductSkuUpdate(itemId, sku)
    res.json({ ok: true, itemId })
  } catch (error) {
    res.status(502).json({
      ok: false,
      itemId,
      error: error instanceof Error ? error.message : 'Erro ao atualizar SKU',
    })
  }
})

/** POST /api/shopee/products/days-to-ship — aplica o mesmo prazo de postagem a TODOS os produtos */
router.post('/shopee/products/days-to-ship', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const daysToShip = Number((req.body as { daysToShip?: unknown })?.daysToShip)
  if (!Number.isFinite(daysToShip)) {
    res.status(400).json({ error: 'daysToShip (número) obrigatório' })
    return
  }
  try {
    const results = await applyDaysToShipToAll(daysToShip)
    const ok = results.filter((r) => r.ok).length
    const failed = results.filter((r) => !r.ok)
    res.json({ ok: true, total: results.length, updated: ok, failed })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao atualizar prazo de postagem',
    })
  }
})

export default router
