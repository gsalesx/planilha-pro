import { Router, type Request, type Response } from 'express'

import { requireAuth } from '../auth.js'
import { env } from '../env.js'
import {
  buildAuthPartnerUrl,
  exchangeAuthCode,
  getConversationList,
  summarizeConversationPage,
  getItemBaseInfo,
  getItemList,
  getModelList,
  getMessageList,
  sendChatMessage,
  uploadChatImage,
  sendChatImageMessage,
  fetchAllChatMessages,
  getOrderList,
  getOrderDetail,
  getShopInfo,
  SHOPEE_CONVERSATION_SCAN_MAX,
} from '../shopee-api.js'
import {
  mapShopeeOrderToItemRows,
  mapShopeeOrderToRow,
  parseShopeeOrderDetail,
  resyncAllKnownOrders,
  resyncPendingDateOrders,
  resyncReadyToShipDates,
  syncRecentShopeeOrders,
  syncShopeeWorkbookOrders,
  SHOPEE_POLL_LOOKBACK_HOURS,
} from '../shopee-order-sync.js'
import { linkConversationsForWorkbook, linkConversationsScanChunk, getBuyerChatByUsername, listLinkedBuyerUsernames, getWorkbookLinkStatus, clearBuyerChatsForWorkbook, getLinkScanBootstrap, saveLinkStartCursor, loadLinkStartCursor, warmLinkStartCursorChunk } from '../shopee-link-conversations.js'
import {
  armAutoGreet,
  disarmAutoGreet,
  getAutoGreetLog,
  getAutoGreetState,
  DEFAULT_GREET_MESSAGE,
} from '../shopee-auto-greet.js'
import { clearShopeeAuth, loadShopeeAuth } from '../shopee-store.js'
import { db } from '../db.js'
import { existsSync } from 'node:fs'

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
    hasPushPartnerKey: Boolean(env.shopeePushPartnerKey),
    pushCallbackUrl: env.shopeePushCallbackUrl || null,
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

/** POST /api/shopee/sync-workbook — importa/atualiza pedidos na planilha wb_shopee */
router.post('/shopee/sync-workbook', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const body = req.body as { days?: unknown; offsetDays?: unknown }
  const days = Math.min(Math.max(Number(body.days ?? 90), 1), 365)
  const offsetDays = Math.max(Number(body.offsetDays ?? 0), 0)
  try {
    const result = await syncShopeeWorkbookOrders({ days, offsetDays })
    res.json({ ok: true, days, offsetDays, ...result })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao sincronizar planilha Shopee',
    })
  }
})

/**
 * POST /api/shopee/resync-all — reconfere TODO pedido já existente no workbook contra o
 * detalhe real na Shopee, um por um (status, data de envio, nome do destinatário). NUNCA lista
 * pedido novo via get_order_list — só atualiza order_sn que já está no nosso banco, então não
 * corre o risco de importar histórico não rastreado (ver `syncShopeeWorkbookOrders`, que faz
 * isso e já causou um import indesejado de ~3200 pedidos antigos em 2026-07-15).
 */
router.post('/shopee/resync-all', requireAuth, async (_req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  try {
    const result = await resyncAllKnownOrders()
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao reconferir pedidos',
    })
  }
})

/**
 * POST /api/shopee/sync-now — mesma rotina do poll de 2h (janela de 20h + reconsulta dos
 * pedidos "Sem data de envio" + reconferência de data de todo READY_TO_SHIP), disparada na
 * hora pelo botão da UI. Push está desativado.
 */
