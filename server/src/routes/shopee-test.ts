import { Router, type Request, type Response } from 'express'

import { requireAuth } from '../auth.js'
import { env } from '../env.js'
import {
  buildAuthPartnerUrl,
  exchangeAuthCode,
  getConversationList,
  getItemBaseInfo,
  getItemList,
  getMessageList,
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

function parseOAuthInput(body: {
  code?: unknown
  shopId?: unknown
  callbackUrl?: unknown
}): { code: string; shopId: number } | { error: string } {
  let code = typeof body.code === 'string' ? body.code.trim() : ''
  let shopId = Number(body.shopId)
  if (typeof body.callbackUrl === 'string' && body.callbackUrl.trim()) {
    try {
      const url = new URL(body.callbackUrl.trim())
      code = url.searchParams.get('code') ?? code
      shopId = Number(url.searchParams.get('shop_id') ?? shopId)
    } catch {
      return { error: 'callbackUrl inválida' }
    }
  }
  if (!code || !shopId) return { error: 'code e shop_id obrigatórios' }
  return { code, shopId }
}

/** GET /api/shopee/oauth/callback — redirect público após autorização na Shopee */
router.get('/shopee/oauth/callback', async (req: Request, res: Response) => {
  const parsed = parseOAuthInput({
    code: req.query.code,
    shopId: req.query.shop_id,
  })
  if ('error' in parsed) {
    res.status(400).send(parsed.error)
    return
  }
  if (!shopeeConfigured()) {
    res.status(500).send('Shopee não configurada no servidor.')
    return
  }
  try {
    await exchangeAuthCode(parsed.code, parsed.shopId)
    res.redirect('/shopee-test.html?connected=1')
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Falha ao trocar código'
    res.status(500).send(msg)
  }
})

/** POST /api/shopee/oauth/exchange — colar URL ou code+shop_id (login) */
router.post('/shopee/oauth/exchange', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const parsed = parseOAuthInput(req.body as { code?: unknown; shopId?: unknown; callbackUrl?: unknown })
  if ('error' in parsed) {
    res.status(400).json({ error: parsed.error })
    return
  }
  try {
    const record = await exchangeAuthCode(parsed.code, parsed.shopId)
    res.json({ ok: true, shopId: record.shopId, accessExpireAt: record.accessExpireAt })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Falha ao trocar código',
    })
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

/** GET /api/shopee/products — proxy get_item_list */
router.get('/shopee/products', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const offset = Math.max(Number(req.query.offset ?? 0), 0)
  const pageSize = Math.min(Math.max(Number(req.query.pageSize ?? 20), 1), 100)
  const itemStatus = typeof req.query.itemStatus === 'string' ? req.query.itemStatus : 'NORMAL'
  const hours = Number(req.query.hours ?? 0)
  const now = Math.floor(Date.now() / 1000)
  try {
    const data = await getItemList({
      offset,
      pageSize,
      itemStatus,
      updateTimeFrom: hours > 0 ? now - hours * 3600 : undefined,
      updateTimeTo: hours > 0 ? now : undefined,
    })
    res.json({
      ok: true,
      query: { offset, pageSize, itemStatus, hours: hours > 0 ? hours : null },
      shopee: data,
    })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro na Shopee',
    })
  }
})

/** GET /api/shopee/products/detail — proxy get_item_base_info */
router.get('/shopee/products/detail', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const raw = typeof req.query.itemIds === 'string' ? req.query.itemIds : ''
  const itemIds = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (!itemIds.length) {
    res.status(400).json({ error: 'itemIds obrigatório (ex: ?itemIds=123,456)' })
    return
  }
  try {
    const data = await getItemBaseInfo(itemIds.slice(0, 50))
    res.json({ ok: true, query: { itemIds: itemIds.slice(0, 50) }, shopee: data })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro na Shopee',
    })
  }
})

/** GET /api/shopee/conversations — proxy get_conversation_list */
router.get('/shopee/conversations', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const direction = req.query.direction === 'oldest' ? 'oldest' : 'latest'
  const type =
    req.query.type === 'pinned' || req.query.type === 'unread' ? req.query.type : 'all'
  const pageSize = Math.min(Math.max(Number(req.query.pageSize ?? 20), 1), 50)
  try {
    const data = await getConversationList({ direction, type, pageSize })
    res.json({ ok: true, query: { direction, type, pageSize }, shopee: data })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro na Shopee',
    })
  }
})

/** GET /api/shopee/messages — proxy get_message */
router.get('/shopee/messages', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const conversationId = typeof req.query.conversationId === 'string' ? req.query.conversationId.trim() : ''
  if (!conversationId) {
    res.status(400).json({ error: 'conversationId obrigatório' })
    return
  }
  const pageSize = Math.min(Math.max(Number(req.query.pageSize ?? 20), 1), 50)
  const offset = Math.max(Number(req.query.offset ?? 0), 0)
  try {
    const data = await getMessageList({ conversationId, pageSize, offset })
    res.json({ ok: true, query: { conversationId, pageSize, offset }, shopee: data })
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
