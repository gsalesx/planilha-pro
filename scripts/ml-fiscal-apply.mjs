#!/usr/bin/env node
/**
 * Envia dados fiscais (Faturador ML) para anúncios já publicados.
 *
 * Uso:
 *   node scripts/ml-fiscal-apply.mjs
 *   node scripts/ml-fiscal-apply.mjs MLB7574446550
 *   ML_NCM=61083200 ML_CEST=2805900 ML_CSOSN=102 node scripts/ml-fiscal-apply.mjs
 */
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const AUTH_FILE = path.join(ROOT, 'server', 'data', 'mercadolivre-auth.json')
const IMPORT_FILE = path.join(ROOT, 'server', 'data', 'ml-shopee-import.json')
const API = 'https://api.mercadolibre.com'

/** Valores do export Shopee mass_update_tax_info (iguais em todo o catálogo). */
const FISCAL_DEFAULTS = {
  ncm: process.env.ML_NCM || '61083200',
  cest: process.env.ML_CEST || '2805900',
  csosn: process.env.ML_CSOSN || '102',
  originType: process.env.ML_ORIGIN_TYPE || 'reseller',
  originDetail: process.env.ML_ORIGIN_DETAIL || '0',
  measurementUnit: process.env.ML_MEASUREMENT_UNIT || 'UN',
}

const MUTATION = `mutation($input: CreateOrUpdateFiscalInformationMLBAndLinkToItemInput!) {
  createOrUpdateFiscalInformationMLBAndLinkToItem(input: $input) {
    itemId
    variationId
    type
    components {
      sku
      fiscalInformation {
        ... on FiscalInformationMLB {
          sku ncm cest csosn originType originDetail measurementUnit
        }
      }
    }
  }
}`

async function loadToken() {
  const raw = JSON.parse(await readFile(AUTH_FILE, 'utf8'))
  if (!raw.accessToken) throw new Error('Sem token ML')
  return raw.accessToken
}

async function apiGet(token, urlPath) {
  const res = await fetch(`${API}${urlPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`${urlPath} → ${res.status}: ${JSON.stringify(json)}`)
  return json
}

async function fiscalGraphql(token, input) {
  const res = await fetch(`${API}/fiscal_information/graphql`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: MUTATION, variables: { input } }),
  })
  const json = await res.json()
  if (json.errors?.length) throw new Error(JSON.stringify(json.errors))
  return json.data
}

export async function applyFiscalToItem(token, mlItemId, fiscal = FISCAL_DEFAULTS) {
  const item = await apiGet(token, `/items/${mlItemId}`)
  const variations = item.variations || []
  if (!variations.length) {
    throw new Error(`${mlItemId} sem variações — fiscal por variação não aplicável ainda`)
  }

  for (const v of variations) {
    const sku = `${mlItemId}_${v.id}`
    await fiscalGraphql(token, {
      itemId: mlItemId,
      variationId: String(v.id),
      components: [{ quantity: 1, percentageShare: 100, sku, ...fiscal }],
    })
  }

  const can = await apiGet(token, `/can_invoice/items/${mlItemId}`)
  return { variations: variations.length, canInvoice: can.status, fiscal }
}

async function main() {
  const token = await loadToken()
  const onlyItem = process.argv[2]

  let items = []
  if (onlyItem) {
    items = [{ mlItemId: onlyItem, family: 'CAMISOLA' }]
  } else {
    const importData = JSON.parse(await readFile(IMPORT_FILE, 'utf8'))
    items = Object.entries(importData.published)
      .filter(([, r]) => r.mlItemId)
      .map(([shopeeId, r]) => ({ shopeeId, mlItemId: r.mlItemId, family: r.family || 'CAMISOLA', rec: r }))
  }

  const importData = onlyItem
    ? { published: {} }
    : JSON.parse(await readFile(IMPORT_FILE, 'utf8'))

  for (const row of items) {
    const fiscal = FISCAL_DEFAULTS
    process.stdout.write(`${row.mlItemId} `)
    try {
      const result = await applyFiscalToItem(token, row.mlItemId, fiscal)
      const patch = {
        fiscal: { ...result.fiscal, canInvoice: result.canInvoice, variations: result.variations, at: new Date().toISOString() },
      }
      if (row.rec) Object.assign(row.rec, patch)
      else if (importData.published) {
        const entry = Object.values(importData.published).find((r) => r.mlItemId === row.mlItemId)
        if (entry) Object.assign(entry, patch)
      }
      console.log(`OK canInvoice=${result.canInvoice} (${result.variations} var.)`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (row.rec) row.rec.fiscalError = msg
      console.log(`FALHOU — ${msg.slice(0, 150)}`)
    }
  }

  if (!onlyItem) {
    await writeFile(IMPORT_FILE, JSON.stringify(importData, null, 2))
    console.log(`\nAtualizado ${IMPORT_FILE}`)
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exit(1)
  })
}