router.post('/shopee/sync-now', requireAuth, async (_req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  try {
    const recent = await syncRecentShopeeOrders({ hours: SHOPEE_POLL_LOOKBACK_HOURS })
    const pending = await resyncPendingDateOrders()
    const readyToShip = await resyncReadyToShipDates()
    res.json({
      ok: true,
      listed: recent.listed,
      created: recent.created,
      updated: recent.updated + pending.updated + readyToShip.updated,
      errors: [...recent.errors, ...pending.errors, ...readyToShip.errors],
      pendingRechecked: pending.listed,
      readyToShipRechecked: readyToShip.listed,
    })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao sincronizar pedidos Shopee',
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

/** GET /api/shopee/orders/detail?orderSn= — raw API + como mapeamos (1 linha vs 1 linha/item) */
router.get('/shopee/orders/detail', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const orderSn = typeof req.query.orderSn === 'string' ? req.query.orderSn.trim() : ''
  if (!orderSn) {
    res.status(400).json({ error: 'orderSn obrigatório' })
    return
  }
  try {
    const data = await getOrderDetail([orderSn])
    const orders = parseShopeeOrderDetail(data)
    const order = orders.find((o) => o.order_sn === orderSn) ?? orders[0]
    if (!order?.order_sn) {
      res.status(404).json({ ok: false, error: 'Pedido não encontrado na Shopee' })
      return
    }
    const items = order.item_list ?? []
    const raw = order as unknown as { create_time?: number; ship_by_date?: number }
    res.json({
      ok: true,
      orderSn,
      itemCount: items.length,
      order_status: order.order_status ?? '',
      create_time: raw.create_time ?? null,
      create_time_iso: raw.create_time ? new Date(raw.create_time * 1000).toISOString() : null,
      ship_by_date: raw.ship_by_date ?? null,
      ship_by_date_iso: raw.ship_by_date ? new Date(raw.ship_by_date * 1000).toISOString() : null,
      item_list: items,
      mappedNow: {
        description: 'Como gravamos hoje: 1 linha por pedido (itens concatenados com ;)',
        row: mapShopeeOrderToRow(order),
      },
      mappedPerItem: {
        description: 'Como export Shopee / planilha manual: 1 linha por item (mesmo ID repetido)',
        rows: mapShopeeOrderToItemRows(order),
      },
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

/** GET /api/shopee/products/models?itemId= — proxy get_model_list (debug preço/estoque por variante) */
router.get('/shopee/products/models', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const itemId = Number(req.query.itemId)
  if (!Number.isFinite(itemId) || itemId <= 0) {
    res.status(400).json({ error: 'itemId obrigatório' })
    return
  }
  try {
    const data = await getModelList(itemId)
    res.json({ ok: true, itemId, shopee: data })
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
  const directionRaw = typeof req.query.direction === 'string' ? req.query.direction.trim().toLowerCase() : 'latest'
  const direction =
    directionRaw === 'oldest' ||
    directionRaw === 'older' ||
    directionRaw === 'newest' ||
    directionRaw === 'latest'
      ? directionRaw
      : 'latest'
  const type =
    req.query.type === 'pinned' || req.query.type === 'unread' ? req.query.type : 'all'
  const pageSize = Math.min(Math.max(Number(req.query.pageSize ?? 50), 1), 50)
  const nextTimestampNano =
    typeof req.query.nextTimestampNano === 'string' && req.query.nextTimestampNano.trim()
      ? req.query.nextTimestampNano.trim()
      : undefined
  try {
    const data = await getConversationList({ direction, type, pageSize, nextTimestampNano })
    const body =
      data.response != null && typeof data.response === 'object'
        ? (data.response as Record<string, unknown>)
        : undefined
    const summary = body && !data.error ? summarizeConversationPage(body) : null
    res.json({
      ok: true,
      query: { direction, type, pageSize, nextTimestampNano: nextTimestampNano ?? null },
      summary,
      shopee: data,
    })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro na Shopee',
    })
  }
})

/** GET /api/shopee/buyer-chats — usernames com conversation_id vinculado */
router.get('/shopee/buyer-chats', requireAuth, (_req, res) => {
  res.json({ ok: true, usernames: listLinkedBuyerUsernames() })
})

/** GET /api/shopee/link-conversations/status?workbookId= */
router.get('/shopee/link-conversations/status', requireAuth, (req, res) => {
  const workbookId = typeof req.query.workbookId === 'string' ? req.query.workbookId.trim() : ''
  if (!workbookId) {
    res.status(400).json({ error: 'workbookId obrigatório' })
    return
  }
  res.json({ ok: true, workbookId, ...getWorkbookLinkStatus(workbookId) })
})

/** GET /api/shopee/link-conversations/bootstrap — cursor inicial (página 285) */
router.get('/shopee/link-conversations/bootstrap', requireAuth, (_req, res) => {
  try {
    const bootstrap = getLinkScanBootstrap()
    res.json({
      ok: true,
      configured: true,
      cursorSource: env.shopeeLinkStartTimestampNano ? 'env' : 'file',
      ...bootstrap,
    })
  } catch (error) {
    res.json({
      ok: false,
      configured: false,
      error: error instanceof Error ? error.message : 'Cursor não configurado',
    })
  }
})

/** POST /api/shopee/link-conversations/start-cursor — grava cursor da pág. 285 em /data */
router.post('/shopee/link-conversations/start-cursor', requireAuth, (req, res) => {
  const nextTimestampNano =
    typeof req.body?.nextTimestampNano === 'string' ? req.body.nextTimestampNano.trim() : ''
  if (!nextTimestampNano) {
    res.status(400).json({ error: 'nextTimestampNano obrigatório' })
    return
  }
  try {
    saveLinkStartCursor(nextTimestampNano)
    res.json({ ok: true, ...getLinkScanBootstrap() })
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Falha ao salvar cursor',
    })
  }
})

/** GET /api/shopee/link-conversations/start-cursor — status do cursor salvo */
router.get('/shopee/link-conversations/start-cursor', requireAuth, (_req, res) => {
  const cursor = loadLinkStartCursor()
  res.json({ ok: true, configured: Boolean(cursor), cursor: cursor ?? null })
})

/** POST /api/shopee/link-conversations/warm-cursor/chunk — avança 1 página até 284 e grava cursor da 285 */
router.post('/shopee/link-conversations/warm-cursor/chunk', requireAuth, async (req, res) => {
  const pageNumber = Math.max(0, Number(req.body?.pageNumber ?? 0))
  const nextTimestampNano =
    typeof req.body?.nextTimestampNano === 'string' ? req.body.nextTimestampNano.trim() : undefined
  try {
    const result = await warmLinkStartCursorChunk({ pageNumber, nextTimestampNano })
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro na Shopee',
    })
  }
})

/** POST /api/shopee/buyer-chats/clear — apaga vínculos dos compradores desta planilha */
router.post('/shopee/buyer-chats/clear', requireAuth, (req, res) => {
  const workbookId = typeof req.body?.workbookId === 'string' ? req.body.workbookId.trim() : ''
  if (!workbookId) {
    res.status(400).json({ error: 'workbookId obrigatório' })
    return
  }
  const cleared = clearBuyerChatsForWorkbook(workbookId)
  res.json({ ok: true, workbookId, cleared })
})

/** GET /api/shopee/chat-history?username= — histórico completo do chat vinculado */
router.get('/shopee/chat-history', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const username = typeof req.query.username === 'string' ? req.query.username.trim() : ''
  if (!username) {
    res.status(400).json({ error: 'username obrigatório' })
    return
  }
  const chat = getBuyerChatByUsername(username)
  if (!chat) {
    res.status(404).json({ error: 'Chat não vinculado para este username (col E)' })
    return
  }
  try {
    const history = await fetchAllChatMessages(chat.conversationId, chat.toId)
    res.json({
      ok: true,
      chat: {
        buyerUsername: chat.buyerUsername,
        conversationId: chat.conversationId,
        toId: chat.toId,
        updatedAt: chat.updatedAt,
      },
      ...history,
    })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao buscar mensagens',
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
  const rawOffset = req.query.offset
  const offset =
    rawOffset === undefined || rawOffset === '' || rawOffset === 'latest'
      ? ''
      : Math.max(Number(rawOffset), 0)
  try {
    const data = await getMessageList({ conversationId, pageSize, offset })
    res.json({
      ok: true,
      query: {
        conversationId,
        pageSize,
        offset: offset === '' ? 'latest' : offset,
      },
      shopee: data,
    })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro na Shopee',
    })
  }
})

