import crypto from 'node:crypto'
import type { NextFunction, Request, Response } from 'express'

import { db, nowMs } from './db.js'
import { env, isProd } from './env.js'

const COOKIE_NAME = 'planilha_session'
const TTL_MS = env.sessionTtlDays * 24 * 60 * 60 * 1000

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export function verifyCredentials(username: string, password: string): boolean {
  return (
    constantTimeEquals(username, env.authUsername) &&
    constantTimeEquals(password, env.authPassword)
  )
}

export function createSession(userAgent?: string): { token: string; expiresAt: number } {
  const token = crypto.randomBytes(32).toString('hex')
  const now = nowMs()
  const expiresAt = now + TTL_MS
  db.prepare(
    'INSERT INTO sessions (token, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?)',
  ).run(token, now, expiresAt, userAgent ?? null)
  return { token, expiresAt }
}

export function destroySession(token: string): void {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

export function readSession(token: string | undefined): { token: string; expiresAt: number } | null {
  if (!token) return null
  const row = db
    .prepare('SELECT token, expires_at AS expiresAt FROM sessions WHERE token = ? AND expires_at > ?')
    .get(token, nowMs()) as { token: string; expiresAt: number } | undefined
  return row ?? null
}

export function refreshSession(token: string): number {
  const newExpiry = nowMs() + TTL_MS
  db.prepare('UPDATE sessions SET expires_at = ? WHERE token = ?').run(newExpiry, token)
  return newExpiry
}

export function cleanupExpiredSessions(): void {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowMs())
}

export function setSessionCookie(res: Response, token: string, expiresAt: number): void {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: isProd,
    expires: new Date(expiresAt),
    path: '/',
  })
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' })
}

export interface AuthenticatedRequest extends Request {
  session?: { token: string; expiresAt: number }
}

function extractApiKey(req: Request): string | null {
  const auth = req.headers['authorization']
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim()
  }
  const apiKeyHeader = req.headers['x-api-key']
  if (typeof apiKeyHeader === 'string' && apiKeyHeader.trim().length > 0) {
    return apiKeyHeader.trim()
  }
  return null
}

function isValidApiKey(presented: string): boolean {
  if (!env.apiKey) return false
  if (presented.length === 0) return false
  return constantTimeEquals(presented, env.apiKey)
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  // 1) API key (automacoes): Authorization: Bearer X  ou  X-API-Key: X
  const presented = extractApiKey(req)
  if (presented && isValidApiKey(presented)) {
    next()
    return
  }

  // 2) Cookie de sessao (UI)
  const token = req.cookies?.[COOKIE_NAME] as string | undefined
  const session = readSession(token)
  if (!session) {
    res.status(401).json({ error: 'Não autenticado' })
    return
  }
  if (session.expiresAt - nowMs() < TTL_MS - 24 * 60 * 60 * 1000) {
    const newExpiry = refreshSession(session.token)
    setSessionCookie(res, session.token, newExpiry)
    session.expiresAt = newExpiry
  }
  req.session = session
  next()
}

export { COOKIE_NAME }
