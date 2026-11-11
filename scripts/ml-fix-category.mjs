#!/usr/bin/env node
/**
 * Escaneia/corrige category_id de SHORT e CONJUNTO UNITARIO no ML.
 * Uso:
 *   node scripts/ml-fix-category.mjs scan
 *   ML_CATEGORY_FIX=1 node scripts/ml-fix-category.mjs apply [--only-id MLB...]
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const AUTH_FILE = path.join(ROOT, 'server', 'data', 'mercadolivre-auth.json')
const REG_FILE = path.join(ROOT, 'server', 'data', 'ml-shopee-import.json')
const LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-category-fix.log')
const API = 'https://api.mercadolibre.com'
const PIJAMAS = 'MLB278112'
const TARGET_FAMILIES = ['SHORT', 'CONJUNTO UNITARIO']

function parseArgs(argv) {
  return {
    cmd: argv[2] || 'scan',
    onlyId: argv.includes('--only-id') ? argv[argv.indexOf('--only-id') + 1] : null,
    apply: process.env.ML_CATEGORY_FIX === '1',
  }
}

async function loadToken() {
  let raw = JSON.parse(await readFile(AUTH_FILE, 'utf8'))
  const probe = await fetch(`${API}/users/me`, {
    headers: { Authorization: `Bearer ${raw.accessToken}` },
  })
  if (probe.ok) return raw

  const appId = process.env.ML_APP_ID || process.env.MERCADOLIVRE_APP_ID
  const clientSecret = process.env.ML_CLIENT_SECRET || process.env.MERCADOLIVRE_CLIENT_SECRET
  if (!appId || !clientSecret || !raw.refreshToken) {
    throw new Error('Token expirado — defina ML_APP_ID + ML_CLIENT_SECRET ou renove OAuth')
  }
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
    updatedAt: Date.now(),
  }
  await writeFile(AUTH_FILE, JSON.stringify(raw, null, 2))
  return raw
}

async function api(method, urlPath, { token, body } = {}) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err = new Error(`${method} ${urlPath} → ${res.status}`)
    err.response = json
    err.status = res.status
    throw err
  }
  return json
}

async function categoryPath(categoryId) {
  const cat = await fetch(`${API}/categories/${categoryId}`).then((r) => r.json())
  return cat.path_from_root?.map((p) => p.name).join(' > ') || categoryId
}

function registryEntries(reg, onlyId) {
  return Object.entries(reg.published || {}).filter(
    ([, rec]) =>
      rec.mlItemId &&
      !rec.error &&
      TARGET_FAMILIES.includes(rec.family) &&
      (!onlyId || rec.mlItemId === onlyId),
  )
}

async function main() {
  const args = parseArgs(process.argv)
  const { accessToken: token } = await loadToken()
  const reg = JSON.parse(await readFile(REG_FILE, 'utf8'))
  const entries = registryEntries(reg, args.onlyId)
  const runAt = new Date().toISOString()
  const lines = [`# ml-category-fix ${runAt} cmd=${args.cmd} apply=${args.apply}`]

  const wrong = []
  for (const [key, rec] of entries) {
    const item = await api('GET', `/items/${rec.mlItemId}`, { token })
    if (item.category_id !== PIJAMAS) {
      wrong.push({
        publishKey: key,
        mlItemId: rec.mlItemId,
        family: rec.family,
        title: item.title,
        mlCategory: item.category_id,
        registryCategory: rec.categoryId,
        path: await categoryPath(item.category_id),
      })
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  lines.push(`# scan total=${entries.length} wrong=${wrong.length}`)
  for (const w of wrong) {
    lines.push(`WRONG ${w.mlItemId} ${w.publishKey} ${w.family} ml=${w.mlCategory} reg=${w.registryCategory} path="${w.path}"`)
  }

  let fixed = 0
  let failed = 0
  if (args.apply && wrong.length) {
    for (const w of wrong) {
      try {
        await api('PUT', `/items/${w.mlItemId}`, { token, body: { category_id: PIJAMAS } })
        const verified = await api('GET', `/items/${w.mlItemId}`, { token })
        if (verified.category_id !== PIJAMAS) throw new Error(`still ${verified.category_id}`)
        const rec = reg.published[w.publishKey]
        rec.categoryFixed = { from: w.mlCategory, to: PIJAMAS, at: new Date().toISOString() }
        reg.published[w.publishKey] = rec
        fixed++
        lines.push(`FIXED ${w.mlItemId} ${w.mlCategory}->${PIJAMAS}`)
      } catch (err) {
        failed++
        lines.push(`FAIL ${w.mlItemId} — ${err.message}`)
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    await writeFile(REG_FILE, JSON.stringify(reg, null, 2))
  }

  lines.push(`# summary fixed=${fixed} failed=${failed}`)
  await writeFile(LOG_FILE, `${lines.join('\n')}\n`)

  const summary = { total: entries.length, wrong: wrong.length, fixed, failed, wrongList: wrong }
  console.log(JSON.stringify(summary, null, 2))
  console.log(`Log: ${LOG_FILE}`)
}

main().catch((err) => {
  console.error(err.message || err)
  process.exit(1)
})
