/**
 * Rotas Mercado Livre — chat, OAuth, sync, status.
 * Mesma shape de resposta que Shopee/TikTok pra compatibilidade com o client.
 */
import { Router, type Request, type Response } from 'express'

import { requireAuth } from '../auth.js'
import { env } from '../env.js'
import {
  buildMlAuthUrl,
  exchangeAuthCode,
  fetchAllMlMessages,
  mlConfigured,
  sendPackMessage,
} from '../mercadolivre-api.js'
import {
  getBuyerChatByUsername,
  linkConversationsScan,
  listLinkedBuyerUsernames,
} from '../mercadolivre-link-conversations.js'
import { syncRecentMercadoLivreOrders } from '../mercadolivre-order-sync.js'
import { clearMercadoLivreAuth, loadMercadoLivreAuth } from '../mercadolivre-store.js'
import { MERCADOLIVRE_WORKBOOK_ID } from '../marketplace.js'

const router = Router()

/** GET /api/mercadolivre/status */
router.get('/mercadolivre/status', requireAuth, (_req, res) => {
  const auth = loadMercadoLivreAuth()
  res.json({
    ok: true,
    configured: mlConfigured(),
    appId: env.mlAppId || null,
    redirectUrl: env.mlRedirectUrl || null,
    user: auth
      ? {
          userId: auth.userId,
          accessExpireAt: auth.accessExpireAt,
          updatedAt: auth.updatedAt,
        }
      : null,
  })
})

/** GET /api/mercadolivre/oauth/start */
router.get('/mercadolivre/oauth/start', requireAuth, (_req, res) => {
  if (!mlConfigured()) {
    res.status(400).json({ error: 'Defina ML_APP_ID e ML_CLIENT_SECRET' })
    return
  }
  res.json({ ok: true, url: buildMlAuthUrl() })
})

/** GET /api/mercadolivre/oauth/callback */
router.get('/mercadolivre/oauth/callback', async (req: Request, res: Response) => {
  const code = typeof req.query.code === 'string' ? req.query.code.trim() : ''
  if (!code) {
    res.status(400).send('code obrigatório')
    return
  }
  if (!mlConfigured()) {
    res.status(500).send('Mercado Livre não configurado no servidor.')
    return
  }
  try {
    await exchangeAuthCode(code)
    res.redirect('/?connected=mercadolivre')
  } catch (error) {
    res.status(500).send(error instanceof Error ? error.message : 'Falha ao trocar código')
  }
})

/** POST /api/mercadolivre/disconnect */
router.post('/mercadolivre/disconnect', requireAuth, (_req, res) => {
  clearMercadoLivreAuth()
  res.json({ ok: true })
})

/** POST /api/mercadolivre/sync */
router.post('/mercadolivre/sync', requireAuth, async (req, res) => {
  if (!mlConfigured()) {
    res.status(400).json({ error: 'Mercado Livre não configurado' })
    return
  }
  const hours = Math.min(Math.max(Number((req.body as { hours?: unknown })?.hours ?? 48), 1), 168)
  try {
    const result = await syncRecentMercadoLivreOrders({ hours, ctx: { source: 'manual' } })
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao sincronizar Mercado Livre',
    })
  }
})

/** GET /api/mercadolivre/buyer-chats */
router.get('/mercadolivre/buyer-chats', requireAuth, (_req, res) => {
  res.json({ ok: true, usernames: listLinkedBuyerUsernames() })
})

/** GET /api/mercadolivre/chat-history?username= */
router.get('/mercadolivre/chat-history', requireAuth, async (req, res) => {
  if (!mlConfigured()) {
    res.status(400).json({ error: 'Mercado Livre não configurado' })
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
  const auth = loadMercadoLivreAuth()
  if (!auth?.userId) {
    res.status(400).json({ error: 'ML não autenticado' })
    return
  }
  try {
    const history = await fetchAllMlMessages(chat.packId, auth.userId)
    res.json({
      ok: true,
      chat: {
        buyerUsername: chat.buyerUsername,
        conversationId: chat.packId,
        toId: Number(chat.buyerUserId) || 0,
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

/** POST /api/mercadolivre/messages/send */
router.post('/mercadolivre/messages/send', requireAuth, async (req, res) => {
  if (!mlConfigured()) {
    res.status(400).json({ error: 'Mercado Livre não configurado' })
    return
  }
  const conversationId = typeof req.body?.conversationId === 'string' ? req.body.conversationId.trim() : ''
  const text = typeof req.body?.text === 'string' ? req.body.text : ''
  if (!conversationId) {
    res.status(400).json({ error: 'conversationId (pack_id) obrigatório' })
    return
  }
  if (!text.trim()) {
    res.status(400).json({ error: 'text obrigatório' })
    return
  }
  const auth = loadMercadoLivreAuth()
  if (!auth?.userId) {
    res.status(400).json({ error: 'ML não autenticado' })
    return
  }
  try {
    const data = await sendPackMessage(conversationId, auth.userId, { text })
    res.json({ ok: true, data })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao enviar mensagem',
    })
  }
})

/** POST /api/mercadolivre/messages/send-preview */
router.post('/mercadolivre/messages/send-preview', requireAuth, async (_req, res) => {
  res.status(501).json({
    ok: false,
    error: 'Envio de imagem pelo chat do Mercado Livre não suportado pela API de mensagens. Use o painel do ML.',
  })
})

/** POST /api/mercadolivre/messages/start-conversation */
router.post('/mercadolivre/messages/start-conversation', requireAuth, async (_req, res) => {
  res.status(501).json({
    ok: false,
    error: 'Iniciar conversa pelo Mercado Livre não suportado — use o painel do vendedor.',
  })
})

/** POST /api/mercadolivre/link-conversations */
router.post('/mercadolivre/link-conversations', requireAuth, async (_req, res) => {
  if (!mlConfigured()) {
    res.status(400).json({ error: 'Mercado Livre não configurado' })
    return
  }
  try {
    const result = await linkConversationsScan(MERCADOLIVRE_WORKBOOK_ID)
    res.json({ ok: true, ...result })
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao vincular conversas',
    })
  }
})

export default router
