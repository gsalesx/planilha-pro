import { randomUUID } from 'node:crypto'

import { Router, type Request, type Response } from 'express'

import { newRunId, recordAudit } from '../audit.js'
import { requireAuth } from '../auth.js'
import { env } from '../env.js'
import {
  callbackUrlCandidates,
  getRecentShopeePushes,
  isShopeeUrlVerificationPush,
  normalizePushAuthorization,
  recordShopeePush,
  resolveShopeeCallbackUrl,
  verifyShopeePushSignatureAny,
} from '../shopee-push.js'
import { processShopeePush } from '../shopee-push-process.js'
import { getRecentWebchatPushes } from '../shopee-webchat-push.js'

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

  const parsedEarly = parseJsonSafe(rawBody)
  const isVerifyPing = isShopeeUrlVerificationPush(parsedEarly, rawBody)

  const partnerKeys = [
    ...new Set(
      [env.shopeePushPartnerKey, env.shopeePartnerKey, env.shopeePushTestPartnerKey].filter(Boolean),
    ),
  ]
  const urlCandidates = callbackUrlCandidates(
    env.shopeePushCallbackUrl || undefined,
    req.protocol,
    req.get('host') ?? 'localhost',
    req.originalUrl,
  )

  let signatureOk: boolean | null = null
  if (isVerifyPing) {
    // Ping do botão Verify no console Shopee (code 0 + verify_info).
    signatureOk = null
    console.log('[shopee-push] ping de verificação de URL (code 0) — aceitando')
  } else if (partnerKeys.length && authorization) {
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
      recordAudit({
        source: 'push',
        event: 'push.rejeitado',
        level: 'error',
        detail: { motivo: 'assinatura inválida', callbackUrl, urlCandidates, bodyLen: rawBody.length, body: rawBody.slice(0, 2000) },
      })
      res.status(401).end()
      return
    }
  } else if (partnerKeys.length && !authorization) {
    console.warn('[shopee-push] Authorization ausente')
    recordAudit({
      source: 'push',
      event: 'push.rejeitado',
      level: 'error',
      detail: { motivo: 'Authorization ausente', callbackUrl, body: rawBody.slice(0, 2000) },
    })
    res.status(401).end()
    return
  } else {
    console.warn('[shopee-push] SHOPEE_PUSH_PARTNER_KEY não configurada — aceitando sem validar assinatura')
    recordAudit({ source: 'push', event: 'push.sem_validacao', level: 'warn', detail: { motivo: 'partner key não configurada' } })
  }

  const parsed = parsedEarly ?? parseJsonSafe(rawBody)
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
  const code = typeof parsed === 'object' && parsed && 'code' in parsed ? (parsed as { code?: unknown }).code : undefined
  console.log('[shopee-push] recebido', {
    id: entry.id,
    code,
    shop_id: typeof parsed === 'object' && parsed && 'shop_id' in parsed ? (parsed as { shop_id?: unknown }).shop_id : undefined,
  })
  // runId amarra a chegada do push ao que ele causou (import, update de linha, vínculo de chat).
  const runId = newRunId('push')
  recordAudit({
    source: 'push',
    runId,
    event: 'push.recebido',
    detail: { pushId: entry.id, code, signatureOk, isVerifyPing, callbackUrl, payload: parsed ?? rawBody.slice(0, 2000) },
  })

  // Shopee exige 2xx com corpo vazio — processamento async depois da resposta.
  res.status(200).end()
  if (!isVerifyPing) {
    // Sem o catch, uma exceção aqui virava unhandled rejection e sumia sem rastro.
    void processShopeePush(parsed, runId).catch((error) => {
      const msg = error instanceof Error ? error.message : String(error)
      console.error('[shopee-push] processamento falhou', msg)
      recordAudit({ source: 'push', runId, event: 'push.falhou', level: 'error', detail: { erro: msg, payload: parsed } })
    })
  }
}

/** GET /api/shopee/push/recent — últimos pushes (auth UI/API). */
router.get('/shopee/push/recent', requireAuth, (_req, res) => {
  res.json({ ok: true, items: getRecentShopeePushes() })
})

/**
 * GET /api/shopee/webchat-push/recent — captura diagnóstica de pushes com código
 * desconhecido (ver recordWebchatPushAttempt) — usar pra conferir o formato real do
 * webchat_push assim que a Shopee mandar o primeiro.
 */
router.get('/shopee/webchat-push/recent', requireAuth, (_req, res) => {
  res.json({ ok: true, items: getRecentWebchatPushes() })
})

export default router
