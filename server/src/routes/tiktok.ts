/**
 * Rotas TikTok — chat, OAuth, sync, status.
 * Mesma shape de resposta que as rotas Shopee pra compatibilidade com o client.
 */
import { existsSync } from 'node:fs'

import { Router, type Request, type Response } from 'express'

import { requireAuth } from '../auth.js'
import { db } from '../db.js'
import { env } from '../env.js'
import {
  buildTikTokAuthUrl,
  exchangeAuthCode,
  fetchAllTikTokMessages,
  sendConversationMessage,
  tiktokConfigured,
} from '../tiktok-api.js'
import {
  getBuyerChatByUsername,
  linkConversationsScan,
  listLinkedBuyerUsernames,
} from '../tiktok-link-conversations.js'
import { syncRecentTikTokOrders } from '../tiktok-order-sync.js'
import { clearTikTokAuth, loadTikTokAuth } from '../tiktok-store.js'
import { TIKTOK_WORKBOOK_ID } from '../marketplace.js'

const router = Router()

/** GET /api/tiktok/status */
router.get('/tiktok/status', requireAuth, (_req, res) => {
  const auth = loadTikTokAuth()
  res.json({
    ok: true,
    configured: tiktokConfigured(),
    appKey: env.tiktokAppKey || null,
    redirectUrl: env.tiktokRedirectUrl || null,
    shop: auth
      ? {
          accessExpireAt: auth.accessExpireAt,
          shopCipher: auth.shopCipher ?? null,
          openId: auth.openId ?? null,
          updatedAt: auth.updatedAt,
        }
      : null,
  })
})

/** GET /api/tiktok/oauth/start — redireciona pro TikTok */
router.get('/tiktok/oauth/start', requireAuth, (_req, res) => {
  if (!tiktokConfigured()) {
    res.status(400).json({ error: 'Defina TIKTOK_APP_KEY e TIKTOK_APP_SECRET' })
    return
  }
  res.json({ ok: true, url: buildTikTokAuthUrl() })
})

/** GET /api/tiktok/oauth/callback — redirect após autorização */
router.get('/tiktok/oauth/callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : ''
  if (!code) {
    res.status(400).send('code obrigatório')
    return
  }
  if (!tiktokConfigured()) {
    res.status(500).send('TikTok não configurado no servidor.')
    return
  }
  try {
    await exchangeAuthCode(code)
    res.redirect('/?connected=tiktok')
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : 'Falha ao trocar código')
  }
})

/** POST /api/tiktok/disconnect */
router.post('/tiktok/disconnect', requireAuth, (_req, res) => {
  clearTikTokAuth()
  res.json({ ok: true })
})

/** POST /api/tiktok/sync — sync manual */
router.post('/tiktok/sync', requireAuth, async (req, res) => {
  if (!tiktokConfigured()) {
    res.status(400).json({ error: 'TikTok não configurado' })
    return
  }
  const hours = Math.min(Math.max(Number((req.body as { hours?: unknown })?.hours ?? 24), 1), 168)
  try {
    const result = await syncRecentTikTokOrders({ hours, ctx: { source: 'manual' } })
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao sincronizar TikTok',
    })
  }
})

/** GET /api/tiktok/buyer-chats */
router.get('/tiktok/buyer-chats', requireAuth, (_req, res) => {
  res.json({ ok: true, usernames: listLinkedBuyerUsernames() })
})

/** GET /api/tiktok/chat-history?username= — mesma shape que /shopee/chat-history */
router.get('/tiktok/chat-history', requireAuth, async (req, res) => {
  if (!tiktokConfigured()) {
    res.status(400).json({ error: 'TikTok não configurado' })
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
    const history = await fetchAllTikTokMessages(chat.conversationId)
    res.json({
      ok: true,
      chat: {
        buyerUsername: chat.buyerUsername,
        conversationId: chat.conversationId,
        toId: 0,
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

/** POST /api/tiktok/messages/send */
router.post('/tiktok/messages/send', requireAuth, async (req, res) => {
  if (!tiktokConfigured()) {
    res.status(400).json({ error: 'TikTok não configurado' })
    return
  }
  const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId.trim() : ''
  const text = typeof req.body?.text === 'string' ? req.body.text : ''
  if (!conversationId) {
    res.status(400).json({ error: 'conversationId obrigatório' })
    return
  }
  if (!text.trim()) {
    res.status(400).json({ error: 'text obrigatório' })
    return
  }
  try {
    const data = await sendConversationMessage(conversationId, {
      type: 'text',
      content: { text },
    })
    res.json({ ok: true, data })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao enviar mensagem',
    })
  }
})

/** POST /api/tiktok/messages/send-preview — envia imagem da planilha */
router.post('/tiktok/messages/send-preview', requireAuth, async (req, res) => {
  if (!tiktokConfigured()) {
    res.status(400).json({ error: 'TikTok não configurado' })
    return
  }
  const username = typeof req.body?.username === 'string' ? req.body.username.trim() : ''
  const workbookId = typeof req.body?.workbookId === 'string' ? req.body.workbookId.trim() : ''
  const orderKey = typeof req.body?.orderKey === 'string' ? req.body.orderKey.trim() : ''
  const col = Number(req.body?.col)
  if (!username || !workbookId || !orderKey || !Number.isFinite(col) || col < 0) {
    res.status(400).json({ error: 'username, workbookId, orderKey e col obrigatórios' })
    return
  }
  const chat = getBuyerChatByUsername(username)
  if (!chat) {
    res.status(404).json({ error: 'Chat não vinculado' })
    return
  }
  const img = db
    .prepare('SELECT storage_path FROM images WHERE workbook_id = ? AND order_id = ? AND col = ?')
    .get(workbookId, orderKey, col) as { storage_path: string } | undefined
  if (!img?.storage_path || !existsSync(img.storage_path)) {
    res.status(404).json({ error: 'Imagem não encontrada' })
    return
  }
  // TikTok chat API não tem upload de imagem direto como Shopee — 501
  res.status(501).json({
    ok: false,
    error: 'Envio de imagem pelo chat TikTok ainda não suportado pela API. Use o painel do TikTok Seller Center.',
  })
})

/** POST /api/tiktok/messages/start-conversation — best-effort */
router.post('/tiktok/messages/start-conversation', requireAuth, async (_req, res) => {
  res.status(501).json({
    ok: false,
    error: 'Iniciar conversa pelo TikTok não suportado — use o Seller Center.',
  })
})

/** POST /api/tiktok/link-conversations — varredura manual */
router.post('/tiktok/link-conversations', requireAuth, async (_req, res) => {
  if (!tiktokConfigured()) {
    res.status(400).json({ error: 'TikTok não configurado' })
    return
  }
  try {
    const result = await linkConversationsScan(TIKTOK_WORKBOOK_ID)
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao vincular conversas',
    })
  }
})

export default router
