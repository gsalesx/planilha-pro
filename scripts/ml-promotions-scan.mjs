#!/usr/bin/env node
/**
 * Scan read-only de promoções ML do seller (inclui PRICE_DISCOUNT por item).
 * Uso: node scripts/ml-promotions-scan.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const AUTH_FILE = path.join(ROOT, 'server', 'data', 'mercadolivre-auth.json')
const REGISTRY_FILE = path.join(ROOT, 'server', 'data', 'ml-shopee-import.json')
const LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-promotions-scan.log')
const API = 'https://api.mercadolibre.com'

const log = []
const say = (...a) => {
  const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x, null, 2))).join(' ')
  log.push(line)
  console.log(line)
}

async function loadEnv() {
  try {
    const envText = await readFile(path.join(ROOT, 'server', '.env'), 'utf8')
    for (const line of envText.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '')
      }
    }
  } catch {
    /* optional */
  }
}

async function loadToken() {
  let raw = JSON.parse(await readFile(AUTH_FILE, 'utf8'))
  const probe = await fetch(`${API}/users/me`, {
    headers: { Authorization: `Bearer ${raw.accessToken}` },
  })
  say(`Probe /users/me: ${probe.status} ${probe.ok ? 'OK' : await probe.text()}`)
  if (probe.ok) return raw

  const appId = process.env.ML_APP_ID || process.env.MERCADOLIVRE_APP_ID
  const clientSecret = process.env.ML_CLIENT_SECRET || process.env.MERCADOLIVRE_CLIENT_SECRET
  if (!appId || !clientSecret) throw new Error('Token expirado e sem ML_APP_ID/ML_CLIENT_SECRET')

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
  if (!res.ok) throw new Error(`Refresh failed: ${JSON.stringify(json)}`)
  raw = {
    ...raw,
    accessToken: json.access_token,
    refreshToken: json.refresh_token || raw.refreshToken,
    accessExpireAt: Date.now() + (json.expires_in ?? 21600) * 1000,
    updatedAt: Date.now(),
  }
  await writeFile(AUTH_FILE, JSON.stringify(raw, null, 2))
  say('Token refreshed OK')
  return raw
}

async function apiGet(token, urlPath) {
  const res = await fetch(`${API}${urlPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { ok: res.ok, status: res.status, json }
}

function fmtDate(iso) {
  if (!iso) return '-'
  try {
    return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
  } catch {
    return iso
  }
}

function promoKey(p) {
  const name = p.name || p.id || '(sem nome)'
  return `${p.type}|${name}|${p.start_date}|${p.finish_date}|${p.price}|${p.original_price}`
}

function discountPct(price, original) {
  if (!price || !original || original <= 0) return '-'
  return `${Math.round((1 - price / original) * 100)}%`
}

async function scanItemPromotions(token, mlItemId) {
  const r = await apiGet(token, `/seller-promotions/items/${mlItemId}?app_version=v2`)
  if (!r.ok) return { mlItemId, error: r.status, promos: [] }
  const promos = Array.isArray(r.json) ? r.json : r.json.results || []
  return { mlItemId, promos }
}

await loadEnv()
say(`Scan started: ${new Date().toISOString()}`)

const auth = await loadToken()
const userId = auth.userId
say(`User ID: ${userId}`)

const registry = JSON.parse(await readFile(REGISTRY_FILE, 'utf8'))
const published = Object.values(registry.published || {}).filter((r) => r.mlItemId)
const ourItems = new Map(published.map((r) => [r.mlItemId, r.title || r.shopeeTitle || r.mlItemId]))
say(`Our published MLB ids: ${ourItems.size}`)

// 1) Seller-level campaigns
const listRes = await apiGet(auth.accessToken, `/seller-promotions/users/${userId}?app_version=v2`)
say(`\nGET /seller-promotions/users/${userId}?app_version=v2 → ${listRes.status}`)
if (!listRes.ok) {
  say('ACCESS ERROR:', JSON.stringify(listRes.json).slice(0, 500))
} else {
  say('Campaigns total:', listRes.json.paging?.total ?? (listRes.json.results || []).length)
  say('Campaigns sample:', JSON.stringify(listRes.json.results || []).slice(0, 600))
}

// 2) Item-level promotions (PRICE_DISCOUNT etc.)
say('\nScanning item-level promotions for all published items...')
const groups = new Map()
const errors = []
let withPromo = 0
let withoutPromo = 0

for (let i = 0; i < published.length; i++) {
  const row = published[i]
  const { mlItemId } = row
  const { promos, error } = await scanItemPromotions(auth.accessToken, mlItemId)
  if (error) {
    errors.push({ mlItemId, error })
    continue
  }

  const active = promos.filter((p) => p.status === 'started' || p.status === 'active')
  if (active.length === 0) {
    withoutPromo++
    continue
  }
  withPromo++

  for (const p of active) {
    const key = promoKey(p)
    if (!groups.has(key)) {
      groups.set(key, {
        name: p.name || '(desconto por preço)',
        type: p.type,
        status: p.status,
        start: fmtDate(p.start_date),
        finish: fmtDate(p.finish_date),
        price: p.price,
        originalPrice: p.original_price,
        discount: discountPct(p.price, p.original_price),
        items: [],
      })
    }
    groups.get(key).items.push({
      mlItemId,
      title: ourItems.get(mlItemId),
    })
  }

  if ((i + 1) % 25 === 0) say(`  ... ${i + 1}/${published.length}`)
}

say(`\nItems with active promo: ${withPromo}`)
say(`Items without active promo: ${withoutPromo}`)
say(`API errors: ${errors.length}`)
if (errors.length) say('Error sample:', JSON.stringify(errors.slice(0, 5)))

const summary = [...groups.values()].sort((a, b) => b.items.length - a.items.length)
say(`\nDistinct active promotion groups: ${summary.length}`)

say('\n=== SUMMARY TABLE ===')
for (const g of summary) {
  say(
    JSON.stringify({
      name: g.name,
      type: g.type,
      discount: g.discount,
      price: g.price,
      originalPrice: g.originalPrice,
      start: g.start,
      finish: g.finish,
      ourCount: g.items.length,
      sampleTitles: g.items.slice(0, 3).map((x) => x.title),
    }),
  )
}

await writeFile(LOG_FILE, `${log.join('\n')}\n`, 'utf8')
say(`\nLog written to ${LOG_FILE}`)
