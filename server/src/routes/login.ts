import { Router } from 'express'
import rateLimit from 'express-rate-limit'

import {
  AuthenticatedRequest,
  clearSessionCookie,
  COOKIE_NAME,
  createSession,
  destroySession,
  readSession,
  requireAuth,
  setSessionCookie,
  verifyCredentials,
} from '../auth.js'

const router = Router()

const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { error: 'Muitas tentativas. Tente novamente em alguns minutos.' },
  standardHeaders: true,
  legacyHeaders: false,
})

router.post('/login', loginLimiter, (req, res) => {
  const { username, password } = req.body ?? {}
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'Envie username e password.' })
    return
  }
  if (!verifyCredentials(username, password)) {
    res.status(401).json({ error: 'Credenciais inválidas.' })
    return
  }
  const ua = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined
  const { token, expiresAt } = createSession(ua)
  setSessionCookie(res, token, expiresAt)
  res.json({ ok: true })
})

router.post('/logout', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined
  if (token) destroySession(token)
  clearSessionCookie(res)
  res.json({ ok: true })
})

router.get('/me', (req: AuthenticatedRequest, res) => {
  const token = req.cookies?.[COOKIE_NAME] as string | undefined
  const session = readSession(token)
  if (!session) {
    res.status(401).json({ error: 'Não autenticado' })
    return
  }
  res.json({ authenticated: true, expiresAt: session.expiresAt })
})

router.get('/protected-ping', requireAuth, (_req, res) => {
  res.json({ pong: true })
})

export default router
