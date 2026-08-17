import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { env } from './env.js'

export interface MercadoLivreAuthRecord {
  accessToken: string
  refreshToken: string
  /** Unix ms */
  accessExpireAt: number
  userId: number
  updatedAt: number
}

function authPath(): string {
  mkdirSync(env.dataDir, { recursive: true })
  return path.join(env.dataDir, 'mercadolivre-auth.json')
}

export function loadMercadoLivreAuth(): MercadoLivreAuthRecord | null {
  const file = authPath()
  if (!existsSync(file)) return null
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as MercadoLivreAuthRecord
    if (!raw.accessToken || !raw.refreshToken) return null
    return raw
  } catch {
    return null
  }
}

export function saveMercadoLivreAuth(record: MercadoLivreAuthRecord): void {
  writeFileSync(authPath(), JSON.stringify(record, null, 2), 'utf8')
}

export function clearMercadoLivreAuth(): void {
  const file = authPath()
  if (existsSync(file)) writeFileSync(file, '{}', 'utf8')
}
