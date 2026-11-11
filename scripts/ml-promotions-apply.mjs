#!/usr/bin/env node
/**
 * Aplica PRICE_DISCOUNT em anúncios ativos por família (preço final alvo).
 * Uso: node scripts/ml-promotions-apply.mjs [--only MLB...] [--only MLB...]
 */
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const AUTH_FILE = path.join(ROOT, 'server', 'data', 'mercadolivre-auth.json')
const REGISTRY_FILE = path.join(ROOT, 'server', 'data', 'ml-shopee-import.json')
const LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-promotions-apply.log')
const API = 'https://api.mercadolibre.com'

/** Preço final desejado por família */
const TARGET_BY_FAMILY = {
  CAMISOLA: 69.9,
  SHORT: 59.9,
  'SHORT CUECA': 59.9,
  'CONJUNTO UNITARIO': 127.9,
}

const onlyIds = []
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--only' && process.argv[i + 1]) {
    onlyIds.push(process.argv[++i].toUpperCase())
  }
}

/** Mesmo período das camisolas já promovidas (scan 2026-09-02) */
const START_DATE = '2026-09-02T00:00:00'
const FINISH_DATE = '2026-09-30T23:59:59'

const DELAY_MS = 120
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

async function apiRequest(token, urlPath, { method = 'GET', body } = {}) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { raw: text }
  }
  return { ok: res.ok, status: res.status, json }
}

function listingPrice(row) {
  const pa = row.priceApplied
  if (pa?.prices?.length) return pa.prices[0]
  if (pa?.previousPrice != null) return pa.previousPrice
  return null
}

function priceEq(a, b, eps = 0.02) {
  return Math.abs(a - b) <= eps
}

function discountPct(deal, original) {
  if (!deal || !original || original <= 0) return '-'
  return `${Math.round((1 - deal / original) * 100)}%`
}

function activePromos(promos) {
  const list = Array.isArray(promos) ? promos : promos?.results || []
  return list.filter((p) => p.type === 'PRICE_DISCOUNT' && (p.status === 'started' || p.status === 'active'))
}

async function getItemPromos(token, mlItemId) {
  return apiRequest(token, `/seller-promotions/items/${mlItemId}?app_version=v2`)
}

async function deletePromo(token, mlItemId) {
  return apiRequest(
    token,
    `/seller-promotions/items/${mlItemId}?promotion_type=PRICE_DISCOUNT&app_version=v2`,
    { method: 'DELETE' },
  )
}

async function createPromo(token, mlItemId, dealPrice) {
  return apiRequest(token, `/seller-promotions/items/${mlItemId}?app_version=v2`, {
    method: 'POST',
    body: {
      deal_price: dealPrice,
      start_date: START_DATE,
      finish_date: FINISH_DATE,
      promotion_type: 'PRICE_DISCOUNT',
    },
  })
}

async function isItemActive(token, mlItemId) {
  const r = await apiRequest(token, `/items/${mlItemId}`)
  if (!r.ok) return { active: false, error: r.status }
  return { active: r.json.status === 'active', price: r.json.price, status: r.json.status }
}

/** Promo PRICE_DISCOUNT pode zerar free_shipping em gold_special — re-aplica após apply. */
async function ensureFreeShipping(token, mlItemId) {
  const prev = await apiRequest(token, `/items/${mlItemId}`)
  if (!prev.ok) return { changed: false, freeShipping: false, error: prev.status }
  const wasFree = prev.json.shipping?.free_shipping ?? false
  await apiRequest(token, `/items/${mlItemId}`, {
    method: 'PUT',
    body: { shipping: { mode: 'me2', local_pick_up: false, free_shipping: true } },
  })
  const verified = await apiRequest(token, `/items/${mlItemId}`)
  const freeShipping = verified.json.shipping?.free_shipping ?? false
  return { changed: !wasFree || !freeShipping, freeShipping, previousFreeShipping: wasFree }
}

await loadEnv()
say(`Apply started: ${new Date().toISOString()}`)
say(`Period: ${START_DATE} → ${FINISH_DATE}`)

const auth = await loadToken()
const registry = JSON.parse(await readFile(REGISTRY_FILE, 'utf8'))
let published = Object.values(registry.published || {}).filter(
  (r) => r.mlItemId && TARGET_BY_FAMILY[r.family],
)
if (onlyIds.length) {
  published = published.filter((r) => onlyIds.includes(r.mlItemId.toUpperCase()))
  say(`Filter --only: ${onlyIds.join(', ')} → ${published.length} items`)
}

