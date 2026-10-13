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

function authPath(fileName = 'shopee-auth.json'): string {
  if (fileName !== path.basename(fileName) || !fileName.endsWith('.json')) {
    throw new Error('Arquivo de auth Shopee inválido')
  }
  mkdirSync(env.dataDir, { recursive: true })
  return path.join(env.dataDir, fileName)
}

export function loadShopeeAuth(fileName = 'shopee-auth.json'): ShopeeAuthRecord | null {
  const file = authPath(fileName)
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as ShopeeAuthRecord
    if (!raw.shopId || !raw.accessToken || !raw.refreshToken) return null
    return raw
  } catch {
    return null
  }
}

export function saveShopeeAuth(record: ShopeeAuthRecord, fileName = 'shopee-auth.json'): void {
  writeFileSync(authPath(fileName), JSON.stringify(record, null, 2), 'utf8')
}

export function clearShopeeAuth(fileName = 'shopee-auth.json'): void {
  const file = authPath(fileName)
  if (existsSync(file)) writeFileSync(file, '{}', 'utf8')
}
