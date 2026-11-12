import crypto from 'node:crypto'

import { Router, type NextFunction, type Response } from 'express'

import { requireAuth, type AuthenticatedRequest } from '../auth.js'
import { env } from '../env.js'
import { getResumoDia, hojeLoja } from '../resumo-dia.js'

const router = Router()

function tokenOk(presented: unknown): boolean {
  if (!env.resumoToken || typeof presented !== 'string' || !presented) return false
  const a = Buffer.from(presented.trim())
  const b = Buffer.from(env.resumoToken)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

/** X-Resumo-Token (só esta rota) ou login/API key do dono. O login de avaliação não vê vendas. */
function resumoAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  if (tokenOk(req.headers['x-resumo-token'])) {
    next()
    return
  }
  requireAuth(req, res, () => {
    if (req.sessionRole !== 'owner') {
      res.status(403).json({ error: 'Sem acesso ao resumo.' })
      return
    }
    next()
  })
}

/** GET /api/resumo-dia?data=DD-MM-YYYY&force=1 — vendas e anúncios Shopee do dia (padrão: hoje). */
router.get('/resumo-dia', resumoAuth, async (req, res) => {
  const data = typeof req.query.data === 'string' && req.query.data ? req.query.data : hojeLoja()
  try {
    const resumo = await getResumoDia(data, req.query.force === '1')
    res.set('Cache-Control', 'no-store').json(resumo)
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

export default router
