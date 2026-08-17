/**
 * Webhook Mercado Livre — notificações (orders_v2, messages).
 * ML envia POST com { topic, resource, user_id, ... }.
 */
import { Router, type Request, type Response } from 'express'

import { newRunId, recordAudit } from '../audit.js'
import { nowMs } from '../db.js'
import { importMercadoLivreOrderById } from '../mercadolivre-order-sync.js'
import { upsertMlBuyerChat } from '../mercadolivre-link-conversations.js'
import { mlConfigured } from '../mercadolivre-api.js'
import { loadMercadoLivreAuth } from '../mercadolivre-store.js'

const router = Router()

/** POST /api/mercadolivre/push */
router.post('/mercadolivre/push', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown> | undefined
  const topic = typeof body?.topic === 'string' ? body.topic : ''
  const resource = typeof body?.resource === 'string' ? body.resource : ''

  const runId = newRunId('ml-push')
  recordAudit({
    source: 'push',
    runId,
    event: 'ml_push.recebido',
    detail: { topic, resource, payload: body },
  })

  // ML exige 2xx rápido
  res.status(200).json({ ok: true })

  if (!mlConfigured() || !loadMercadoLivreAuth()) return

  // orders_v2 — fetch e import
  if (topic === 'orders_v2' && resource) {
    const match = resource.match(/\/orders\/(\d+)/)
    const orderId = match ? Number(match[1]) : 0
    if (orderId) {
      void importMercadoLivreOrderById(orderId, { source: 'push', runId, rotina: 'ml-push' }).catch((err) => {
        console.error('[ml-push] import falhou', err instanceof Error ? err.message : err)
        recordAudit({ source: 'push', runId, event: 'ml_push.falhou', level: 'error', detail: { orderId, erro: String(err) } })
      })
    }
  }

  // messages — tentar vincular buyer chat
  if (topic === 'messages' && resource) {
    const packMatch = resource.match(/\/packs\/(\d+)/)
    const packId = packMatch ? packMatch[1] : ''
    if (packId) {
      void (async () => {
        try {
          const auth = loadMercadoLivreAuth()
          if (!auth?.userId) return
          // Tentar encontrar o pedido associado ao pack pra extrair buyer info
          const page = await import('../mercadolivre-api.js').then((m) =>
            m.searchOrders({ seller: auth.userId, limit: 5 }),
          )
          for (const order of page.results ?? []) {
            if (String(order.pack_id ?? order.id) === packId && order.buyer?.nickname) {
              upsertMlBuyerChat({
                buyerUserId: String(order.buyer.id ?? ''),
                buyerUsername: order.buyer.nickname,
                packId,
                orderId: String(order.id ?? ''),
                updatedAt: nowMs(),
              })
              break
            }
          }
        } catch (err) {
          console.warn('[ml-push] link buyer falhou', err instanceof Error ? err.message : err)
        }
      })()
    }
  }
})

export default router
