#!/usr/bin/env node
/**
 * Garante a arte "Como funciona a personalização?" como última foto
 * de todos os anúncios ML, exceto as duas cuecas falsas.
 *
 *   node scripts/ml-last-personalizacao-pic.mjs scan
 *   ML_LAST_PIC=1 node scripts/ml-last-personalizacao-pic.mjs apply
 *   ML_LAST_PIC=1 node scripts/ml-last-personalizacao-pic.mjs apply --only-id MLB...
 */
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const sharp = require(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'server', 'node_modules', 'sharp'))

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const AUTH_FILE = path.join(ROOT, 'server', 'data', 'mercadolivre-auth.json')
const REG_FILE = path.join(ROOT, 'server', 'data', 'ml-shopee-import.json')
const IMAGE_FILE = path.join(ROOT, 'server', 'data', 'ml-personalizacao.jpg')
const REPORT_FILE = path.join(ROOT, 'server', 'data', 'ml-last-personalizacao-pic.json')
const API = 'https://api.mercadolibre.com'
const USER_ID = 389238793
const MAX_PICS = 12
const FP_SIZE = 32
const MATCH_THRESHOLD = 22

const EXCLUDE_IDS = new Set(['MLB7584348658', 'MLB7584337812'])
const SHORT_CUECA_RE = /\b(cueca\s+falsa|short\s+cueca|bermuda.*cueca\s+falsa|cueca\s+falsa.*bermuda)\b/i

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function argValue(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}

async function loadToken() {
  const raw = JSON.parse(await readFile(AUTH_FILE, 'utf8'))
  if (!raw.accessToken) throw new Error('Sem token ML')
  const probe = await fetch(`${API}/users/me`, {
    headers: { Authorization: `Bearer ${raw.accessToken}` },
  })
  if (!probe.ok) throw new Error(`Token ML inválido (${probe.status}) — abra a planilha e reconecte o ML`)
  return raw
}

async function api(method, urlPath, { token, body, form } = {}) {
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  let payload
  if (form) {
    payload = form
  } else if (body) {
    headers['Content-Type'] = 'application/json'
    payload = JSON.stringify(body)
  }
  const res = await fetch(`${API}${urlPath}`, { method, headers, body: payload })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  if (!res.ok) {
    const err = new Error(`${method} ${urlPath} → ${res.status}`)
    err.response = json
    err.status = res.status
    throw err
  }
  return json
}

async function fingerprintBuffer(buf) {
  const raw = await sharp(buf)
    .resize(FP_SIZE, FP_SIZE, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer()
  return raw
}

function fingerprintDistance(a, b) {
  if (!a || !b || a.length !== b.length) return 999
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i])
  return sum / a.length
}

async function fingerprintUrl(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download ${res.status} ${url}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return fingerprintBuffer(buf)
}

function pictureUrl(pic) {
  return pic?.secure_url || pic?.url || pic?.variations?.[0]?.secure_url || null
}

async function listSellerItemIds(token) {
  const ids = new Set()
  for (const status of ['active', 'paused']) {
    let scrollId = null
    for (;;) {
      const qs = new URLSearchParams({ search_type: 'scan', status })
      if (scrollId) qs.set('scroll_id', scrollId)
      const page = await api('GET', `/users/${USER_ID}/items/search?${qs}`, { token })
      for (const id of page.results || []) ids.add(id)
      scrollId = page.scroll_id
      if (!scrollId || !page.results?.length) break
      await sleep(80)
    }
  }
  return [...ids]
}

function isCuecaFalsa(item, registryFamily) {
  if (EXCLUDE_IDS.has(item.id)) return true
  if (registryFamily === 'SHORT CUECA') return true
  const text = `${item.title || ''} ${(item.subtitle || '')}`
  return SHORT_CUECA_RE.test(text)
}

async function uploadLocalPicture(token) {
  const bytes = await readFile(IMAGE_FILE)
  const form = new FormData()
  form.append('file', new Blob([bytes], { type: 'image/jpeg' }), 'personalizacao.jpg')
  const created = await api('POST', '/pictures/items/upload', { token, form })
  for (let i = 0; i < 20; i++) {
    const st = await api('GET', `/pictures/${created.id}`, { token })
    if (st.status === 'ACTIVE') return created.id
    await sleep(800)
  }
  return created.id
}

