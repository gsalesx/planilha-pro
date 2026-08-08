import { Router } from 'express'

import { requireAuth } from '../auth.js'
import { env } from '../env.js'
import {
  applyDaysToShipToItem,
  applyProductSkuUpdate,
  fetchProductCatalog,
  republishItem,
} from '../shopee-product-catalog.js'
import { shopApiPostDebug, updateItemUnlist } from '../shopee-api.js'

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

/** POST /api/shopee/products/days-to-ship — 1 produto por vez (client itera e mostra progresso;
 * escrever em paralelo estoura rate limit da Shopee com facilidade). */
router.post('/shopee/products/days-to-ship', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const body = req.body as { itemId?: unknown; daysToShip?: unknown }
  const itemId = Number(body.itemId)
  const daysToShip = Number(body.daysToShip)
  if (!Number.isFinite(itemId) || itemId <= 0 || !Number.isFinite(daysToShip)) {
    res.status(400).json({ error: 'itemId e daysToShip (número) obrigatórios' })
    return
  }
  try {
    await applyDaysToShipToItem(itemId, daysToShip)
    res.json({ ok: true, itemId })
  } catch (error) {
    res.status(502).json({
      ok: false,
      itemId,
      error: error instanceof Error ? error.message : 'Erro ao atualizar prazo de postagem',
    })
  }
})

/** POST /api/shopee/products/republish — 1 produto por vez, mesmo padrão de days-to-ship
 * (progresso real no client, sem estourar rate limit escrevendo em paralelo). */
router.post('/shopee/products/republish', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const body = req.body as { itemId?: unknown }
  const itemId = Number(body.itemId)
  if (!Number.isFinite(itemId) || itemId <= 0) {
    res.status(400).json({ error: 'itemId obrigatório' })
    return
  }
  try {
    await republishItem(itemId)
    res.json({ ok: true, itemId })
  } catch (error) {
    res.status(502).json({
      ok: false,
      itemId,
      error: error instanceof Error ? error.message : 'Erro ao publicar produto',
    })
  }
})

/** GET /api/shopee/products/republish-debug/:itemId — DIAGNÓSTICO TEMPORÁRIO. Testa os
 * DOIS jeitos de republicar: update_item(unlist:false) — confirmado que a Shopee aceita
 * mas NÃO aplica (a própria resposta volta com item_status:UNLIST ainda) — e o endpoint
 * dedicado /api/v2/product/unlist_item, que é o oficial pra alternar esse status em massa,
 * diferente do update_item genérico. Remover depois. */
router.get('/shopee/products/republish-debug/:itemId', requireAuth, async (req, res) => {
  const itemId = Number(req.params.itemId)
  if (!Number.isFinite(itemId) || itemId <= 0) {
    res.status(400).json({ error: 'itemId inválido' })
    return
  }
  try {
    const viaUpdateItem = await updateItemUnlist(itemId, false)
    const viaUnlistItem = await shopApiPostDebug('/api/v2/product/unlist_item', {
      item_list: [{ item_id: itemId, unlist: false }],
    })
    res.json({ ok: true, itemId, viaUpdateItem, viaUnlistItem })
  } catch (error) {
    res.status(502).json({ ok: false, error: error instanceof Error ? error.message : 'Erro na Shopee' })
  }
})

export default router
