import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { env } from './env.js'

export interface ShopeeAuthRecord {
  shopId: number
  accessToken: string
  refreshToken: string
  /** Unix ms — estimado a partir de expire_in */
  accessExpireAt: number
  updatedAt: number
}

function authPath(): string {
  mkdirSync(env.dataDir, { recursive: true })
  return path.join(env.dataDir, 'shopee-auth.json')
}

export function loadShopeeAuth(): ShopeeAuthRecord | null {
  const file = authPath()
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as ShopeeAuthRecord
    if (!raw.shopId || !raw.accessToken || !raw.refreshToken) return null
    return raw
  } catch {
    return null
  }
}

export function saveShopeeAuth(record: ShopeeAuthRecord): void {
  writeFileSync(authPath(), JSON.stringify(record, null, 2), 'utf8')
}

export function clearShopeeAuth(): void {
  const file = authPath()
  if (existsSync(file)) writeFileSync(file, '{}', 'utf8')
}