function desiredPictureIds(item, matchId, uploadedId) {
  const current = (item.pictures || []).map((p) => p.id).filter(Boolean)
  const keepId = matchId || uploadedId
  const without = current.filter((id) => id !== keepId)
  const next = [...without, keepId]
  if (next.length > MAX_PICS) {
    const art = next.pop()
    return [...next.slice(0, MAX_PICS - 1), art]
  }
  return next
}

function buildUpdateBody(item, pictureIds) {
  const body = { pictures: pictureIds.map((id) => ({ id })) }
  if (item.variations?.length) {
    body.variations = item.variations.map((v) => ({
      id: v.id,
      picture_ids: pictureIds,
    }))
  }
  return body
}

async function inspectItem(item, refFp) {
  const pics = item.pictures || []
  const result = {
    id: item.id,
    title: item.title,
    status: item.status,
    pictureCount: pics.length,
    lastPictureId: pics.at(-1)?.id || null,
    action: 'missing',
    matchIndex: -1,
    matchId: null,
    lastDistance: null,
    bestDistance: null,
  }
  if (!pics.length) return result

  let best = { index: -1, id: null, distance: 999 }
  const lastUrl = pictureUrl(pics.at(-1))
  if (lastUrl) {
    result.lastDistance = fingerprintDistance(refFp, await fingerprintUrl(lastUrl))
    best = { index: pics.length - 1, id: pics.at(-1).id, distance: result.lastDistance }
    if (result.lastDistance <= MATCH_THRESHOLD) {
      result.action = 'already_last'
      result.matchIndex = pics.length - 1
      result.matchId = pics.at(-1).id
      result.bestDistance = result.lastDistance
      return result
    }
  }

  for (let i = 0; i < pics.length - 1; i++) {
    const url = pictureUrl(pics[i])
    if (!url) continue
    const dist = fingerprintDistance(refFp, await fingerprintUrl(url))
    if (dist < best.distance) best = { index: i, id: pics[i].id, distance: dist }
    await sleep(40)
  }
  result.bestDistance = best.distance
  if (best.distance <= MATCH_THRESHOLD) {
    result.action = 'move_last'
    result.matchIndex = best.index
    result.matchId = best.id
    return result
  }
  result.action = 'missing'
  return result
}

async function scanAll(token, { onlyId } = {}) {
  let registryFamily = {}
  try {
    const reg = JSON.parse(await readFile(REG_FILE, 'utf8'))
    for (const rec of Object.values(reg.published || {})) {
      if (rec.mlItemId) registryFamily[rec.mlItemId] = rec.family
    }
  } catch {
    registryFamily = {}
  }

  const refFp = await fingerprintBuffer(await readFile(IMAGE_FILE))
  let ids = onlyId ? [onlyId] : await listSellerItemIds(token)
  const rows = []
  const skipped = []

  console.log(`Varredura: ${ids.length} anúncios (active+paused)`)
  let i = 0
  for (const id of ids) {
    i += 1
    process.stdout.write(`[${i}/${ids.length}] ${id}… `)
    try {
      const item = await api('GET', `/items/${id}`, { token })
      if (isCuecaFalsa(item, registryFamily[id])) {
        skipped.push({ id, title: item.title, reason: 'cueca_falsa' })
        console.log('SKIP cueca falsa')
        await sleep(80)
        continue
      }
      const row = await inspectItem(item, refFp)
      row.family = registryFamily[id] || null
      rows.push(row)
      console.log(`${row.action} pics=${row.pictureCount} last=${row.lastDistance?.toFixed?.(1) ?? '-'} best=${row.bestDistance?.toFixed?.(1) ?? '-'}`)
    } catch (err) {
      rows.push({ id, action: 'error', error: err.message, response: err.response })
      console.log(`ERRO ${err.message}`)
    }
    await sleep(100)
  }

  const summary = {
    at: new Date().toISOString(),
    totalListed: ids.length,
    skippedCuecas: skipped,
    alreadyLast: rows.filter((r) => r.action === 'already_last').length,
    moveLast: rows.filter((r) => r.action === 'move_last').length,
    missing: rows.filter((r) => r.action === 'missing').length,
    errors: rows.filter((r) => r.action === 'error').length,
    rows,
  }
  await writeFile(REPORT_FILE, JSON.stringify(summary, null, 2))
  console.log('\nResumo')
  console.log(JSON.stringify({
    alreadyLast: summary.alreadyLast,
    moveLast: summary.moveLast,
    missing: summary.missing,
    errors: summary.errors,
    skippedCuecas: skipped.length,
    report: REPORT_FILE,
  }, null, 2))
  return summary
}

