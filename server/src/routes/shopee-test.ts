import { Router, type Request, type Response } from 'express'

import { requireAuth } from '../auth.js'
import { env } from '../env.js'
import {
  buildAuthPartnerUrl,
  exchangeAuthCode,
  getOrderList,
  getShopInfo,
} from '../shopee-api.js'
import { clearShopeeAuth, loadShopeeAuth } from '../shopee-store.js'

const router = Router()

function shopeeConfigured(): boolean {
  return Boolean(env.shopeePartnerId && env.shopeePartnerKey)
}

function statusPayload() {
  const auth = loadShopeeAuth()
  return {
    configured: shopeeConfigured(),
    env: env.shopeeEnv,
    partnerId: env.shopeePartnerId || null,
    hasPartnerKey: Boolean(env.shopeePartnerKey),
    redirectUrl: env.shopeeRedirectUrl || null,
    shop: auth
      ? {
          shopId: auth.shopId,
          accessExpireAt: auth.accessExpireAt,
          updatedAt: auth.updatedAt,
        }
      : null,
  }
}

/** GET /api/shopee/status */
router.get('/shopee/status', requireAuth, (_req, res) => {
  res.json({ ok: true, ...statusPayload() })
})

/** GET /api/shopee/auth-url */
router.get('/shopee/auth-url', requireAuth, (_req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Defina SHOPEE_PARTNER_ID e SHOPEE_PARTNER_KEY' })
    return
  }
  if (!env.shopeeRedirectUrl) {
    res.status(400).json({ error: 'Defina SHOPEE_REDIRECT_URL (callback OAuth)' })
    return
  }
  res.json({ ok: true, url: buildAuthPartnerUrl() })
})

/** GET /api/shopee/oauth/callback — redirect público após autorização na Shopee */
router.get('/shopee/oauth/callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code : ''
  const shopIdRaw = typeof req.query.shop_id === 'string' ? req.query.shop_id : ''
  const shopId = Number(shopIdRaw)
  if (!code || !shopId) {
    res.status(400).send('Parâmetros code e shop_id obrigatórios.')
    return
  }
  if (!shopeeConfigured()) {
    res.status(500).send('Shopee não configurada no servidor.')
    return
  }
  try {
    await exchangeAuthCode(code, shopId)
    res.redirect('/shopee-test.html?connected=1')
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Falha ao trocar código'
    res.status(500).send(msg)
  }
})

/** GET /api/shopee/orders — proxy get_order_list */
router.get('/shopee/orders', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const hours = Math.min(Math.max(Number(req.query.hours ?? 24), 1), 24 * 15)
  const orderStatus = typeof req.query.orderStatus === 'string' ? req.query.orderStatus : ''
  const timeRangeField =
    req.query.timeRangeField === 'update_time' ? 'update_time' : 'create_time'
  const now = Math.floor(Date.now() / 1000)
  const timeFrom = now - hours * 3600
  try {
    const data = await getOrderList({
      timeFrom,
      timeTo: now,
      orderStatus: orderStatus || undefined,
      timeRangeField,
      pageSize: 50,
    })
    res.json({
      ok: true,
      query: { hours, orderStatus: orderStatus || null, timeRangeField, timeFrom, timeTo: now },
      shopee: data,
    })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro na Shopee',
    })
  }
})

/** GET /api/shopee/shop — get_shop_info */
router.get('/shopee/shop', requireAuth, async (_req, res) => {
  try {
    const data = await getShopInfo()
    res.json({ ok: true, shopee: data })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro na Shopee',
    })
  }
})

/** POST /api/shopee/disconnect */
router.post('/shopee/disconnect', requireAuth, (_req, res) => {
  clearShopeeAuth()
  res.json({ ok: true })
})

export default router
