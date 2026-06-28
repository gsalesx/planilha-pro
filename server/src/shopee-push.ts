import { createHmac, timingSafeEqual } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import { env } from './env.js'

export interface ShopeePushRecord {
  id: string
  receivedAt: number
  callbackUrl: string
  authorization: string | null
  signatureOk: boolean | null
  body: string
  parsed: unknown
}

const MAX_RECENT = 50
const recent: ShopeePushRecord[] = []

function pushLogPath(): string {
  mkdirSync(env.dataDir, { recursive: true })
  return path.join(env.dataDir, 'shopee-push.log')
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const aa = Buffer.from(a, 'utf8')
    const bb = Buffer.from(b, 'utf8')
    if (aa.length !== bb.length) return false
    return timingSafeEqual(aa, bb)
  } catch {
    return false
  }
}

/** Authorization da Shopee pode vir com prefixo SHA256 e hex em maiúsculas. */
export function normalizePushAuthorization(authorization: string): string {
  let value = authorization.trim()
  if (/^sha256\s+/i.test(value)) value = value.replace(/^sha256\s+/i, '')
  return value.trim().toLowerCase()
}

function partnerKeyBuffers(partnerKey: string): Buffer[] {
  const out: Buffer[] = [Buffer.from(partnerKey, 'utf8')]
  if (/^[0-9a-fA-F]+$/.test(partnerKey) && partnerKey.length % 2 === 0 && partnerKey.length >= 16) {
    out.push(Buffer.from(partnerKey, 'hex'))
  }
  if (!partnerKey.startsWith('shpk')) {
    out.push(Buffer.from(`shpk${partnerKey}`, 'utf8'))
  }
  return out
}

function hmacPushHex(key: Buffer, callbackUrl: string, rawBody: string): string {
  return createHmac('sha256', key)
    .update(`${callbackUrl}|${rawBody}`)
    .digest('hex')
    .toLowerCase()
}

export function callbackUrlCandidates(
  configured: string | undefined,
  protocol: string,
  host: string,
  originalUrl: string,
): string[] {
  const pathOnly = originalUrl.split('?')[0] || originalUrl
  const requestUrl = `${protocol}://${host}${pathOnly}`
  const set = new Set<string>()
  if (configured?.trim()) set.add(configured.trim())
  set.add(requestUrl)
  for (const url of [...set]) {
    const trimmed = url.replace(/\/$/, '')
    set.add(trimmed)
    set.add(`${trimmed}/`)
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol === 'https:' && !parsed.port) {
        set.add(`${parsed.protocol}//${parsed.hostname}:443${parsed.pathname}`)
      }
      if (parsed.protocol === 'https:') {
        set.add(trimmed.replace('https://', 'http://'))
      }
    } catch {
      // ignore URL inválida
    }
  }
  return [...set]
}

export function verifyShopeePushSignature(
  callbackUrl: string,
  rawBody: string,
  authorization: string,
  partnerKey: string,
): boolean {
  const authNorm = normalizePushAuthorization(authorization)
  for (const keyBuf of partnerKeyBuffers(partnerKey)) {
    if (safeEqualHex(hmacPushHex(keyBuf, callbackUrl, rawBody), authNorm)) return true
  }
  return false
}

/** Tenta URL(s) e chave(s) — cobre diferenças de proxy e formatos de Live Push Key. */
export function verifyShopeePushSignatureAny(
  callbackUrls: string[],
  rawBody: string,
  authorization: string,
  partnerKeys: string[],
): boolean {
  const authNorm = normalizePushAuthorization(authorization)
  for (const callbackUrl of callbackUrls) {
    for (const partnerKey of partnerKeys) {
      if (!partnerKey) continue
      for (const keyBuf of partnerKeyBuffers(partnerKey)) {
        if (safeEqualHex(hmacPushHex(keyBuf, callbackUrl, rawBody), authNorm)) return true
      }
    }
  }
  return false
}

export function resolveShopeeCallbackUrl(protocol: string, host: string, originalUrl: string): string {
  if (env.shopeePushCallbackUrl) return env.shopeePushCallbackUrl
  const pathOnly = originalUrl.split('?')[0] || originalUrl
  return `${protocol}://${host}${pathOnly}`
}

export function recordShopeePush(entry: ShopeePushRecord): void {
  recent.unshift(entry)
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT
  try {
    appendFileSync(
      pushLogPath(),
      `${JSON.stringify({
        id: entry.id,
        receivedAt: entry.receivedAt,
        signatureOk: entry.signatureOk,
        callbackUrl: entry.callbackUrl,
        body: entry.parsed ?? entry.body,
      })}\n`,
      'utf8',
    )
  } catch (error) {
    console.warn('[shopee-push] falha ao gravar log:', error)
  }
}

export function getRecentShopeePushes(): ShopeePushRecord[] {
  return recent.map((item) => ({ ...item }))
}