function classifyRow(row) {
  if (row.action === 'error') return row
  if ((row.lastDistance ?? 999) <= MATCH_THRESHOLD) {
    return { ...row, action: 'already_last', matchIndex: (row.pictureCount || 1) - 1 }
  }
  if ((row.bestDistance ?? 999) <= MATCH_THRESHOLD) {
    return { ...row, action: 'move_last' }
  }
  return { ...row, action: 'missing', matchId: null }
}

async function applyAll(token, { onlyId, fromReport } = {}) {
  if (process.env.ML_LAST_PIC !== '1') {
    throw new Error('Recusou apply — rode com ML_LAST_PIC=1')
  }
  let summary
  if (fromReport) {
    summary = JSON.parse(await readFile(REPORT_FILE, 'utf8'))
    summary.rows = summary.rows.map(classifyRow)
    if (onlyId) summary.rows = summary.rows.filter((r) => r.id === onlyId)
    summary.alreadyLast = summary.rows.filter((r) => r.action === 'already_last').length
    summary.moveLast = summary.rows.filter((r) => r.action === 'move_last').length
    summary.missing = summary.rows.filter((r) => r.action === 'missing').length
    console.log(`Usando relatório: already=${summary.alreadyLast} move=${summary.moveLast} missing=${summary.missing}`)
  } else {
    summary = await scanAll(token, { onlyId })
  }
  const targets = summary.rows.filter((r) => r.action === 'missing' || r.action === 'move_last')
  console.log(`\nAplicando em ${targets.length} anúncios…`)
  if (!targets.length) return summary

  const uploadedId = await uploadLocalPicture(token)
  console.log(`Picture enviada: ${uploadedId}`)
  const refFp = await fingerprintBuffer(await readFile(IMAGE_FILE))
  const results = []

  for (const row of targets) {
    process.stdout.write(`${row.id} ${row.action}… `)
    try {
      const item = await api('GET', `/items/${row.id}`, { token })
      let matchId = row.matchId
      if (row.action === 'move_last' && !matchId) {
        const inspected = await inspectItem(item, refFp)
        matchId = inspected.matchId
      }
      const pictureIds = desiredPictureIds(item, matchId, uploadedId)
      await api('PUT', `/items/${row.id}`, { token, body: buildUpdateBody(item, pictureIds) })
      const verified = await api('GET', `/items/${row.id}`, { token })
      const lastId = verified.pictures?.at(-1)?.id
      const expectedLast = matchId || uploadedId
      const ok = lastId === expectedLast
      results.push({
        id: row.id,
        ok,
        before: row.pictureCount,
        after: verified.pictures?.length ?? 0,
        lastId,
      })
      console.log(ok ? `OK last=${lastId}` : `WARN last=${lastId}`)
    } catch (err) {
      results.push({ id: row.id, ok: false, error: err.message, response: err.response })
      console.log(`FALHOU ${err.message}`)
    }
    await sleep(180)
  }

  summary.appliedAt = new Date().toISOString()
  summary.uploadedPictureId = uploadedId
  summary.applyResults = results
  summary.applyOk = results.filter((r) => r.ok).length
  summary.applyFail = results.filter((r) => !r.ok).length
  await writeFile(REPORT_FILE, JSON.stringify(summary, null, 2))
  console.log(JSON.stringify({
    applyOk: summary.applyOk,
    applyFail: summary.applyFail,
    uploadedPictureId: uploadedId,
  }, null, 2))
  return summary
}

async function main() {
  const cmd = process.argv[2] || 'scan'
  const onlyId = argValue('--only-id')
  const fromReport = process.argv.includes('--from-report')
  const { accessToken: token } = await loadToken()
  if (cmd === 'scan') await scanAll(token, { onlyId })
  else if (cmd === 'apply') await applyAll(token, { onlyId, fromReport })
  else throw new Error(`Comando desconhecido: ${cmd}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
