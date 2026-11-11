#!/usr/bin/env node
/**
 * Teste Mercado Livre — OAuth (manual), validate e publicação de item.
 *
 * Uso:
 *   ML_APP_ID=... ML_CLIENT_SECRET=... node scripts/ml-test-publish.mjs auth-url
 *   ML_APP_ID=... ML_CLIENT_SECRET=... ML_CODE=TG-... node scripts/ml-test-publish.mjs token
 *   ML_ACCESS_TOKEN=... node scripts/ml-test-publish.mjs me
 *   ML_ACCESS_TOKEN=... node scripts/ml-test-publish.mjs discover "camiseta personalizada"
 *   ML_ACCESS_TOKEN=... node scripts/ml-test-publish.mjs validate MLB31447
 *   ML_ACCESS_TOKEN=... ML_PUBLISH=1 node scripts/ml-test-publish.mjs publish MLB31447
 *
 * Token salvo em server/data/mercadolivre-auth.json (mesmo formato do app).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const AUTH_FILE = path.join(ROOT, 'server', 'data', 'mercadolivre-auth.json')
const API = 'https://api.mercadolibre.com'
const AUTH_BASE = 'https://auth.mercadolivre.com.br'

const appId = process.env.ML_APP_ID || process.env.MERCADOLIVRE_APP_ID || ''
const clientSecret = process.env.ML_CLIENT_SECRET || process.env.MERCADOLIVRE_CLIENT_SECRET || ''
const redirectUri =
  process.env.ML_REDIRECT_URL ||
  process.env.MERCADOLIVRE_REDIRECT_URL ||
  'https://planilha.guilhermesales.com/api/mercadolivre/oauth/callback'
const siteId = process.env.ML_SITE_ID || 'MLB'

const cmd = process.argv[2] || 'help'
const arg = process.argv[3]

function die(msg) {
  console.error(`Erro: ${msg}`)
  process.exit(1)
}

async function loadToken() {
  if (process.env.ML_ACCESS_TOKEN) {
    return {
      accessToken: process.env.ML_ACCESS_TOKEN,
      refreshToken: process.env.ML_REFRESH_TOKEN || '',
      userId: Number(process.env.ML_USER_ID || 0),
    }
  }
  try {
    const raw = JSON.parse(await readFile(AUTH_FILE, 'utf8'))
    if (raw.accessToken) return raw
  } catch {
    /* sem arquivo */
  }
  die('Sem token. Rode: ML_CODE=TG-... node scripts/ml-test-publish.mjs token')
}

async function saveToken(record) {
  await mkdir(path.dirname(AUTH_FILE), { recursive: true })
  await writeFile(AUTH_FILE, JSON.stringify(record, null, 2))
  console.log(`Token salvo em ${AUTH_FILE}`)
}