/** POST /api/shopee/messages/send — proxy send_message (texto) */
router.post('/shopee/messages/send', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const toId = Number(req.body?.toId)
  const text = typeof req.body?.text === 'string' ? req.body.text : ''
  const conversationId =
    typeof req.body?.conversationId === 'string' ? req.body.conversationId.trim() : undefined
  const businessType = Number(req.body?.businessType ?? 0)
  if (!toId || toId <= 0) {
    res.status(400).json({ error: 'toId obrigatório' })
    return
  }
  if (!text.trim()) {
    res.status(400).json({ error: 'text obrigatório' })
    return
  }
  try {
    const data = await sendChatMessage({ toId, text, conversationId, businessType })
    res.json({
      ok: true,
      query: { toId, conversationId: conversationId ?? null, businessType, text },
      shopee: data,
    })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro na Shopee',
    })
  }
})

/** POST /api/shopee/messages/send-preview — upload imagem da planilha + send_message image */
router.post('/shopee/messages/send-preview', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
  const workbookId = typeof req.body?.workbookId === 'string' ? req.body.workbookId.trim() : ''
  const orderKey = typeof req.body?.orderKey === 'string' ? req.body.orderKey.trim() : ''
  const col = Number(req.body?.col)
  if (!username) {
    res.status(400).json({ error: 'username obrigatório' })
    return
  }
  if (!workbookId || !orderKey) {
    res.status(400).json({ error: 'workbookId e orderKey obrigatórios' })
    return
  }
  if (!Number.isFinite(col) || col < 0) {
    res.status(400).json({ error: 'col inválida' })
    return
  }
  const chat = getBuyerChatByUsername(username)
  if (!chat) {
    res.status(404).json({ error: 'Chat não vinculado' })
    return
  }
  const img = db
    .prepare(
      'SELECT storage_path FROM images WHERE workbook_id = ? AND order_id = ? AND col = ?',
    )
    .get(workbookId, orderKey, col) as { storage_path: string } | undefined
  if (!img?.storage_path || !existsSync(img.storage_path)) {
    res.status(404).json({ error: 'Imagem não encontrada' })
    return
  }
  try {
    const shopeeImageUrl = await uploadChatImage(img.storage_path)
    await sendChatImageMessage({
      toId: chat.toId,
      imageUrl: shopeeImageUrl,
    })
    res.json({
      ok: true,
      query: { username, workbookId, orderKey, col },
      shopeeImageUrl,
    })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro na Shopee',
    })
  }
})

