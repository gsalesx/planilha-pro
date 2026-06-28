import { randomUUID } from 'node:crypto'

import { Router, type Request, type Response } from 'express'

import { requireAuth } from '../auth.js'
import { env } from '../env.js'
import {
  callbackUrlCandidates,
  getRecentShopeePushes,
  normalizePushAuthorization,
  recordShopeePush,
  resolveShopeeCallbackUrl,
  verifyShopeePushSignatureAny,
} from '../shopee-push.js'

const router = Router()

function rawBodyString(req: Request): string {
  const body = req.body
  if (Buffer.isBuffer(body)) return body.toString('utf8')
  if (typeof body === 'string') return body
  return ''
}

function parseJsonSafe(raw: string): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

/** POST /api/shopee/push — callback público da Shopee (2xx + body vazio). */
export function handleShopeePushPost(req: Request, res: Response): void {
  const rawBody = rawBodyString(req)
  const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : null
  const callbackUrl = resolveShopeeCallbackUrl(
    req.protocol,
    req.get('host') ?? 'localhost',
    req.originalUrl,
  )

  const partnerKeys = [...new Set([env.shopeePushPartnerKey, env.shopeePartnerKey].filter(Boolean))]
  const urlCandidates = callbackUrlCandidates(
    env.shopeePushCallbackUrl || undefined,
    req.protocol,
    req.get('host') ?? 'localhost',
    req.originalUrl,
  )

  let signatureOk: boolean | null = null
  if (partnerKeys.length && authorization) {
    signatureOk = verifyShopeePushSignatureAny(urlCandidates, rawBody, authorization, partnerKeys)
    if (!signatureOk) {
      const parsedFail = parseJsonSafe(rawBody)
      recordShopeePush({
        id: randomUUID(),
        receivedAt: Date.now(),
        callbackUrl,
        authorization,
        signatureOk: false,
        body: rawBody,
        parsed: parsedFail,
      })
      console.warn('[shopee-push] assinatura inválida', {
        callbackUrl,
        urlCandidates,
        authLen: authorization.length,
        authNorm: normalizePushAuthorization(authorization),
        bodyLen: rawBody.length,
        body: rawBody.slice(0, 400),
      })
      res.status(401).end()
      return
    }
  } else if (partnerKeys.length && !authorization) {
    console.warn('[shopee-push] Authorization ausente')
    res.status(401).end()
    return
  } else {
    console.warn('[shopee-push] SHOPEE_PUSH_PARTNER_KEY não configurada — aceitando sem validar assinatura')
  }

  const parsed = parseJsonSafe(rawBody)
  const entry = {
    id: randomUUID(),
    receivedAt: Date.now(),
    callbackUrl,
    authorization,
    signatureOk,
    body: rawBody,
    parsed,
  }
  recordShopeePush(entry)
  console.log('[shopee-push] recebido', {
    id: entry.id,
    code: typeof parsed === 'object' && parsed && 'code' in parsed ? (parsed as { code?: unknown }).code : undefined,
    shop_id: typeof parsed === 'object' && parsed && 'shop_id' in parsed ? (parsed as { shop_id?: unknown }).shop_id : undefined,
  })

  // Shopee exige 2xx com corpo vazio.
  res.status(200).end()
}

/** GET /api/shopee/push/recent — últimos pushes (auth UI/API). */
router.get('/shopee/push/recent', requireAuth, (_req, res) => {
  res.json({ ok: true, items: getRecentShopeePushes() })
})

export default router
