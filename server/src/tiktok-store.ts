import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { env } from './env.js'

export interface TikTokAuthRecord {
  accessToken: string
  refreshToken: string
  /** Unix ms — estimado a partir de access_token_expire_in */
  accessExpireAt: number
  shopCipher?: string
  shopId?: string
  openId?: string
  updatedAt: number
}

function authPath(): string {
  mkdirSync(env.dataDir, { recursive: true })
  return path.join(env.dataDir, 'tiktok-auth.json')
}

export function loadTikTokAuth(): TikTokAuthRecord | null {
  const file = authPath()
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as TikTokAuthRecord
    if (!raw.accessToken || !raw.refreshToken) return null
    return raw
  } catch {
    return null
  }
}

export function saveTikTokAuth(record: TikTokAuthRecord): void {
  writeFileSync(authPath(), JSON.stringify(record, null, 2), 'utf8')
}

export function clearTikTokAuth(): void {
  const file = authPath()
  if (existsSync(file)) writeFileSync(file, '{}', 'utf8')
}