/** POST /api/shopee/link-conversations/scan-chunk — uma página por request (evita 502) */
router.post('/shopee/link-conversations/scan-chunk', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const workbookId = typeof req.body?.workbookId === 'string' ? req.body.workbookId.trim() : ''
  if (!workbookId) {
    res.status(400).json({ error: 'workbookId obrigatório' })
    return
  }
  const nextTimestampNano =
    typeof req.body?.nextTimestampNano === 'string' && req.body.nextTimestampNano.trim()
      ? req.body.nextTimestampNano.trim()
      : undefined
  const pageNumber = Math.max(Number(req.body?.pageNumber ?? 0), 0)
  const scannedBefore = Math.max(Number(req.body?.scannedBefore ?? 0), 0)
  const indexedBefore = Math.max(Number(req.body?.indexedBefore ?? 0), 0)
  try {
    const result = await linkConversationsScanChunk(workbookId, {
      nextTimestampNano,
      pageNumber,
      scannedBefore,
      indexedBefore,
    })
    res.json({ ok: true, workbookId, ...result })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao varrer conversas',
    })
  }
})

/** POST /api/shopee/link-conversations — username (col E) + conversation_id (não altera pedidos) */
router.post('/shopee/link-conversations', requireAuth, async (req, res) => {
  if (!shopeeConfigured()) {
    res.status(400).json({ error: 'Shopee não configurada' })
    return
  }
  const workbookId = typeof req.body?.workbookId === 'string' ? req.body.workbookId.trim() : ''
  if (!workbookId) {
    res.status(400).json({ error: 'workbookId obrigatório' })
    return
  }
  const maxRaw = Number(req.body?.maxConversations)
  const maxConversations =
    Number.isFinite(maxRaw) && maxRaw > 0
      ? Math.min(Math.floor(maxRaw), SHOPEE_CONVERSATION_SCAN_MAX)
      : undefined
  const startTimestampNano =
    typeof req.body?.startTimestampNano === 'string' && req.body.startTimestampNano.trim()
      ? req.body.startTimestampNano.trim()
      : undefined
  try {
    const result = await linkConversationsForWorkbook(workbookId, { maxConversations, startTimestampNano })
    res.json({ ok: true, workbookId, ...result })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao vincular conversas',
    })
  }
})

/** GET /api/shopee/auto-greet — estado do disparo + últimos envios */
router.get('/shopee/auto-greet', requireAuth, (_req, res) => {
  res.json({
    ok: true,
    defaultMessage: DEFAULT_GREET_MESSAGE,
    state: getAutoGreetState(),
    log: getAutoGreetLog(20),
  })
})

/** POST /api/shopee/auto-greet/arm — arma o disparo na PRÓXIMA compra READY_TO_SHIP */
router.post('/shopee/auto-greet/arm', requireAuth, (req, res) => {
  const message = typeof req.body?.message === 'string' ? req.body.message : undefined
  const state = armAutoGreet(message)
  res.json({ ok: true, state })
})

/** POST /api/shopee/auto-greet/disarm — cancela o disparo armado */
router.post('/shopee/auto-greet/disarm', requireAuth, (_req, res) => {
  res.json({ ok: true, state: disarmAutoGreet() })
})

/** POST /api/shopee/disconnect */
router.post('/shopee/disconnect', requireAuth, (_req, res) => {
  clearShopeeAuth()
  res.json({ ok: true })
})

export default router