say(`Candidates in target families: ${published.length}`)

const stats = {}
for (const family of Object.keys(TARGET_BY_FAMILY)) {
  stats[family] = { total: 0, applied: 0, skipped: 0, failed: 0, notActive: 0, failures: [] }
}

const verifySamples = []

for (let i = 0; i < published.length; i++) {
  const row = published[i]
  const { mlItemId, family, title } = row
  const target = TARGET_BY_FAMILY[family]
  const original = listingPrice(row)
  stats[family].total++

  const activeCheck = await isItemActive(auth.accessToken, mlItemId)
  await sleep(DELAY_MS)
  if (!activeCheck.active) {
    stats[family].notActive++
    say(`SKIP not active: ${mlItemId} (${family}) status=${activeCheck.status ?? activeCheck.error}`)
    continue
  }

  const promoRes = await getItemPromos(auth.accessToken, mlItemId)
  await sleep(DELAY_MS)
  if (!promoRes.ok) {
    stats[family].failed++
    stats[family].failures.push({ mlItemId, title, error: `GET promos ${promoRes.status}`, detail: promoRes.json })
    continue
  }

  const active = activePromos(promoRes.json)
  if (active.some((p) => priceEq(p.price, target))) {
    stats[family].skipped++
    if (verifySamples.filter((s) => s.family === family).length < 1) {
      verifySamples.push({ family, mlItemId, title, action: 'skipped', target, original })
    }
    continue
  }

  if (active.length > 0) {
    const del = await deletePromo(auth.accessToken, mlItemId)
    await sleep(DELAY_MS)
    if (!del.ok) {
      stats[family].failed++
      stats[family].failures.push({
        mlItemId,
        title,
        error: `DELETE promo ${del.status}`,
        detail: del.json,
      })
      continue
    }
  }

  const create = await createPromo(auth.accessToken, mlItemId, target)
  await sleep(DELAY_MS)

  if (!create.ok) {
    stats[family].failed++
    stats[family].failures.push({
      mlItemId,
      title,
      error: `POST promo ${create.status}`,
      original,
      target,
      discount: discountPct(target, original),
      detail: create.json,
    })
    continue
  }

  stats[family].applied++
  const ship = await ensureFreeShipping(auth.accessToken, mlItemId)
  await sleep(DELAY_MS)
  if (ship.changed) say(`  frete re-aplicado: ${mlItemId} ${ship.previousFreeShipping}→${ship.freeShipping}`)
  if (verifySamples.filter((s) => s.family === family && s.action === 'applied').length < 1) {
    verifySamples.push({ family, mlItemId, title, action: 'applied', target, original })
  }

  if ((i + 1) % 20 === 0) say(`  ... ${i + 1}/${published.length}`)
}

say('\n=== VERIFICATION GET (sample per family) ===')
for (const sample of verifySamples) {
  const r = await getItemPromos(auth.accessToken, sample.mlItemId)
  await sleep(DELAY_MS)
  const active = r.ok ? activePromos(r.json) : []
  say(
    JSON.stringify({
      family: sample.family,
      mlItemId: sample.mlItemId,
      action: sample.action,
      title: sample.title?.slice(0, 60),
      listingOriginal: sample.original,
      targetDeal: sample.target,
      discount: discountPct(sample.target, sample.original),
      activePromo: active[0]
        ? {
            price: active[0].price,
            original_price: active[0].original_price,
            start: active[0].start_date,
            finish: active[0].finish_date,
            status: active[0].status,
          }
        : null,
    }),
  )
}

say('\n=== SUMMARY TABLE ===')
for (const family of Object.keys(TARGET_BY_FAMILY)) {
  const s = stats[family]
  const target = TARGET_BY_FAMILY[family]
  say(
    JSON.stringify({
      family,
      targetPrice: target,
      total: s.total,
      applied: s.applied,
      skipped: s.skipped,
      notActive: s.notActive,
      failed: s.failed,
      failureSample: s.failures.slice(0, 2).map((f) => ({ mlItemId: f.mlItemId, error: f.error })),
    }),
  )
}

const totalFailed = Object.values(stats).reduce((n, s) => n + s.failed, 0)
if (totalFailed) {
  say('\n=== ALL FAILURES ===')
  for (const family of Object.keys(TARGET_BY_FAMILY)) {
    for (const f of stats[family].failures) {
      say(JSON.stringify({ family, ...f }))
    }
  }
}

await appendFile(LOG_FILE, `\n---\n${log.join('\n')}\n`, 'utf8')
say(`\nLog written to ${LOG_FILE}`)