async function tokenRequest(body) {
  const res = await fetch(`${API}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  })
  const text = await res.text()
  if (!res.ok) die(`token ${res.status}: ${text}`)
  return JSON.parse(text)
}

function authUrl() {
  if (!appId) die('Defina ML_APP_ID')
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: appId,
    redirect_uri: redirectUri,
  })
  return `${AUTH_BASE}/authorization?${params}`
}

async function api(method, path, { query, body, token } = {}) {
  const url = new URL(path, API)
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const res = await fetch(url, {
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
    json = JSON.parse(text)
  } catch {
    json = text
  }
  if (!res.ok) {
    console.error(JSON.stringify(json, null, 2))
    die(`${method} ${path} → ${res.status}`)
  }
  return json
}

function sampleItem(categoryId, opts = {}) {
  const chartId = opts.chartId || process.env.ML_SIZE_GRID_ID || '7207594'
  const rowId = opts.rowId || process.env.ML_SIZE_GRID_ROW_ID || `${chartId}:2`
  return {
    title: 'Item de teste - Nao Comprar',
    category_id: categoryId,
    price: 49.9,
    currency_id: 'BRL',
    available_quantity: 1,
    buying_mode: 'buy_it_now',
    condition: 'new',
    listing_type_id: 'gold_special',
    pictures: [
      {
        source: 'https://http2.mlstatic.com/D_783501-MLB20327737026_062015-O.jpg',
      },
    ],
    sale_terms: [
      { id: 'WARRANTY_TYPE', value_name: 'Garantia do vendedor' },
      { id: 'WARRANTY_TIME', value_name: '90 dias' },
    ],
    attributes: [
      { id: 'BRAND', value_id: '35977846', value_name: 'Generic' },
      { id: 'MODEL', value_name: 'Teste API Planilha Pro' },
      { id: 'GENDER', value_id: '339666', value_name: 'Masculino' },
      { id: 'GARMENT_TYPE', value_id: '12038970', value_name: 'Camiseta' },
      { id: 'AGE_GROUP', value_id: '6725189', value_name: 'Adultos' },
      { id: 'COLOR', value_name: 'Preto' },
      { id: 'SLEEVE_TYPE', value_id: '466804', value_name: 'Curta' },
      { id: 'MAIN_MATERIAL', value_id: '466793', value_name: 'Algodão' },
      { id: 'SIZE', value_name: 'M' },
      { id: 'SIZE_GRID_ID', value_name: chartId },
      { id: 'SIZE_GRID_ROW_ID', value_name: rowId },
    ],
  }
}

async function main() {
  switch (cmd) {
    case 'auth-url': {
      console.log(authUrl())
      break
    }

    case 'token': {
      if (!appId || !clientSecret) die('Defina ML_APP_ID e ML_CLIENT_SECRET')
      const code = process.env.ML_CODE || arg
      if (!code) die('Defina ML_CODE=TG-... ou passe como 3º argumento')
      const json = await tokenRequest({
        grant_type: 'authorization_code',
        client_id: appId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
      })
      const record = {
        accessToken: json.access_token,
        refreshToken: json.refresh_token,
        accessExpireAt: Date.now() + (json.expires_in ?? 21600) * 1000,
        userId: json.user_id,
        updatedAt: Date.now(),
      }
      await saveToken(record)
      console.log(JSON.stringify({ userId: record.userId, expiresIn: json.expires_in }, null, 2))
      break
    }

    case 'me': {
      const t = await loadToken()
      const me = await api('GET', '/users/me', { token: t.accessToken })
      console.log(JSON.stringify(me, null, 2))
      break
    }

    case 'discover': {
      const t = await loadToken()
      const q = arg || 'camiseta personalizada'
      const data = await api('GET', `/sites/${siteId}/domain_discovery/search`, {
        query: { q, limit: '5' },
        token: t.accessToken,
      })
      console.log(JSON.stringify(data, null, 2))
      break
    }

    case 'attributes': {
      const t = await loadToken()
      const catId = arg || die('Passe category_id: node scripts/ml-test-publish.mjs attributes MLB31447')
      const data = await api('GET', `/categories/${catId}/attributes`, { token: t.accessToken })
      const required = data.filter((a) => a.tags?.required || a.tags?.catalog_required)
      console.log(JSON.stringify({ total: data.length, requiredCount: required.length, required }, null, 2))
      break
    }

    case 'create-chart': {
      const t = await loadToken()
      const body = {
        names: { MLB: 'Guia Planilha Pro teste camisetas' },
        domain_id: 'T_SHIRTS',
        site_id: 'MLB',
        attributes: [
          { id: 'GENDER', values: [{ id: '339666', name: 'Masculino' }] },
          { id: 'BRAND', values: [{ id: '35977846', name: 'Generic' }] },
        ],
        main_attribute: { attributes: [{ site_id: 'MLB', id: 'SIZE' }] },
        rows: ['P', 'M', 'G'].map((size, i) => ({
          attributes: [
            { id: 'SIZE', values: [{ name: size }] },
            { id: 'FILTRABLE_SIZE', values: [{ name: size }] },
            {
              id: 'CHEST_CIRCUMFERENCE_FROM',
              values: [{ name: `${88 + i * 8} cm` }],
            },
          ],
        })),
      }
      const data = await api('POST', '/catalog/charts', { token: t.accessToken, body })
      console.log(JSON.stringify(data, null, 2))
      break
    }

    case 'validate':
    case 'publish': {
      const t = await loadToken()
      const catId = arg || 'MLB31447'
      const item = sampleItem(catId)
      const endpoint = cmd === 'publish' ? '/items' : '/items/validate'
      if (cmd === 'publish' && process.env.ML_PUBLISH !== '1') {
        die('Publicação real bloqueada. Use ML_PUBLISH=1 para confirmar.')
      }
      const data = await api('POST', endpoint, { token: t.accessToken, body: item })
      console.log(JSON.stringify(data, null, 2))
      break
    }

    default:
      console.log(
        `Comandos: auth-url | token | me | discover [q] | attributes CAT | create-chart | validate CAT | publish CAT`,
      )
      break
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
