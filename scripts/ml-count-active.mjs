#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AUTH_FILE = path.join(ROOT, 'server', 'data', 'mercadolivre-auth.json')
const REG_FILE = path.join(ROOT, 'server', 'data', 'ml-shopee-import.json')
const API = 'https://api.mercadolibre.com'

const TARGETS = [
  { key: 'CAMISOLA', family: 'CAMISOLA', gender: null, target: 30 },
  { key: 'SHORT|M', family: 'SHORT', gender: 'M', target: 30 },
  { key: 'SHORT|F', family: 'SHORT', gender: 'F', target: 30 },
  { key: 'CONJUNTO UNITARIO|M', family: 'CONJUNTO UNITARIO', gender: 'M', target: 30 },
  { key: 'CONJUNTO UNITARIO|F', family: 'CONJUNTO UNITARIO', gender: 'F', target: 30 },
]

const EXCLUDE = new Set([
  'CAMISOLA + SHORT',
  'CAMISOLA + CONJUNTO',
  'SHORT CASAL',
  'CONJUNTO COMPLETO CASAL',
])

function recordKey(rec) {
  if (EXCLUDE.has(rec.family)) return null
  if (rec.family === 'CAMISOLA') return 'CAMISOLA'
  if (rec.family === 'SHORT' || rec.family === 'CONJUNTO UNITARIO') {
    return `${rec.family}|${rec.genderKey || '?'}`
  }
  return null
}

async function loadToken() {
  let raw = JSON.parse(await readFile(AUTH_FILE, 'utf8'))
  if (!raw.accessToken) throw new Error('Sem token ML')
  const probe = await fetch(`${API}/users/me`, { headers: { Authorization: `Bearer ${raw.accessToken}` } })
  if (probe.ok) return raw
  const appId = process.env.ML_APP_ID || process.env.MERCADOLIVRE_APP_ID
  const clientSecret = process.env.ML_CLIENT_SECRET || process.env.MERCADOLIVRE_CLIENT_SECRET
  if (!appId || !clientSecret || !raw.refreshToken) throw new Error('Token expirado — renove OAuth')
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: appId,
      client_secret: clientSecret,
      refresh_token: raw.refreshToken,
    }).toString(),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`Refresh falhou: ${JSON.stringify(json)}`)
  raw = {
    ...raw,
    accessToken: json.access_token,
    refreshToken: json.refresh_token || raw.refreshToken,
    accessExpireAt: Date.now() + (json.expires_in ?? 21600) * 1000,
    updatedAt: Date.now(),
  }
  await writeFile(AUTH_FILE, JSON.stringify(raw, null, 2))
  return raw
}

async function api(token, path) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`${path} → ${r.status}`)
  return r.json()
}

async function main() {
  const auth = await loadToken()
  const reg = JSON.parse(await readFile(REG_FILE, 'utf8'))
  const counts = Object.fromEntries(TARGETS.map((t) => [t.key, { registry: 0, active: 0, remaining: t.target }]))

  const entries = Object.values(reg.published || {}).filter((r) => r.mlItemId)
  for (const rec of entries) {
    const k = recordKey(rec)
    if (!k || !counts[k]) continue
    counts[k].registry++
    const item = await api(auth.accessToken, `/items/${rec.mlItemId}`)
    if (item?.status === 'active') counts[k].active++
    await new Promise((r) => setTimeout(r, 80))
  }

  for (const t of TARGETS) {
    counts[t.key].remaining = Math.max(0, t.target - counts[t.key].active)
    counts[t.key].target = t.target
  }

  console.log(JSON.stringify({ counts, totalActive: TARGETS.reduce((s, t) => s + counts[t.key].active, 0) }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
