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

export function verifyShopeePushSignature(
  callbackUrl: string,
  rawBody: string,
  authorization: string,
  partnerKey: string,
): boolean {
  const baseString = `${callbackUrl}|${rawBody}`
  const expected = createHmac('sha256', partnerKey).update(baseString).digest('hex')
  try {
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(authorization, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  } catch {
    return false
  }
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
