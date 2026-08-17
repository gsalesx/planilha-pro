/**
 * Webhook TikTok Shop — recebe notificações de pedido.
 * Registrado DEPOIS do express.json (TikTok não exige body bruto pra HMAC
 * como a Shopee — a assinatura vai nos query params, não no body).
 */
import { Router, type Request, type Response } from 'express'

import { newRunId, recordAudit } from '../audit.js'
import { importTikTokOrderById } from '../tiktok-order-sync.js'

const router = Router()

/** POST /api/tiktok/push — webhook público */
router.post('/tiktok/push', (req: Request, res: Response) => {
  const body = req.body as Record<string, unknown> | undefined
  const type = typeof body?.type === 'number' ? body.type : (typeof body?.type === 'string' ? Number(body.type) : 0)
  const data = (body?.data ?? {}) as Record<string, unknown>

  const runId = newRunId('tiktok-push')
  recordAudit({
    source: 'push',
    runId,
    event: 'tiktok_push.recebido',
    detail: { type, payload: body },
  })

  // Responder rápido (TikTok exige 2xx)
  res.status(200).json({ code: 0, message: 'success' })

  // Processar async — order status change
  if (type === 1 || String(body?.type) === 'ORDER_STATUS_CHANGE') {
    const orderId = typeof data.order_id === 'string' ? data.order_id : ''
    if (orderId) {
      void importTikTokOrderById(orderId, { source: 'push', runId, rotina: 'tiktok-push' }).catch((err) => {
        console.error('[tiktok-push] import falhou', err instanceof Error ? err.message : err)
        recordAudit({ source: 'push', runId, event: 'tiktok_push.falhou', level: 'error', detail: { orderId, erro: String(err) } })
      })
    }
  }
})

export default router
