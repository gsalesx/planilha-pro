#!/usr/bin/env node
/**
 * Importa produtos exportados da Shopee (mass update) para o Mercado Livre.
 *
 * Uso:
 *   node scripts/shopee-to-ml-import.mjs parse
 *   node scripts/shopee-to-ml-import.mjs publish --limit 10 --family CAMISOLA
 *   ML_PUBLISH=1 node scripts/shopee-to-ml-import.mjs publish --limit 30 --family SHORT --gender M
 *   ML_PUBLISH=1 node scripts/shopee-to-ml-import.mjs publish --limit 10 --family CAMISOLA
 *   node scripts/shopee-to-ml-import.mjs apply-skus [--family CAMISOLA]
 *   node scripts/shopee-to-ml-import.mjs apply-prices [--sample] [--family ALL]  (preço Shopee; ML_USE_FAMILY_PRICE=1 força FAMILY_PRICE)
 *   node scripts/shopee-to-ml-import.mjs apply-listing-config [--sample] [--family ALL]
 *   node scripts/shopee-to-ml-import.mjs apply-attributes [--sample] [--family SHORT]
 *   node scripts/shopee-to-ml-import.mjs fix-gender-short [--scan] [--sample] [--only-id MLB...]
 *   ML_GENDER_FIX=1 node scripts/shopee-to-ml-import.mjs fix-gender-short
 *   node scripts/shopee-to-ml-import.mjs preview-publish [--family ALL]
 *   node scripts/shopee-to-ml-import.mjs scan-f-photos  (obsoleto — use preview-publish)
 *   node scripts/shopee-to-ml-import.mjs apply-pictures [--sample] [--family ALL]
 *   node scripts/ml-fix-category.mjs scan
 *   ML_CATEGORY_FIX=1 node scripts/ml-fix-category.mjs apply [--only-id MLB...]
 *   ML_DELETE=1 node scripts/shopee-to-ml-import.mjs delete [--scan-seller] [--keep-id MLB...]
 *   ML_CLEANUP=1 node scripts/shopee-to-ml-import.mjs cleanup [--delete] [--scan-seller]
 *
 * Arquivos Shopee (Downloads):
 *   mass_update_basic_info_*.xlsx
 *   mass_update_media_info_*.xlsx
 *   mass_update_sales_info_*.zip
 *   mass_update_shipping_info_*.zip
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import XLSX from 'xlsx'
import JSZip from 'jszip'
import { applyFiscalToItem } from './ml-fiscal-apply.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const AUTH_FILE = path.join(ROOT, 'server', 'data', 'mercadolivre-auth.json')
const RESULTS_FILE = path.join(ROOT, 'server', 'data', 'ml-shopee-import.json')
const DELETE_LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-delete.log')
const REPUBLISH_LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-republish-sample.log')
const FIX_PICTURES_LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-fix-pictures.log')
const SHORT_F_PHOTOS_LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-short-f-photos.log')
const F_PHOTOS_BULK_LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-f-photos-bulk-fix.log')
const NO_SPLIT_GENDER_LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-no-split-gender.log')
const GENDER_FIX_SHORT_LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-gender-fix-short-f.log')
const FREE_SHIPPING_LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-free-shipping-fix.log')
const FREE_SHIPPING_BULK_LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-free-shipping-bulk.log')
const SHORT_CUECA_LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-short-cueca.log')
const SHORT_ATTRIBUTES_LOG_FILE = path.join(ROOT, 'server', 'data', 'ml-short-attributes.log')
const CHARTS_FILE = path.join(ROOT, 'server', 'data', 'ml-family-charts.json')
const PUBLISH_LOCK_FILE = path.join(__dirname, '.ml-publish.lock')
const API = 'https://api.mercadolibre.com'

/** Anúncios de teste (--sample 2026-09-02) — nunca excluir por padrão. */
const SAMPLE_KEEP_IDS = new Set([
  'MLB7579550492', // CAMISOLA (ex MLB5178239249)
  'MLB5178227105', // SHORT M — referência
  'MLB7579565842', // SHORT F (ex MLB7579007644)
  'MLB7579551136', // CONJUNTO UNITARIO M (ex MLB7578976868)
  'MLB7579553810', // CONJUNTO UNITARIO F (ex MLB7578995016)
  'MLB7579562832', // CAMISOLA + SHORT (ex MLB7578977796)
  'MLB7579551926', // CAMISOLA + CONJUNTO (ex MLB7579004116)
  'MLB7579576478', // SHORT CASAL (ex MLB7579004974)
  'MLB7579577188', // CONJUNTO COMPLETO CASAL (ex MLB7579006400)
])

const DOWNLOADS = process.env.SHOPEE_EXPORT_DIR || 'C:/Users/gsale/Downloads'
const SHOPEE_SHOP = process.env.SHOPEE_SHOP_ID || '326873777'

const MANUFACTURING_DAYS = Number(process.env.ML_MANUFACTURING_DAYS || 5)
/** Calçados > Moda Íntima > Roupa de Dormir > Pijamas */
const PIJAMAS_CATEGORY = 'MLB278112'
/** Atributos de catálogo MLB278112 — família SHORT (pijama), M e F. Não usar em SHORT CUECA.
 *  SHORT = só parte inferior (short); TOP_TYPES/SLEEVE_TYPES omitidos (MLB278112 não tem "Não se aplica").
 *  Booleanos (gestante/lactante/reciclado): ML só aceita Sim/Não (value_type boolean) — não "Não se aplica". */
const SHORT_PAJAMA_ATTRS = [
  { id: 'CHARACTER', value_name: 'Não se aplica' },
  { id: 'PIECES_NUMBER', value_name: '1' },
  { id: 'CLOSURE_TYPE', value_name: 'Não se aplica' },
  { id: 'COMPOSITION', value_name: 'Não se aplica' },
  { id: 'MAIN_MATERIAL', value_name: 'Poliester' },
  { id: 'PAJAMA_BOTTOM_TYPES', value_id: '16516782', value_name: 'Short' },
  { id: 'IS_SUITABLE_FOR_PREGNANCY', value_id: '242084', value_name: 'Não' },
  { id: 'IS_SUITABLE_FOR_LACTANTING_PEOPLE', value_id: '242084', value_name: 'Não' },
  { id: 'WITH_RECYCLED_MATERIALS', value_id: '242084', value_name: 'Não' },
]
/** SHORT pijama = peça única inferior — parte superior/manga não se aplicam (remover se presentes). */
const SHORT_PAJAMA_OMIT_ATTRS = new Set(['TOP_TYPES', 'SLEEVE_TYPES'])
const SHORT_PAJAMA_AGE_GROUP = { id: '6725189', name: 'Adultos' }
const SHORT_PAJAMA_KEEP_ATTRS = new Set([
  'BRAND',
  'MODEL',
  'GENDER',
  'SIZE_GRID_ID',
  'SEASON',
  'COLOR',
  'AGE_GROUP',
])
/** Calçados, Roupas e Bolsas > Bermudas e Shorts */
const BERMUDAS_CATEGORY = 'MLB188064'
/** Família SHORT CUECA — bermuda cueca falsa (Shopee sem SKU dedicado).
 *  Refs publicadas: shopee 57966360662 → MLB7584348658; shopee 44816396709 → MLB7584337812.
 *  - Categoria MLB188064 (Bermudas e Shorts), NÃO pijama MLB278112
 *  - Título: sem prefixo "Pijama" (ensurePijamaTitle ignora esta família);
 *    sem "personalizada/o" no título (ensureShortCuecaTitle — cor fica no atributo Azul)
 *  - Preço listagem: Shopee (sales_info, tip. R$ 99); promo final R$ 59,90 (ml-promotions-apply.mjs)
 *  - Prazo de produção: nenhum (noManufacturingTime — pronta entrega)
 *  - Atributos: SHORT_TYPE=Bermuda, MAIN_MATERIAL=Tactel; COR=Azul (não Personalizado — demais famílias)
 *    sem pijamaAttrs/SEASON/AGE_GROUP
 *  - Gênero: masculino fixo; tamanhos adultos via chart shortMasc
 *  - Listing: gold_special + frete grátis (listingConfig)
 *  Detecção: resolveProductSku via SHORT_CUECA_RE no título/descrição quando SKU Shopee vazio. */
/** Moda Íntima e Lingerie > Camisolas */
const CAMISOLA_CATEGORY = 'MLB278114'
/** Detecta bermuda cueca falsa (Shopee sem SKU dedicado). */
const SHORT_CUECA_RE = /\b(cueca\s+falsa|short\s+cueca|bermuda.*cueca\s+falsa|cueca\s+falsa.*bermuda)\b/i
const TITLE_MAX_LEN = 60

/** Valor de COR para todos os anúncios — sempre em attribute_combinations das variações.
 *  ML erro 146: COLOR não pode estar em item.attributes E variation.attribute_combinations ao mesmo tempo
 *  (validado via POST /items/validate em MLB278112 e MLB278114 — scripts/ml-validate-color-test.mjs). */
const COLOR_VALUE = 'Personalizado'
/** SHORT CUECA (MLB188064): cor fixa Azul por enquanto — não usar Personalizado. */
const SHORT_CUECA_COLOR = { id: '52028', name: 'Azul' }

/** Fallback por família — só se variação Shopee sem preço ou ML_USE_FAMILY_PRICE=1. */
const FAMILY_PRICE = {
  CAMISOLA: 69.9,
  SHORT: 59.9,
  'SHORT CUECA': 99.9,
  'CONJUNTO UNITARIO': 129.9,
  'CAMISOLA + SHORT': 129.9,
  'CAMISOLA + CONJUNTO': 179.9,
  'SHORT CASAL': 99.9,
  'CONJUNTO COMPLETO CASAL': 179.9,
}

function familyPrice(familySku) {
  const envKey = `ML_PRICE_${familySku.replace(/\s+/g, '_').replace(/\+/g, 'PLUS')}`
  if (process.env[envKey]) return Number(process.env[envKey])
  if (FAMILY_PRICE[familySku] != null) return FAMILY_PRICE[familySku]
  return null
}

/** Preço de venda: Shopee (sales_info col 6) por variação; fallback FAMILY_PRICE se ausente. */
function resolveVariationPrice(variation, familySku) {
  if (process.env.ML_USE_FAMILY_PRICE === '1') return familyPrice(familySku)
  const shopee = variation?.price
  if (Number.isFinite(shopee) && shopee > 0) return shopee
  return familyPrice(familySku)
}

const GENDER = {
  FEM: { id: '339665', name: 'Feminino' },
  MASC: { id: '339666', name: 'Masculino' },
  UNISEX: { id: '110461', name: 'Sem gênero' },
}
const ADULT_SIZES = new Set(['P', 'M', 'G', 'GG'])
const PUBLISH_FAMILIES = [
  'CAMISOLA',
  'SHORT',
  'SHORT CUECA',
  'CONJUNTO UNITARIO',
  'CAMISOLA + SHORT',
  'CAMISOLA + CONJUNTO',
  'SHORT CASAL',
  'CONJUNTO COMPLETO CASAL',
]

/** MLB: gold_special = Clássico, gold_pro = Premium */
const LISTING_CLASSIC = 'gold_special'
const LISTING_PREMIUM = 'gold_pro'

function listingConfig(familySku) {
  const classic = familySku === 'CAMISOLA' || familySku === 'SHORT' || familySku === 'SHORT CUECA'
  return {
    listingTypeId: classic ? LISTING_CLASSIC : LISTING_PREMIUM,
    freeShipping: true,
  }
}

function buildShippingConfig(freeShipping = true) {
  return {
    mode: 'me2',
    local_pick_up: false,
    free_shipping: freeShipping,
  }
}

/** @returns {{ mode: 'item'|'variation', value: string, valueId?: string }} — ML só permite COR em um nível. */
function colorConfig(_categoryId, colorMode = 'variation', familySku) {
  if (familySku === 'SHORT CUECA') {
    return { mode: 'variation', value: SHORT_CUECA_COLOR.name, valueId: SHORT_CUECA_COLOR.id }
  }
  return { mode: colorMode === 'item' ? 'item' : 'variation', value: COLOR_VALUE }
}

function variationColorName(variation) {
  return variation.attribute_combinations?.find((a) => a.id === 'COLOR')?.value_name || null
}

function itemColorName(item) {
  return item.attributes?.find((a) => a.id === 'COLOR')?.value_name || null
}

function buildVariationCombinations(mlSizeName, colorCfg) {
  const combos = [{ id: 'SIZE', value_name: mlSizeName }]
  if (colorCfg.mode === 'variation') {
    combos.unshift({
      id: 'COLOR',
      ...(colorCfg.valueId ? { value_id: colorCfg.valueId } : {}),
      value_name: colorCfg.value,
    })
  }
  return combos
}

/** @type {Record<string, object>} */
let FAMILY_MAP = {}

async function loadFamilyMap() {
  const charts = JSON.parse(await readFile(CHARTS_FILE, 'utf8'))
  FAMILY_MAP = {
    CAMISOLA: {
      categoryId: 'MLB278114',
      gender: GENDER.FEM,
      chartId: process.env.ML_CHART_CAMISOLA || '7650233',
      rowBySize: {
        P: '7650233:1',
        M: '7650233:2',
        G: '7650233:3',
        GG: '7650233:4',
      },
      model: 'Camisola personalizada',
    },
    SHORT: {
      genderFilter: true,
      adultOnly: true,
      categoryId: PIJAMAS_CATEGORY,
      genderSplit: { M: GENDER.MASC, F: GENDER.FEM },
      chartKeys: { M: charts.conjUnitMasc, F: charts.conjUnitFem },
      model: 'Short pijama personalizado',
      season: { id: '994283', name: 'Primavera/Verão' },
      pijamaAttrs: SHORT_PAJAMA_ATTRS,
      ageGroup: SHORT_PAJAMA_AGE_GROUP,
    },
    'SHORT CUECA': {
      categoryId: BERMUDAS_CATEGORY,
      gender: GENDER.MASC,
      chartKey: charts.shortMasc,
      model: 'Bermuda cueca falsa',
      shortType: { id: '3752483', name: 'Bermuda' },
      mainMaterial: { name: 'Tactel' },
      skipUnmapped: true,
      noManufacturingTime: true,
    },
    'CONJUNTO UNITARIO': {
      genderFilter: true,
      adultOnly: true,
      categoryId: PIJAMAS_CATEGORY,
      genderSplit: { M: GENDER.MASC, F: GENDER.FEM },
      chartKeys: { M: charts.conjUnitMasc, F: charts.conjUnitFem },
      model: 'Conjunto pijama personalizado',
      season: { id: '994283', name: 'Primavera/Verão' },
    },
    'CAMISOLA + SHORT': {
      categoryId: PIJAMAS_CATEGORY,
      gender: GENDER.UNISEX,
      chartKey: charts.camisolaShort,
      varMode: 'combo',
      model: 'Camisola e short personalizado',
      season: { id: '994283', name: 'Primavera/Verão' },
      skipUnmapped: true,
    },
    'CAMISOLA + CONJUNTO': {
      categoryId: PIJAMAS_CATEGORY,
      gender: GENDER.UNISEX,
      chartKey: charts.casal,
      varMode: 'camConj',
      model: 'Camisola e conjunto personalizado',
      season: { id: '994283', name: 'Primavera/Verão' },
    },
    'SHORT CASAL': {
      categoryId: PIJAMAS_CATEGORY,
      gender: GENDER.UNISEX,
      chartKey: charts.casal,
      varMode: 'casal',
      model: 'Short casal personalizado',
      season: { id: '994283', name: 'Primavera/Verão' },
    },
    'CONJUNTO COMPLETO CASAL': {
      categoryId: PIJAMAS_CATEGORY,
      gender: GENDER.UNISEX,
      chartKey: charts.casal,
      varMode: 'casal',
      model: 'Conjunto casal personalizado',
      season: { id: '994283', name: 'Primavera/Verão' },
    },
  }
  return FAMILY_MAP
}

function familyCfgFromDef(def, genderKey) {
  if (def.chartKeys && genderKey) {
    const chart = def.chartKeys[genderKey]
    return {
      categoryId: def.categoryId,
      gender: def.genderSplit[genderKey],
      chartId: chart.id,
      rowBySize: chart.rowBySize,
      model: def.model,
      season: def.season,
      shortType: def.shortType,
      mainMaterial: def.mainMaterial,
      pijamaAttrs: def.pijamaAttrs,
      ageGroup: def.ageGroup,
      noManufacturingTime: def.noManufacturingTime,
    }
  }
  if (def.chartKey) {
    const chart = def.chartKey
    return {
      categoryId: def.categoryId,
      gender: def.gender,
      chartId: chart.id,
      rowBySize: chart.rowBySize,
      model: def.model,
      season: def.season,
      skipUnmapped: def.skipUnmapped,
      shortType: def.shortType,
      mainMaterial: def.mainMaterial,
      noManufacturingTime: def.noManufacturingTime,
    }
  }
  return {
    categoryId: def.categoryId,
    gender: def.gender,
    chartId: def.chartId,
    rowBySize: def.rowBySize,
    model: def.model,
    season: def.season,
    skipUnmapped: def.skipUnmapped,
  }
}

function die(msg) {
  console.error(`Erro: ${msg}`)
  process.exit(1)
}

function parseArgs(argv) {
  const out = {
    cmd: argv[2] || 'help',
    limit: 10,
    family: 'CAMISOLA',
    keepFamily: 'CAMISOLA',
    skipIds: new Set(),
    keepIds: new Set(
      process.env.ML_KEEP_IDS
        ? process.env.ML_KEEP_IDS.split(',').map((s) => s.trim()).filter(Boolean)
        : SAMPLE_KEEP_IDS,
    ),
    onlyId: null,
    sample: false,
    force: false,
    deletePermanently: false,
    scanSeller: false,
    delayMs: 350,
    gender: null,
    colorMode: process.env.ML_COLOR_MODE || 'variation',
  }
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--limit') out.limit = Number(argv[++i])
    else if (argv[i] === '--family') out.family = argv[++i]
    else if (argv[i] === '--gender') out.gender = String(argv[++i]).toUpperCase()
    else if (argv[i] === '--keep') out.keepFamily = argv[++i]
    else if (argv[i] === '--skip') out.skipIds.add(String(argv[++i]))
    else if (argv[i] === '--keep-id') out.keepIds.add(String(argv[++i]))
    else if (argv[i] === '--only') out.onlyId = String(argv[++i])
    else if (argv[i] === '--sample') out.sample = true
    else if (argv[i] === '--force') out.force = true
    else if (argv[i] === '--delete') out.deletePermanently = true
    else if (argv[i] === '--scan-seller') out.scanSeller = true
    else if (argv[i] === '--delay') out.delayMs = Number(argv[++i])
    else if (argv[i] === '--color-mode') out.colorMode = argv[++i]
  }
  return out
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function acquirePublishLock() {
  const { readFile, writeFile, unlink } = await import('node:fs/promises')
  try {
    const existing = await readFile(PUBLISH_LOCK_FILE, 'utf8')
    die(`Publicação bloqueada: lock ativo (${PUBLISH_LOCK_FILE})\n${existing}`)
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }
  try {
    await writeFile(PUBLISH_LOCK_FILE, `${process.pid}\n${new Date().toISOString()}\n`, { flag: 'wx' })
  } catch (err) {
    if (err.code === 'EEXIST') {
      const existing = await readFile(PUBLISH_LOCK_FILE, 'utf8')
      die(`Publicação bloqueada: lock ativo (${PUBLISH_LOCK_FILE})\n${existing}`)
    }
    throw err
  }
  const release = async () => {
    try {
      await unlink(PUBLISH_LOCK_FILE)
    } catch {
      /* lock já removido */
    }
  }
  process.once('exit', () => {
    unlink(PUBLISH_LOCK_FILE).catch(() => {})
  })
  return release
}

function errSummary(err) {
  const r = err.response
  if (!r) return err.message
  const msg = r.message || r.error || ''
  const cause = Array.isArray(r.cause) ? r.cause.map((c) => c.message || c.code).join('; ') : ''
  return [msg, cause].filter(Boolean).join(' — ') || JSON.stringify(r)
}

async function appendDeleteLog(line) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(DELETE_LOG_FILE, `${line}\n`)
}

async function appendRepublishLog(line) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(REPUBLISH_LOG_FILE, `${line}\n`)
}

async function appendFixPicturesLog(line) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(FIX_PICTURES_LOG_FILE, `${line}\n`)
}

async function appendShortFPhotosLog(line) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(SHORT_F_PHOTOS_LOG_FILE, `${line}\n`)
}

async function appendShortAttributesLog(line) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(SHORT_ATTRIBUTES_LOG_FILE, `${line}\n`)
}

function shortPijamaAttributesOk(existingAttrs) {
  for (const id of SHORT_PAJAMA_OMIT_ATTRS) {
    if (existingAttrs?.some((a) => a.id === id)) return false
  }
  for (const expected of SHORT_PAJAMA_ATTRS) {
    const current = existingAttrs?.find((a) => a.id === expected.id)
    if (!current) return false
    if (expected.value_id && String(current.value_id) !== String(expected.value_id)) return false
    if (expected.value_name && current.value_name !== expected.value_name) return false
  }
  const age = existingAttrs?.find((a) => a.id === 'AGE_GROUP')
  return !age || age.value_id === SHORT_PAJAMA_AGE_GROUP.id
}

function buildShortPijamaAttributePayload(existingAttrs) {
  const kept = (existingAttrs || [])
    .filter((a) => SHORT_PAJAMA_KEEP_ATTRS.has(a.id) && !SHORT_PAJAMA_OMIT_ATTRS.has(a.id))
    .map((a) => ({
      id: a.id,
      value_id: a.value_id,
      value_name: a.value_name,
    }))
  const omitNulls = [...SHORT_PAJAMA_OMIT_ATTRS].map((id) => ({
    id,
    value_id: null,
    value_name: null,
  }))
  return [...kept, ...SHORT_PAJAMA_ATTRS.map((a) => ({ ...a })), ...omitNulls]
}

async function appendFPhotosBulkLog(line) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(F_PHOTOS_BULK_LOG_FILE, `${line}\n`)
}

async function appendNoSplitGenderLog(text) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(NO_SPLIT_GENDER_LOG_FILE, text.endsWith('\n') ? text : `${text}\n`)
}

async function appendFreeShippingLog(line, bulk = false) {
  const { appendFile } = await import('node:fs/promises')
  const file = bulk ? FREE_SHIPPING_BULK_LOG_FILE : FREE_SHIPPING_LOG_FILE
  await appendFile(file, `${line}\n`)
}

async function appendShortCuecaLog(line) {
  const { appendFile } = await import('node:fs/promises')
  await appendFile(SHORT_CUECA_LOG_FILE, `${line}\n`)
}

/** SKU Shopee vazio → família por título/descrição (ex.: bermuda cueca falsa). */
function resolveProductSku({ sku, title, description }) {
  const trimmed = String(sku || '').trim()
  if (trimmed) return trimmed
  const text = `${title || ''} ${description || ''}`
  if (SHORT_CUECA_RE.test(text)) return 'SHORT CUECA'
  return trimmed
}

/** PUT idempotente — partial updates (preço, fotos) podem zerar free_shipping em gold_special.
 *  Sempre re-aplica: GET free_shipping=true não garante me_seller no painel do vendedor. */
async function ensureFreeShipping(token, mlItemId) {
  const item = await api('GET', `/items/${mlItemId}`, { token })
  const prev = {
    freeShipping: item.shipping?.free_shipping ?? false,
    mode: item.shipping?.mode ?? null,
    localPickUp: item.shipping?.local_pick_up ?? null,
  }
  await api('PUT', `/items/${mlItemId}`, {
    token,
    body: { shipping: buildShippingConfig(true) },
  })
  const verified = await api('GET', `/items/${mlItemId}`, { token })
  const freeShipping = verified.shipping?.free_shipping ?? false
  const changed =
    !prev.freeShipping ||
    prev.mode !== 'me2' ||
    prev.localPickUp !== false ||
    !freeShipping
  return { changed, freeShipping, previousFreeShipping: prev.freeShipping }
}

/** Tokens úteis pra achar anúncio Shopee feminino equivalente (mesmo SKU/família). */
function titleMatchTokens(title) {
  return String(title)
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\b(masculin[oa]|feminin[oa]|presente|personalizad[oa]|com|para|de|e|o|a|no|na|um|uma|dia|dos|namorados)\b/g, ' ')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
}

/** Anúncio Shopee com fotos femininas pra splitGender#F quando o produto base é masculino. */
function findFeminineImageProduct(product, catalog) {
  const envKey = `ML_IMAGE_${product.shopeeId}_F`
  const envId = process.env[envKey]
  if (envId) {
    const fromEnv = catalog.find((p) => p.shopeeId === envId) || null
    return fromEnv ? { product: fromEnv, score: 999, via: 'env' } : null
  }

  const tokens = new Set(titleMatchTokens(product.title))
  let best = null
  let bestScore = 0
  let secondScore = 0
  for (const candidate of catalog) {
    if (candidate.shopeeId === product.shopeeId) continue
    if (candidate.sku !== product.sku) continue
    if (!/feminin/i.test(candidate.title)) continue
    if (!candidate.images?.length) continue
    const score = titleMatchTokens(candidate.title).filter((t) => tokens.has(t)).length
    if (score > bestScore) {
      secondScore = bestScore
      bestScore = score
      best = candidate
    } else if (score > secondScore) {
      secondScore = score
    }
  }
  if (bestScore >= 2) return { product: best, score: bestScore, via: 'tokens' }
  // Fallback: score 1 só quando não há empate (evita chute errado em bulk)
  if (bestScore === 1 && secondScore < 1) return { product: best, score: bestScore, via: 'tokens-weak' }
  return null
}

function imagesForPublishJob(product) {
  return product.images || []
}

function feminineImageMeta(product, genderKey, catalog) {
  if (!genderKey || genderKey === 'M' || /feminin/i.test(product.title)) {
    return { needsLookup: false, femSource: null, match: null, warning: null }
  }
  const match = findFeminineImageProduct(product, catalog)
  if (match?.product) {
    return { needsLookup: true, femSource: match.product.shopeeId, match, warning: null }
  }
  return {
    needsLookup: true,
    femSource: null,
    match: null,
    warning: `Sem anúncio Shopee feminino para ${product.shopeeId} (${product.sku}) — defina ML_IMAGE_${product.shopeeId}_F`,
  }
}

function needsGenderPictureReplace(product, genderKey) {
  return genderKey === 'F' && product && /masculin/i.test(product.title)
}

async function loadToken() {
  let raw = JSON.parse(await readFile(AUTH_FILE, 'utf8'))
  if (!raw.accessToken) die('Sem token ML em server/data/mercadolivre-auth.json')

  const probe = await fetch(`${API}/users/me`, {
    headers: { Authorization: `Bearer ${raw.accessToken}` },
  })
  if (probe.ok) return raw

  const appId = process.env.ML_APP_ID || process.env.MERCADOLIVRE_APP_ID
  const clientSecret = process.env.ML_CLIENT_SECRET || process.env.MERCADOLIVRE_CLIENT_SECRET
  if (!appId || !clientSecret || !raw.refreshToken) {
    die('Token ML expirado. Renove OAuth (planilha.guilhermesales.com) ou defina ML_APP_ID + ML_CLIENT_SECRET')
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
  if (!res.ok) die(`Refresh token falhou: ${JSON.stringify(json)}`)
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

async function tryLoadToken() {
  let raw
  try {
    raw = JSON.parse(await readFile(AUTH_FILE, 'utf8'))
  } catch {
    return null
  }
  if (!raw.accessToken) return null

  const probe = await fetch(`${API}/users/me`, {
    headers: { Authorization: `Bearer ${raw.accessToken}` },
  })
  if (probe.ok) return raw

  const appId = process.env.ML_APP_ID || process.env.MERCADOLIVRE_APP_ID
  const clientSecret = process.env.ML_CLIENT_SECRET || process.env.MERCADOLIVRE_CLIENT_SECRET
  if (!appId || !clientSecret || !raw.refreshToken) return null

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
  if (!res.ok) return null
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

function findExportFile(prefix) {
  return path.join(DOWNLOADS, `${prefix}_${SHOPEE_SHOP}_`)
}

async function readXlsxRows(filePath) {
  const wb = XLSX.readFile(filePath)
  const sheet = wb.Sheets[wb.SheetNames[0]]
  return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' })
}

async function readZipSheets(baseName) {
  const { readdir } = await import('node:fs/promises')
  const zipPath = `${baseName}.zip`
  const buf = await readFile(zipPath)
  const zip = await JSZip.loadAsync(buf)
  const rows = []
  for (const [name, file] of Object.entries(zip.files)) {
    if (!name.endsWith('.xlsx')) continue
    const data = await file.async('nodebuffer')
    const wb = XLSX.read(data)
    const sheetRows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' })
    rows.push(...sheetRows.slice(6))
  }
  return rows
}

async function resolveExportPaths() {
  const { readdir } = await import('node:fs/promises')
  const files = await readdir(DOWNLOADS)
  const pick = (prefix) => {
    const f = files.find((n) => n.startsWith(prefix) && n.includes(SHOPEE_SHOP))
    if (!f) die(`Arquivo não encontrado: ${prefix}_*_${SHOPEE_SHOP} em ${DOWNLOADS}`)
    return path.join(DOWNLOADS, f)
  }
  return {
    basic: pick('mass_update_basic_info'),
    media: pick('mass_update_media_info'),
    salesZip: pick('mass_update_sales_info').replace(/\.zip$/i, ''),
    shippingZip: pick('mass_update_shipping_info').replace(/\.zip$/i, ''),
  }
}

async function loadCatalog() {
  const paths = await resolveExportPaths()
  const basicRows = await readXlsxRows(paths.basic)
  const mediaRows = await readXlsxRows(paths.media)
  const salesRows = await readZipSheets(paths.salesZip)
  const shipRows = await readZipSheets(paths.shippingZip)

  const mediaById = new Map()
  for (const r of mediaRows.slice(6)) {
    if (!r[0]) continue
    mediaById.set(String(r[0]), {
      sku: r[1],
      title: r[2],
      images: r.slice(4, 14).filter(Boolean),
    })
  }

  const salesById = new Map()
  for (const r of salesRows) {
    if (!r[0]) continue
    const id = String(r[0])
    if (!salesById.has(id)) salesById.set(id, [])
    salesById.get(id).push({
      name: String(r[3]).trim(),
      modelId: String(r[2] || '').trim(),
      parentSku: String(r[4] || '').trim(),
      modelSku: String(r[5] || '').trim(),
      price: parseFloat(String(r[6]).replace(',', '.')),
      stock: parseInt(String(r[8] || '1000'), 10) || 1000,
    })
  }

  const shipById = new Map()
  for (const r of shipRows) {
    if (!r[0]) continue
    const id = String(r[0])
    if (!shipById.has(id)) {
      shipById.set(id, {
        weightKg: parseFloat(String(r[5] || '0.4').replace(',', '.')) || 0.4,
        length: parseInt(String(r[6] || '20'), 10) || 20,
        width: parseInt(String(r[7] || '20'), 10) || 20,
        height: parseInt(String(r[8] || '12'), 10) || 12,
      })
    }
  }

  const products = []
  for (const r of basicRows.slice(6)) {
    if (!r[0]) continue
    const id = String(r[0])
    const rawSku = String(r[1] || '').trim()
    const media = mediaById.get(id)
    const title = String(r[2] || media?.title || '').trim()
    const description = String(r[3] || '').trim()
    const sku = resolveProductSku({ sku: rawSku, title, description })
    const variations = salesById.get(id) || []
    if (!media?.images?.length || !variations.length) continue
    products.push({
      shopeeId: id,
      sku,
      title,
      description,
      images: media.images,
      variations,
      shipping: shipById.get(id) || { weightKg: 0.4, length: 20, width: 20, height: 12 },
    })
  }
  return products
}

function fitTitle(title, max = TITLE_MAX_LEN) {
  const t = String(title).replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  if (lastSpace > max * 0.55) return cut.slice(0, lastSpace).trim()
  return cut.trim()
}

function titleForGender(title, genderKey) {
  let t = title.trim()
  if (genderKey === 'M') {
    t = t.replace(/feminin[oa]/gi, 'Masculino')
    if (!/masculin/i.test(t)) {
      if (/\broupa\s+de\s+dormir\b/i.test(t)) t = t.replace(/\broupa\s+de\s+dormir\b/i, 'Roupa De Dormir Masculina')
      else t = t.replace(/\b(conjunto|short|pijama)\b/i, (m) => `${m} Masculino`)
    }
  } else if (genderKey === 'F') {
    t = t.replace(/masculin[oa]/gi, 'Feminino')
    if (!/feminin/i.test(t)) {
      if (/\broupa\s+de\s+dormir\b/i.test(t)) t = t.replace(/\broupa\s+de\s+dormir\b/i, 'Roupa De Dormir Feminina')
      else t = t.replace(/\b(conjunto|short|pijama)\b/i, (m) => `${m} Feminino`)
    }
  }
  return fitTitle(t)
}

function titleForListing(title, gender, genderKey) {
  if (gender?.id === '110461') {
    return fitTitle(
      title
        .replace(/\b(masculin[oa]|feminin[oa])\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
  }
  if (genderKey) return titleForGender(title, genderKey)
  return fitTitle(title)
}

/** ML reclassifica títulos só com "Short"/"Conjunto" para Bermudas (MLB188064). */
function ensurePijamaTitle(title, familySku) {
  if (familySku !== 'SHORT' && familySku !== 'CONJUNTO UNITARIO') return title
  if (/\bpijama\b/i.test(title)) return title
  return fitTitle(title.replace(/\b(short|conjunto)\b/i, (m) => `Pijama ${m}`))
}

/** SHORT CUECA: título sem "personalizada/o" (cor Azul no atributo, não no título). */
function ensureShortCuecaTitle(title, familySku) {
  if (familySku !== 'SHORT CUECA') return title
  return fitTitle(
    title
      .replace(/\bpersonalizad[oa]\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim(),
  )
}

/** ML rejeita emojis e alguns símbolos na descrição plain_text. */
function sanitizeDescription(text) {
  return String(text)
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
    .replace(/[⭐❤️🛑📌💡📸⚠️🌈📆🤑🎁📦❌💙]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function normalizeSizeName(name) {
  return String(name).trim().toUpperCase()
}

function normCasal(name) {
  return String(name)
    .replace(/Feminino/gi, 'Fem')
    .replace(/Masculino/gi, 'Masc')
    .replace(/\s+/g, ' ')
    .trim()
}

function normComboSize(name) {
  return String(name)
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .join(',')
}

function normCamConj(name) {
  const m = String(name).trim().match(/^([^,]+),(.+)$/)
  if (!m) return normCasal(name)
  const a = m[1].trim()
  const b = m[2].trim()
  const gMatch = b.match(/\s+(Masc|Fem)$/i)
  const g = gMatch ? (gMatch[1].toLowerCase() === 'masc' ? 'Masc' : 'Fem') : 'Masc'
  const sb = b.replace(/\s+(Masc|Fem)$/i, '').trim()
  return `${a} ${g},${sb} ${g}`
}

function mlSizeFromVariation(name, varMode) {
  switch (varMode) {
    case 'casal':
      return normCasal(name)
    case 'camConj':
      return normCamConj(name)
    case 'combo':
      return normComboSize(name)
    default:
      return normalizeSizeName(name)
  }
}

function parseGenderSize(name) {
  const parts = String(name)
    .split(',')
    .map((s) => s.trim())
  if (parts.length !== 2) return null
  if (/^(Feminino|Masculino|Fem|Masc)$/i.test(parts[0])) {
    const gender = /^(Masculino|Masc)$/i.test(parts[0]) ? 'M' : 'F'
    return { gender, size: parts[1].toUpperCase(), mlSizeName: parts[1].toUpperCase() }
  }
  if (/^(Feminino|Masculino|Fem|Masc)$/i.test(parts[1])) {
    const gender = /^(Masculino|Masc)$/i.test(parts[1]) ? 'M' : 'F'
    return { gender, size: parts[0].toUpperCase(), mlSizeName: parts[0].toUpperCase() }
  }
  return null
}

/** Gênero explícito no texto (título ou descrição Shopee). */
function genderFromText(text) {
  const t = String(text || '')
  if (/feminin/i.test(t)) return 'F'
  if (/masculin/i.test(t)) return 'M'
  return null
}

/** Heurísticas quando título/descrição/variações não trazem gênero explícito. */
function genderFromHints(product) {
  const hint = `${product.title || ''} ${product.description || ''}`.toLowerCase()
  if (/\b(samba\s*can(c|ç)(a|ã)o|para\s+namorado|para\s+homem|de\s+namorado)\b/.test(hint)) return 'M'
  if (/\b(para\s+namorada|para\s+esposa|para\s+mulher|short\s+doll|pijama\s+curto\s+fem)\b/.test(hint)) return 'F'
  // Roupa de dormir / pijama sem marcador masculino → linha feminina na Shopee
  if (
    /\b(roupa\s+de\s+dormir|pijama\s+short|pijama\s+curto)\b/.test(hint) &&
    !/masculin|para\s+namorado|samba/.test(hint)
  ) {
    return 'F'
  }
  return null
}

/** Gênero do anúncio Shopee: título > descrição > variações > heurísticas > M. */
function detectProductGender(product) {
  const fromTitle = genderFromText(product.title)
  if (fromTitle) return fromTitle
  const fromDesc = genderFromText(product.description)
  if (fromDesc) return fromDesc
  const counts = { M: 0, F: 0 }
  for (const v of product.variations) {
    const parsed = parseGenderSize(v.name)
    if (parsed) counts[parsed.gender]++
  }
  if (counts.M > counts.F) return 'M'
  if (counts.F > counts.M) return 'F'
  const hinted = genderFromHints(product)
  if (hinted) return hinted
  return 'M'
}

function prepareVariations(product, familyDef) {
  if (familyDef.genderFilter) {
    const gender = detectProductGender(product)
    const vars = []
    for (const v of product.variations) {
      const parsed = parseGenderSize(v.name)
      if (!parsed || parsed.gender !== gender) continue
      if (familyDef.adultOnly && !ADULT_SIZES.has(parsed.size)) continue
      vars.push({ ...v, mlSizeName: parsed.mlSizeName })
    }
    return vars
  }
  const rowBySize = familyDef.chartKey?.rowBySize || {}
  const vars = []
  for (const v of product.variations) {
    const mlSizeName = mlSizeFromVariation(v.name, familyDef.varMode)
    if (familyDef.skipUnmapped && !rowBySize[mlSizeName]) continue
    vars.push({ ...v, mlSizeName })
  }
  return vars
}

function expandPublishJobs(product, familySku, familyDef) {
  if (familyDef.genderFilter) {
    const gender = detectProductGender(product)
    const vars = prepareVariations(product, familyDef)
    if (!vars.length) return []
    return [
      {
        publishKey: product.shopeeId,
        shopeeId: product.shopeeId,
        family: familySku,
        genderKey: gender,
        product: { ...product, variations: vars },
        familyCfg: familyCfgFromDef(familyDef, gender),
      },
    ]
  }
  const vars = prepareVariations(product, familyDef)
  if (!vars.length) return []
  return [
    {
      publishKey: product.shopeeId,
      shopeeId: product.shopeeId,
      family: familySku,
      product: { ...product, variations: vars },
      familyCfg: familyCfgFromDef(familyDef),
    },
  ]
}

/** Chave legível pra SKU de variação (Shopee repete o mesmo model_sku em todas). */
function skuSlug(name) {
  return String(name)
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '-')
    .replace(/,/g, '-')
    .replace(/[^A-Z0-9_-]/g, '')
}

function buildVariationSku(familySku, variationName, modelSku) {
  const base = (familySku || modelSku || 'ITEM').trim()
  return `${base}-${skuSlug(variationName)}`.slice(0, 60)
}

function itemReferenceSku(product) {
  return (product.sku || product.variations[0]?.parentSku || '').trim()
}

async function uploadPicture(token, url) {
  const created = await api('POST', '/pictures', { token, body: { source: url } })
  for (let i = 0; i < 25; i++) {
    const st = await api('GET', `/pictures/${created.id}`, { token })
    if (st.status === 'ACTIVE') return created.id
    await new Promise((r) => setTimeout(r, 1200))
  }
  return created.id
}

async function uploadPictures(token, urls, { onError } = {}) {
  const ids = []
  for (const url of urls.slice(0, 10)) {
    try {
      ids.push(await uploadPicture(token, url))
    } catch (err) {
      if (onError) onError(url, err)
      else throw err
    }
  }
  return ids
}

function buildItem(product, familyCfg, pictureIds, genderKey, familySku, colorMode = 'variation') {
  if (!pictureIds.length) throw new Error('Nenhuma foto enviada ao ML')
  const rowBySize = familyCfg.rowBySize
  const mappedVars = product.variations.filter((v) => rowBySize[v.mlSizeName])
  const unknownSizes = product.variations
    .map((v) => v.mlSizeName)
    .filter((s) => !rowBySize[s])
  if (!mappedVars.length) {
    throw new Error(`Nenhuma variação mapeada (${product.shopeeId}): ${unknownSizes.join(', ')}`)
  }
  if (unknownSizes.length && !familyCfg.skipUnmapped) {
    throw new Error(`Tamanhos não mapeados (${product.shopeeId}): ${unknownSizes.join(', ')}`)
  }

  const refSku = itemReferenceSku(product)
  const title = ensureShortCuecaTitle(
    ensurePijamaTitle(
      titleForListing(product.title, familyCfg.gender, genderKey),
      familySku,
    ),
    familySku,
  )
  const pricedVars = mappedVars.map((v) => ({
    ...v,
    listPrice: resolveVariationPrice(v, familySku),
  }))
  const prices = pricedVars.map((v) => v.listPrice).filter((p) => p != null && p > 0)
  if (!prices.length) throw new Error(`Sem preço Shopee (${product.shopeeId})`)
  const listPrice = Math.min(...prices)
  const { listingTypeId, freeShipping } = listingConfig(familySku)
  const colorCfg = colorConfig(familyCfg.categoryId, colorMode, familySku)
  const attrs = [
    { id: 'BRAND', value_id: '35977846', value_name: 'Generic' },
    { id: 'MODEL', value_name: familyCfg.model },
    { id: 'GENDER', value_id: familyCfg.gender.id, value_name: familyCfg.gender.name },
    { id: 'SIZE_GRID_ID', value_name: familyCfg.chartId },
  ]
  if (colorCfg.mode === 'item') {
    attrs.push({ id: 'COLOR', value_name: colorCfg.value })
  }
  if (familyCfg.season) {
    attrs.push({ id: 'SEASON', value_id: familyCfg.season.id, value_name: familyCfg.season.name })
  }
  if (familyCfg.shortType) {
    attrs.push({ id: 'SHORT_TYPE', value_id: familyCfg.shortType.id, value_name: familyCfg.shortType.name })
  }
  if (familyCfg.mainMaterial) {
    attrs.push({
      id: 'MAIN_MATERIAL',
      ...(familyCfg.mainMaterial.id ? { value_id: familyCfg.mainMaterial.id } : {}),
      value_name: familyCfg.mainMaterial.name,
    })
  }
  if (familyCfg.pijamaAttrs?.length) {
    attrs.push(...familyCfg.pijamaAttrs.map((a) => ({ ...a })))
  }
  if (familyCfg.ageGroup) {
    attrs.push({
      id: 'AGE_GROUP',
      value_id: familyCfg.ageGroup.id,
      value_name: familyCfg.ageGroup.name,
    })
  }

  return {
    title,
    category_id: familyCfg.categoryId,
    price: listPrice,
    currency_id: 'BRL',
    available_quantity: 1,
    buying_mode: 'buy_it_now',
    condition: 'new',
    listing_type_id: listingTypeId,
    shipping: buildShippingConfig(freeShipping),
    seller_custom_field: refSku || undefined,
    pictures: pictureIds.map((id) => ({ id })),
    sale_terms: [
      { id: 'WARRANTY_TYPE', value_name: 'Garantia do vendedor' },
      { id: 'WARRANTY_TIME', value_name: '90 dias' },
      ...(familyCfg.noManufacturingTime
        ? []
        : [{ id: 'MANUFACTURING_TIME', value_name: `${MANUFACTURING_DAYS} dias` }]),
    ],
    attributes: attrs,
    variations: pricedVars.map((v) => ({
      attribute_combinations: buildVariationCombinations(v.mlSizeName, colorCfg),
      price: v.listPrice,
      available_quantity: Math.min(v.stock, 999),
      attributes: [
        { id: 'SIZE_GRID_ROW_ID', value_name: rowBySize[v.mlSizeName] },
        {
          id: 'SELLER_SKU',
          value_name: buildVariationSku(refSku, v.name, v.modelSku),
        },
      ],
      // ML exibe na galeria só picture_ids da variação — todas as fotos do item
      picture_ids: pictureIds,
    })),
  }
}

function variationSizeKey(variation) {
  const size = variation.attribute_combinations?.find((a) => a.id === 'SIZE')
  return size ? normalizeSizeName(size.value_name) : ''
}

async function cmdApplyPrices({ family, sample, onlyId }) {
  const { accessToken: token } = await loadToken()
  await loadFamilyMap()
  const results = await loadResults()
  const catalog = await loadCatalog()
  const byShopeeId = new Map(catalog.map((p) => [p.shopeeId, p]))

  let entries = Object.entries(results.published).filter(
    ([, rec]) => rec.mlItemId && !rec.error,
  )
  if (sample) entries = entries.filter(([, rec]) => SAMPLE_KEEP_IDS.has(rec.mlItemId))
  if (family && family !== 'ALL') entries = entries.filter(([, rec]) => rec.family === family)
  if (onlyId) entries = entries.filter(([, rec]) => rec.mlItemId === onlyId)

  console.log(`Aplicando preços Shopee em ${entries.length} anúncios…`)

  for (const [publishKey, rec] of entries) {
    const fam = rec.family
    const shopeeId = rec.shopeeId || publishKey.split('#')[0]
    const product = byShopeeId.get(shopeeId)
    const familyDef = FAMILY_MAP[fam]
    const priceBySize = new Map()
    if (product && familyDef) {
      for (const v of prepareVariations(product, familyDef)) {
        const p = resolveVariationPrice(v, fam)
        if (p != null) priceBySize.set(v.mlSizeName, p)
      }
    }
    const fallbackPrice = familyPrice(fam)
    if (!priceBySize.size && fallbackPrice == null) {
      console.log(`\n[${publishKey}] ${rec.mlItemId} — sem preço Shopee nem fallback (${fam}), pulando`)
      continue
    }
    process.stdout.write(`\n[${publishKey}] ${rec.mlItemId} (${fam})… `)
    try {
      const item = await api('GET', `/items/${rec.mlItemId}`, { token })
      const oldPrice = item.price
      let newPrices
      if (item.variations?.length) {
        newPrices = item.variations.map((v) => {
          const sizeKey = variationSizeKey(v)
          const price = priceBySize.get(sizeKey) ?? fallbackPrice
          if (price == null) throw new Error(`sem preço para tamanho ${sizeKey}`)
          return { id: v.id, price }
        })
        await api('PUT', `/items/${rec.mlItemId}`, { token, body: { variations: newPrices } })
      } else {
        const price = priceBySize.values().next().value ?? fallbackPrice
        if (price == null) throw new Error('sem preço')
        newPrices = [{ price }]
        await api('PUT', `/items/${rec.mlItemId}`, { token, body: { price } })
      }
      const ship = await ensureFreeShipping(token, rec.mlItemId)
      const applied = newPrices.map((v) => v.price)
      rec.priceApplied = {
        prices: applied,
        source: process.env.ML_USE_FAMILY_PRICE === '1' ? 'family' : 'shopee',
        previousPrice: oldPrice,
        at: new Date().toISOString(),
      }
      if (ship.changed) {
        rec.freeShippingApplied = { ...ship, at: new Date().toISOString() }
      }
      results.published[publishKey] = rec
      await saveResults(results)
      const label = applied.length === 1 ? String(applied[0]) : `[${applied.join(', ')}]`
      console.log(`OK ${oldPrice} → ${label}`)
    } catch (err) {
      console.log('FALHOU')
      console.error(JSON.stringify(err.response || err.message, null, 2))
    }
  }
}

async function cmdApplySkus({ family }) {
  await loadFamilyMap()
  const { accessToken: token } = await loadToken()
  const familyDef = FAMILY_MAP[family]
  if (!familyDef) die(`Família não mapeada: ${family}`)

  const results = await loadResults()
  const catalog = await loadCatalog()
  const byShopeeId = new Map(catalog.map((p) => [p.shopeeId, p]))

  const entries = Object.entries(results.published).filter(
    ([, rec]) => rec.mlItemId && !rec.error && rec.family === family,
  )
  console.log(`Aplicando SKUs em ${entries.length} anúncios (${family})…`)

  for (const [publishKey, rec] of entries) {
    const shopeeId = rec.shopeeId || publishKey.split('#')[0]
    const product = byShopeeId.get(shopeeId)
    if (!product) {
      console.log(`[${publishKey}] sem catálogo Shopee — pulando`)
      continue
    }
    const genderKey = publishKey.includes('#') ? publishKey.split('#')[1] : null
    const parsedVars = prepareVariations(product, familyDef)
    const jobVars = Array.isArray(parsedVars)
      ? parsedVars
      : genderKey
        ? parsedVars[genderKey] || []
        : []
    const effectiveGender =
      genderKey || (familyDef.genderFilter ? detectProductGender(product) : null)
    const familyCfg =
      effectiveGender && familyDef.chartKeys
        ? familyCfgFromDef(familyDef, effectiveGender)
        : familyCfgFromDef(familyDef)
    const refSku = itemReferenceSku(product)
    process.stdout.write(`\n[${publishKey}] ${rec.mlItemId}… `)
    try {
      const item = await api('GET', `/items/${rec.mlItemId}`, { token })
      const skuBySize = new Map(
        jobVars.map((v) => [v.mlSizeName, buildVariationSku(refSku, v.name, v.modelSku)]),
      )
      const variations = item.variations.map((v) => {
        const sizeKey = variationSizeKey(v)
        const sellerSku = skuBySize.get(sizeKey)
        const rowId = familyCfg.rowBySize[sizeKey]
        const attrs = [...(v.attributes || [])].filter((a) => a.id !== 'SELLER_SKU')
        if (rowId) attrs.push({ id: 'SIZE_GRID_ROW_ID', value_name: rowId })
        if (sellerSku) attrs.push({ id: 'SELLER_SKU', value_name: sellerSku })
        return {
          id: v.id,
          attribute_combinations: v.attribute_combinations,
          price: v.price,
          available_quantity: v.available_quantity,
          picture_ids: v.picture_ids,
          attributes: attrs,
        }
      })
      await api('PUT', `/items/${rec.mlItemId}`, {
        token,
        body: { seller_custom_field: refSku, variations },
      })
      rec.skus = { refSku, at: new Date().toISOString() }
      results.published[publishKey] = rec
      await saveResults(results)
      console.log('OK')
    } catch (err) {
      console.log('FALHOU')
      console.error(JSON.stringify(err.response || err.message, null, 2))
    }
  }
}

async function applyShortPijamaAttributesToItem(token, rec, publishKey, results, logLines) {
  const item = await api('GET', `/items/${rec.mlItemId}?include_attributes=all`, { token })
  if (item.status === 'closed') {
    logLines.push(`SKIP ${rec.mlItemId} ${publishKey} — anúncio fechado`)
    console.log('pulando — fechado')
    return 'skipped'
  }
  if (shortPijamaAttributesOk(item.attributes)) {
    logLines.push(`OK ${rec.mlItemId} ${publishKey} — já aplicado`)
    console.log('já OK')
    return 'already'
  }
  const attrs = buildShortPijamaAttributePayload(item.attributes)
  await api('PUT', `/items/${rec.mlItemId}`, { token, body: { attributes: attrs } })
  rec.shortPijamaAttrsApplied = { at: new Date().toISOString() }
  results.published[publishKey] = rec
  await saveResults(results)
  logLines.push(`OK ${rec.mlItemId} ${publishKey}`)
  console.log('OK pijama attrs')
  return 'applied'
}

async function cmdApplyAttributes({ family, sample, onlyId }) {
  const { accessToken: token } = await loadToken()
  const results = await loadResults()

  let entries = Object.entries(results.published).filter(
    ([, rec]) => rec.mlItemId && !rec.error,
  )
  if (sample) entries = entries.filter(([, rec]) => SAMPLE_KEEP_IDS.has(rec.mlItemId))
  if (family && family !== 'ALL') entries = entries.filter(([, rec]) => rec.family === family)
  if (onlyId) entries = entries.filter(([, rec]) => rec.mlItemId === onlyId)

  const shortEntries = entries.filter(([, rec]) => rec.family === 'SHORT')
  const colorEntries = entries.filter(([, rec]) => rec.family !== 'SHORT')
  const runAt = new Date().toISOString()
  const shortLogLines = [`# apply-attributes SHORT pijama ${runAt} family=${family || 'ALL'} count=${shortEntries.length}`]
  let shortApplied = 0
  let shortAlready = 0
  let shortSkipped = 0
  let shortFailed = 0

  if (shortEntries.length) {
    console.log(`Aplicando atributos pijama SHORT em ${shortEntries.length} anúncios…`)
    for (const [publishKey, rec] of shortEntries) {
      process.stdout.write(`\n[${publishKey}] ${rec.mlItemId} (SHORT, ${rec.categoryId || PIJAMAS_CATEGORY})… `)
      try {
        const outcome = await applyShortPijamaAttributesToItem(token, rec, publishKey, results, shortLogLines)
        if (outcome === 'applied') shortApplied++
        else if (outcome === 'already') shortAlready++
        else if (outcome === 'skipped') shortSkipped++
      } catch (err) {
        shortFailed++
        const msg = errSummary(err)
        shortLogLines.push(`FAIL ${rec.mlItemId} ${publishKey} — ${msg}`)
        console.log('FALHOU')
        console.error(msg)
      }
    }
    shortLogLines.push(
      `# resumo applied=${shortApplied} already=${shortAlready} skipped=${shortSkipped} failed=${shortFailed}`,
    )
    await appendShortAttributesLog(shortLogLines.join('\n'))
    console.log(
      `\nSHORT: ${shortApplied} aplicados, ${shortAlready} já OK, ${shortSkipped} fechados, ${shortFailed} falhas`,
    )
    console.log(`Log: ${SHORT_ATTRIBUTES_LOG_FILE}`)
  }

  if (!colorEntries.length) return

  console.log(`\nAplicando COR em ${colorEntries.length} anúncios…`)

  for (const [publishKey, rec] of colorEntries) {
    const colorCfg = colorConfig(rec.categoryId, rec.colorMode || 'variation', rec.family)
    process.stdout.write(`\n[${publishKey}] ${rec.mlItemId} (${rec.family}, ${rec.categoryId})… `)
    try {
      const item = await api('GET', `/items/${rec.mlItemId}?include_attributes=all`, { token })
      const currentItemColor = itemColorName(item)
      const currentVarColor = variationColorName(item.variations?.[0])
      // ML erro 146: COR só pode estar em item OU variação — aceita qualquer um com Personalizado
      const alreadyOk =
        (currentVarColor === colorCfg.value && !currentItemColor) ||
        (currentItemColor === colorCfg.value && !currentVarColor)
      if (alreadyOk) {
        console.log('já OK')
        continue
      }
      if (currentItemColor && currentVarColor) {
        console.log('pulando — COR duplicada item+variação (ajuste manual)')
        continue
      }

      // Padrão novo: COR nas variações (só se item ainda não tem COR — evita erro 146)
      if (!currentItemColor) {
        const variations = item.variations.map((v) => {
          const sizeName =
            variationSizeKey(v) || v.attribute_combinations?.find((a) => a.id === 'SIZE')?.value_name
          const varAttrs = (v.attributes || [])
            .filter((a) => ['SIZE_GRID_ROW_ID', 'SELLER_SKU'].includes(a.id))
            .map((a) => ({ id: a.id, value_name: a.value_name }))
          return {
            id: v.id,
            attribute_combinations: buildVariationCombinations(sizeName, colorCfg),
            attributes: varAttrs,
            price: v.price,
            available_quantity: v.available_quantity,
            picture_ids: v.picture_ids,
          }
        })
        await api('PUT', `/items/${rec.mlItemId}`, { token, body: { variations } })
        const ship = await ensureFreeShipping(token, rec.mlItemId)
        rec.colorApplied = { mode: 'variation', value: colorCfg.value, at: new Date().toISOString() }
        if (ship.changed) rec.freeShippingApplied = { ...ship, at: new Date().toISOString() }
        results.published[publishKey] = rec
        await saveResults(results)
        console.log(`OK variação COLOR → ${colorCfg.value}`)
        continue
      }

      // Legado camisola: COR só no item — não dá pra migrar pra variação em anúncio existente
      console.log(`pulando — item já tem COR "${currentItemColor}" (ML não permite item+variação)`)
    } catch (err) {
      console.log('FALHOU')
      console.error(errSummary(err))
      console.error('  → Se persistir, ajuste manual no painel ML ou republicação.')
    }
  }
}

function itemGenderName(item) {
  return item.attributes?.find((a) => a.id === 'GENDER')?.value_name || null
}

/** Scan/corrige SHORT femininos publicados com GENDER=Masculino (registry ou ML). */
async function cmdFixGenderShort({ scan, sample, onlyId, apply }) {
  await loadFamilyMap()
  const familyDef = FAMILY_MAP.SHORT
  const results = await loadResults()
  const catalog = await loadCatalog()
  const byShopeeId = new Map(catalog.map((p) => [p.shopeeId, p]))

  let token = null
  const auth = await tryLoadToken()
  if (auth) token = auth.accessToken
  else if (apply) die('Token ML necessário para corrigir. Renove OAuth ou defina ML_APP_ID + ML_CLIENT_SECRET')
  else console.warn('Token ML indisponível — scan só via registry')

  let entries = Object.entries(results.published).filter(
    ([, rec]) => rec.mlItemId && !rec.error && rec.family === 'SHORT',
  )
  if (sample) entries = entries.filter(([, rec]) => SAMPLE_KEEP_IDS.has(rec.mlItemId))
  if (onlyId) entries = entries.filter(([, rec]) => rec.mlItemId === onlyId)

  const runAt = new Date().toISOString()
  const logLines = [`# fix-gender-short ${runAt} scan=${scan} apply=${apply} token=${token ? 'ok' : 'missing'}`]
  const affected = []
  let fixed = 0
  let mlChecked = 0

  console.log(`${scan ? 'Escaneando' : apply ? 'Corrigindo' : 'Analisando'} ${entries.length} SHORT…`)

  for (const [publishKey, rec] of entries) {
    const shopeeId = rec.shopeeId || publishKey.split('#')[0]
    const catalogProduct = byShopeeId.get(shopeeId)
    const product = catalogProduct || {
      shopeeId,
      title: rec.shopeeTitle || rec.title || '',
      description: '',
      variations: [],
    }

    const expectedGender = detectProductGender(product)
    if (expectedGender !== 'F') continue

    let mlGender = null
    let mlTitle = rec.title
    if (token) {
      try {
        const item = await api('GET', `/items/${rec.mlItemId}?include_attributes=all`, { token })
        mlChecked++
        mlGender = itemGenderName(item)
        mlTitle = item.title || rec.title
      } catch (err) {
        logLines.push(`ERR ${rec.mlItemId} GET — ${errSummary(err)}`)
      }
    }

    const registryWrong = rec.genderKey === 'M'
    const mlWrong = mlGender === 'Masculino'
    if (!registryWrong && !mlWrong) continue

    const familyCfg = familyCfgFromDef(familyDef, 'F')
    const newTitle = titleForListing(product.title, familyCfg.gender, 'F')
    affected.push({
      mlItemId: rec.mlItemId,
      shopeeId,
      shopeeTitle: product.title,
      registryGender: rec.genderKey,
      mlGender,
      mlTitle,
      newTitle,
      chartId: familyCfg.chartId,
    })
    logLines.push(
      `AFFECTED ${rec.mlItemId} shopee=${shopeeId} registry=${rec.genderKey} ml=${mlGender} title="${mlTitle?.slice(0, 50)}" → "${newTitle?.slice(0, 50)}"`,
    )

    if (apply && !scan) {
      process.stdout.write(`\n[${rec.mlItemId}] ${shopeeId}… `)
      try {
        const item = await api('GET', `/items/${rec.mlItemId}?include_attributes=all`, { token })
        const colorCfg = colorConfig(rec.categoryId, rec.colorMode || 'variation')
        const jobVars = catalogProduct
          ? prepareVariations(product, familyDef)
          : item.variations.map((v) => ({
              mlSizeName: variationSizeKey(v),
              name: v.attribute_combinations?.find((a) => a.id === 'SIZE')?.value_name,
            }))
        const skuBySize = new Map(
          jobVars.map((v) => [
            v.mlSizeName,
            buildVariationSku(itemReferenceSku(product), v.name, v.modelSku),
          ]),
        )
        const attrs = (item.attributes || [])
          .filter((a) => !['GENDER', 'SIZE_GRID_ID'].includes(a.id))
          .map((a) => ({
            id: a.id,
            ...(a.value_id ? { value_id: a.value_id } : {}),
            ...(a.value_name ? { value_name: a.value_name } : {}),
          }))
        attrs.push(
          { id: 'GENDER', value_id: GENDER.FEM.id, value_name: GENDER.FEM.name },
          { id: 'SIZE_GRID_ID', value_name: familyCfg.chartId },
        )
        const variations = item.variations.map((v) => {
          const sizeKey = variationSizeKey(v)
          const rowId = familyCfg.rowBySize[sizeKey]
          const varAttrs = (v.attributes || [])
            .filter((a) => a.id === 'SELLER_SKU')
            .map((a) => ({ id: a.id, value_name: a.value_name }))
          if (rowId) varAttrs.unshift({ id: 'SIZE_GRID_ROW_ID', value_name: rowId })
          const sellerSku = skuBySize.get(sizeKey)
          if (sellerSku) varAttrs.push({ id: 'SELLER_SKU', value_name: sellerSku })
          return {
            id: v.id,
            attribute_combinations: v.attribute_combinations,
            attributes: varAttrs,
            price: v.price,
            available_quantity: v.available_quantity,
            picture_ids: v.picture_ids,
          }
        })
        await api('PUT', `/items/${rec.mlItemId}`, {
          token,
          body: { title: newTitle, attributes: attrs, variations },
        })
        rec.genderFixed = {
          fromRegistry: registryWrong ? 'M' : rec.genderKey,
          fromMl: mlGender,
          chartId: familyCfg.chartId,
          at: new Date().toISOString(),
        }
        rec.genderKey = 'F'
        rec.title = newTitle
        results.published[publishKey] = rec
        await saveResults(results)
        fixed++
        logLines.push(`FIXED ${rec.mlItemId} GENDER Feminino chart=${familyCfg.chartId}`)
        console.log('OK')
      } catch (err) {
        logLines.push(`FAIL ${rec.mlItemId} — ${errSummary(err)}`)
        console.log('FALHOU')
        console.error(errSummary(err))
      }
    }
  }

  logLines.push(`# total affected=${affected.length} fixed=${fixed} mlChecked=${mlChecked}`)
  await writeFile(GENDER_FIX_SHORT_LOG_FILE, `${logLines.join('\n')}\n`)

  console.log(`\n--- Resumo ---`)
  console.log(`Afetados: ${affected.length}`)
  console.log(`Corrigidos: ${fixed}`)
  console.log(`ML verificados: ${mlChecked}`)
  if (affected.length) {
    console.log(`\nMLB ids:`)
    for (const a of affected) console.log(`  ${a.mlItemId} (${a.shopeeId}) registry=${a.registryGender} ml=${a.mlGender}`)
  }
  console.log(`\nLog: ${GENDER_FIX_SHORT_LOG_FILE}`)
  return { affected, fixed }
}

async function cmdApplyPictures({ family, sample, onlyId }) {
  const { accessToken: token } = await loadToken()
  const results = await loadResults()
  const catalog = await loadCatalog()
  const catalogList = catalog

  let entries = Object.entries(results.published).filter(
    ([, rec]) => rec.mlItemId && !rec.error,
  )
  if (sample) entries = entries.filter(([, rec]) => SAMPLE_KEEP_IDS.has(rec.mlItemId))
  if (family && family !== 'ALL') entries = entries.filter(([, rec]) => rec.family === family)
  if (onlyId) entries = entries.filter(([, rec]) => rec.mlItemId === onlyId)

  const byShopeeId = new Map(catalogList.map((p) => [p.shopeeId, p]))
  const runAt = new Date().toISOString()
  await writeFile(FIX_PICTURES_LOG_FILE, `# apply-pictures ${runAt} — ${entries.length} alvos\n`)

  console.log(`Aplicando fotos em ${entries.length} anúncios…`)

  for (const [publishKey, rec] of entries) {
    const shopeeId = rec.shopeeId || publishKey.split('#')[0]
    const product = byShopeeId.get(shopeeId)
    const targetImages = product ? imagesForPublishJob(product) : []
    const shopeeImageCount = targetImages.length

    process.stdout.write(`\n[${publishKey}] ${rec.mlItemId}… `)
    try {
      const item = await api('GET', `/items/${rec.mlItemId}`, { token })
      const beforeItemCount = item.pictures?.length ?? 0
      const beforeVarCount = item.variations?.[0]?.picture_ids?.length ?? beforeItemCount

      let pictureIds = []
      let uploaded = 0
      const forceReplace = false

      if (targetImages.length) {
        const targetCount = Math.min(targetImages.length, 10)
        if (forceReplace) {
          pictureIds = await uploadPictures(token, targetImages, {
            onError: (url, err) => {
              console.warn(`\n  upload falhou ${url.slice(0, 60)}… — ${errSummary(err)}`)
            },
          })
          uploaded = pictureIds.length
          pictureIds = pictureIds.slice(0, targetCount)
        } else {
          pictureIds = (item.pictures || []).map((p) => p.id).filter(Boolean)
          if (pictureIds.length < targetCount) {
            const existingUrls = new Set(
              (item.pictures || []).map((p) => p.secure_url || p.url).filter(Boolean),
            )
            const toUpload = targetImages
              .slice(0, 10)
              .filter((url) => !existingUrls.has(url))
            const newIds = await uploadPictures(token, toUpload, {
              onError: (url, err) => {
                console.warn(`\n  upload falhou ${url.slice(0, 60)}… — ${errSummary(err)}`)
              },
            })
            uploaded = newIds.length
            pictureIds = [...pictureIds, ...newIds].slice(0, 10)
          } else {
            pictureIds = pictureIds.slice(0, targetCount)
          }
        }
      } else {
        pictureIds = (item.pictures || []).map((p) => p.id).filter(Boolean)
      }

      const allVarHaveAll =
        item.variations?.length &&
        item.variations.every(
          (v) =>
            v.picture_ids?.length === pictureIds.length &&
            pictureIds.every((id) => v.picture_ids.includes(id)),
        )
      const itemPicturesOk =
        pictureIds.length === beforeItemCount &&
        pictureIds.every((id, i) => item.pictures[i]?.id === id)

      if (allVarHaveAll && itemPicturesOk && uploaded === 0 && !forceReplace) {
        const line = `SKIP ${rec.mlItemId} ${publishKey} before=${beforeVarCount} after=${beforeVarCount} shopee=${shopeeImageCount}`
        await appendFixPicturesLog(line)
        console.log(`já OK (${beforeVarCount} fotos visíveis)`)
        continue
      }

      const body = {}
      if (!itemPicturesOk || uploaded > 0) {
        body.pictures = pictureIds.map((id) => ({ id }))
      }

      if (item.variations?.length) {
        body.variations = item.variations.map((v) => ({
          id: v.id,
          picture_ids: pictureIds,
        }))
      }

      await api('PUT', `/items/${rec.mlItemId}`, { token, body })

      const ship = await ensureFreeShipping(token, rec.mlItemId)
      if (ship.changed) {
        rec.freeShippingApplied = { ...ship, at: new Date().toISOString() }
      }

      const verified = await api('GET', `/items/${rec.mlItemId}`, { token })
      const afterItemCount = verified.pictures?.length ?? 0
      const afterVarCount = verified.variations?.[0]?.picture_ids?.length ?? afterItemCount

      rec.picturesApplied = {
        beforeItem: beforeItemCount,
        beforeVar: beforeVarCount,
        afterItem: afterItemCount,
        afterVar: afterVarCount,
        shopeeImages: shopeeImageCount,
        imageSourceShopeeId: shopeeId,
        uploaded,
        forceReplace,
        at: new Date().toISOString(),
      }
      results.published[publishKey] = rec
      await saveResults(results)

      const line = `OK ${rec.mlItemId} ${publishKey} before=${beforeVarCount} after=${afterVarCount} item=${afterItemCount} shopee=${shopeeImageCount} uploaded=${uploaded}`
      await appendFixPicturesLog(line)
      console.log(`OK var ${beforeVarCount}→${afterVarCount}, item ${afterItemCount} (Shopee ${shopeeImageCount})`)
    } catch (err) {
      const line = `FAIL ${rec.mlItemId} ${publishKey} — ${errSummary(err)}`
      await appendFixPicturesLog(line)
      console.log('FALHOU')
      console.error(errSummary(err))
    }
  }

  console.log(`\nLog: ${FIX_PICTURES_LOG_FILE}`)
}

async function cmdApplyListingConfig({ family, sample, onlyId }) {
  const { accessToken: token } = await loadToken()
  const results = await loadResults()

  let entries = Object.entries(results.published).filter(
    ([, rec]) => rec.mlItemId && !rec.error,
  )
  if (sample) entries = entries.filter(([, rec]) => SAMPLE_KEEP_IDS.has(rec.mlItemId))
  if (family && family !== 'ALL') entries = entries.filter(([, rec]) => rec.family === family)
  if (onlyId) entries = entries.filter(([, rec]) => rec.mlItemId === onlyId)

  console.log(`Aplicando tipo de anúncio + frete em ${entries.length} anúncios…`)
  const runAt = new Date().toISOString()
  const bulkLog = family === 'ALL' && !sample && !onlyId
  const logFile = bulkLog ? FREE_SHIPPING_BULK_LOG_FILE : FREE_SHIPPING_LOG_FILE
  const { appendFile } = await import('node:fs/promises')
  const header = `# apply-listing-config ${runAt} — ${entries.length} alvos\n`
  if (bulkLog) await appendFile(logFile, header)
  else await writeFile(logFile, header)

  for (const [publishKey, rec] of entries) {
    const fam = rec.family
    const { listingTypeId, freeShipping } = listingConfig(fam)
    process.stdout.write(`\n[${publishKey}] ${rec.mlItemId} (${fam}) → ${listingTypeId}… `)
    try {
      let item = await api('GET', `/items/${rec.mlItemId}`, { token })
      const prev = {
        listingTypeId: item.listing_type_id,
        freeShipping: item.shipping?.free_shipping ?? false,
      }

      if (item.listing_type_id !== listingTypeId) {
        if (listingTypeId === LISTING_PREMIUM && item.listing_type_id === LISTING_CLASSIC) {
          item = await api('POST', `/items/${rec.mlItemId}/listing_type`, {
            token,
            body: { id: listingTypeId },
          })
        } else {
          throw new Error(
            `Tipo atual ${item.listing_type_id} → alvo ${listingTypeId} não suportado via API`,
          )
        }
      }

      const ship = freeShipping ? await ensureFreeShipping(token, rec.mlItemId) : null

      const verified = await api('GET', `/items/${rec.mlItemId}`, { token })
      rec.listingConfig = {
        listingTypeId: verified.listing_type_id,
        freeShipping: verified.shipping?.free_shipping ?? false,
        previousListingTypeId: prev.listingTypeId,
        previousFreeShipping: prev.freeShipping,
        at: new Date().toISOString(),
      }
      results.published[publishKey] = rec
      await saveResults(results)
      const logLine = ship?.changed
        ? `FIX ${rec.mlItemId} ${publishKey} ${fam} frete ${prev.freeShipping}→${verified.shipping?.free_shipping}`
        : `OK ${rec.mlItemId} ${publishKey} ${fam} frete=${verified.shipping?.free_shipping}`
      await appendFreeShippingLog(logLine, bulkLog)
      console.log(
        `OK ${prev.listingTypeId}→${verified.listing_type_id}, frete ${prev.freeShipping}→${verified.shipping?.free_shipping}`,
      )
    } catch (err) {
      console.log('FALHOU')
      console.error(JSON.stringify(err.response || err.message, null, 2))
      await appendFreeShippingLog(`FAIL ${rec.mlItemId} ${publishKey} ${fam} — ${errSummary(err)}`, bulkLog)
    }
  }
  console.log(`\nLog: ${logFile}`)
}

async function loadResults() {
  try {
    return JSON.parse(await readFile(RESULTS_FILE, 'utf8'))
  } catch {
    return { published: {} }
  }
}

async function saveResults(data) {
  await mkdir(path.dirname(RESULTS_FILE), { recursive: true })
  await writeFile(RESULTS_FILE, JSON.stringify(data, null, 2))
}

async function cmdScanFPhotos() {
  console.log('scan-f-photos obsoleto: SHORT/CONJUNTO UNITARIO publicam 1:1 por shopeeId (sem #M/#F).')
  console.log('Use: node scripts/shopee-to-ml-import.mjs preview-publish --family ALL\n')
  await cmdPreviewPublish({ family: 'ALL' })
}

async function cmdPreviewPublish({ family, onlyId }) {
  await loadFamilyMap()
  const catalog = await loadCatalog()
  const runAt = new Date().toISOString()
  const families = family === 'ALL' ? PUBLISH_FAMILIES : [family]
  /** @type {Record<string, number>} */
  const byFamily = {}
  let totalJobs = 0
  let skippedNoVars = 0
  const lines = [`# preview-publish 1:1 sem splitGender ${runAt}`]

  for (const fam of families) {
    const familyDef = FAMILY_MAP[fam]
    if (!familyDef) continue
    byFamily[fam] = 0
    for (const product of catalog.filter((p) => p.sku === fam)) {
      if (onlyId && product.shopeeId !== onlyId) continue
      const jobs = expandPublishJobs(product, fam, familyDef)
      if (!jobs.length) {
        skippedNoVars++
        lines.push(`SKIP ${product.shopeeId} ${fam} — sem variações após filtro de gênero`)
        continue
      }
      for (const job of jobs) {
        byFamily[fam]++
        totalJobs++
        const sizes = job.product.variations.map((v) => v.mlSizeName).join(',')
        lines.push(
          `${job.publishKey} ${fam} gender=${job.genderKey} vars=[${sizes}] imgs=${product.images.length} "${product.title.slice(0, 55)}"`,
        )
      }
    }
  }

  lines.push(`# Total jobs: ${totalJobs} (sem vars: ${skippedNoVars})`)
  lines.push(`# Por família: ${JSON.stringify(byFamily)}`)

  const examples = ['57908808367', '53858902614', '57509330784', '57059330897']
  for (const id of examples) {
    const product = catalog.find((p) => p.shopeeId === id)
    if (!product) {
      lines.push(`# EX ${id}: não encontrado no catálogo`)
      continue
    }
    const jobs = expandPublishJobs(product, product.sku, FAMILY_MAP[product.sku])
    const job = jobs[0]
    if (!job) {
      lines.push(`# EX ${id}: sem job (${product.sku})`)
      continue
    }
    lines.push(
      `# EX ${id}: publishKey=${job.publishKey} gender=${job.genderKey} sizes=${job.product.variations.map((v) => v.name).join(' | ')} imgs=${product.images.length}`,
    )
  }

  await appendNoSplitGenderLog(`${lines.join('\n')}\n`)
  console.log(JSON.stringify({ totalJobs, byFamily, skippedNoVars }, null, 2))
  for (const id of examples) {
    const product = catalog.find((p) => p.shopeeId === id)
    if (!product) continue
    const jobs = expandPublishJobs(product, product.sku, FAMILY_MAP[product.sku])
    console.log(
      `\nExemplo ${id}:`,
      JSON.stringify(
        jobs[0]
          ? {
              publishKey: jobs[0].publishKey,
              gender: jobs[0].genderKey,
              mlGender: jobs[0].familyCfg.gender.name,
              sizes: jobs[0].product.variations.map((v) => v.name),
              images: product.images.length,
              title: product.title.slice(0, 60),
            }
          : { error: 'sem job' },
        null,
        2,
      ),
    )
  }
  console.log(`\nLog: ${NO_SPLIT_GENDER_LOG_FILE}`)
}

async function cmdParse() {
  const products = await loadCatalog()
  const bySku = {}
  for (const p of products) {
    bySku[p.sku] = (bySku[p.sku] || 0) + 1
  }
  console.log(JSON.stringify({ total: products.length, bySku }, null, 2))
}

function interleaveJobs(jobs, families) {
  const byFam = new Map(families.map((f) => [f, []]))
  for (const j of jobs) {
    if (!byFam.has(j.family)) byFam.set(j.family, [])
    byFam.get(j.family).push(j)
  }
  const out = []
  let more = true
  while (more) {
    more = false
    for (const f of families) {
      const q = byFam.get(f)
      if (q?.length) {
        out.push(q.shift())
        more = true
      }
    }
  }
  return out
}

/** Índice shopeeId → registro publicado (qualquer publishKey). */
function indexPublishedByShopee(results) {
  const byShopee = new Map()
  for (const [key, rec] of Object.entries(results.published || {})) {
    if (!rec.mlItemId) continue
    const sid = rec.shopeeId || key.split('#')[0]
    const prev = byShopee.get(sid)
    if (!prev || (rec.at && (!prev.at || rec.at > prev.at))) byShopee.set(sid, { key, ...rec })
  }
  return byShopee
}

function findRegistryRecord(results, job) {
  const direct = results.published[job.publishKey]
  if (direct?.mlItemId) return direct
  return indexPublishedByShopee(results).get(job.shopeeId) || null
}

async function isMlItemActive(token, mlItemId) {
  try {
    const item = await api('GET', `/items/${mlItemId}`, { token })
    return item.status === 'active'
  } catch (err) {
    if (err.status === 404) return false
    throw err
  }
}

async function cmdPublish({ limit, family, skipIds, onlyId, sample, force, colorMode, gender, delayMs }) {
  if (process.env.ML_PUBLISH !== '1') {
    die('Publicação bloqueada. Use ML_PUBLISH=1 para confirmar.')
  }
  const releaseLock = await acquirePublishLock()
  try {
  if (gender && gender !== 'M' && gender !== 'F') die('--gender deve ser M ou F')
  await loadFamilyMap()

  const families = family === 'ALL' ? PUBLISH_FAMILIES : [family]
  for (const fam of families) {
    if (!FAMILY_MAP[fam]) die(`Família não mapeada: ${fam}. Disponíveis: ${Object.keys(FAMILY_MAP).join(', ')}`)
  }

  const { accessToken: token } = await loadToken()
  const results = await loadResults()
  const catalog = await loadCatalog()

  const sampleIds = new Set()
  if (sample) {
    for (const fam of families) {
      const first = catalog.find((p) => p.sku === fam)
      if (first) sampleIds.add(first.shopeeId)
    }
  }

  const jobs = []
  const seenShopee = new Set()
  let skippedPublished = 0
  let skippedDupBatch = 0
  for (const fam of families) {
    const familyDef = FAMILY_MAP[fam]
    for (const product of catalog.filter((p) => p.sku === fam)) {
      if (sample && !sampleIds.has(product.shopeeId)) continue
      if (onlyId && product.shopeeId !== onlyId) continue
      for (const job of expandPublishJobs(product, fam, familyDef)) {
        if (colorMode === 'item') job.publishKey = `${job.publishKey}#item-color`
        if (gender && job.genderKey !== gender) continue
        if (skipIds.has(job.publishKey) || skipIds.has(job.shopeeId)) continue
        if (seenShopee.has(job.shopeeId)) {
          skippedDupBatch++
          continue
        }
        if (!force) {
          const existing = findRegistryRecord(results, job)
          if (existing?.mlItemId) {
            if (await isMlItemActive(token, existing.mlItemId)) {
              skippedPublished++
              continue
            }
          }
        }
        seenShopee.add(job.shopeeId)
        jobs.push({ ...job, colorMode })
      }
      if (sample) break
    }
  }

  const pending = interleaveJobs(jobs, families).slice(0, sample ? jobs.length : limit)
  const genderLabel = gender ? ` gender=${gender}` : ''
  if (families.includes('SHORT CUECA')) {
    const cuecaJobs = pending.filter((j) => j.family === 'SHORT CUECA')
    await appendShortCuecaLog(
      `# publish ${new Date().toISOString()} family=SHORT CUECA category=${BERMUDAS_CATEGORY} listing=gold_special price=shopee ensurePijamaTitle=false noManufacturingTime=true count=${cuecaJobs.length}`,
    )
    for (const j of cuecaJobs) {
      const prices = j.product.variations.map((v) => resolveVariationPrice(v, 'SHORT CUECA'))
      await appendShortCuecaLog(
        `PENDING shopee=${j.shopeeId} title="${j.product.title.slice(0, 80)}" prices=${JSON.stringify(prices)} sizes=${j.product.variations.map((v) => v.name).join(',')}`,
      )
    }
  }
  console.log(
    `Publicando ${pending.length} anúncios (${families.join(', ')}${genderLabel}) — ${jobs.length} pendentes no total` +
      (skippedPublished ? ` (${skippedPublished} já ativos no ML)` : '') +
      (skippedDupBatch ? ` (${skippedDupBatch} dup lote)` : '') +
      '…',
  )

  for (const job of pending) {
    const { product, familyCfg, publishKey, family: fam } = job
    process.stdout.write(`\n[${publishKey}] ${product.title.slice(0, 50)}… `)
    try {
      const targetImages = imagesForPublishJob(product)
      const pictureIds = await uploadPictures(token, targetImages)
      const item = buildItem(product, familyCfg, pictureIds, job.genderKey, fam, job.colorMode)
      const created = await api('POST', '/items', { token, body: item })
      const record = {
        mlItemId: created.id,
        permalink: created.permalink,
        title: created.title,
        shopeeTitle: product.title,
        categoryId: familyCfg.categoryId,
        family: fam,
        shopeeId: job.shopeeId,
        publishKey,
        genderKey: job.genderKey || null,
        colorMode: job.colorMode || 'variation',
        refSku: itemReferenceSku(product),
        variations: item.variations.length,
        imageSourceShopeeId: job.shopeeId,
        at: new Date().toISOString(),
      }
      results.published[publishKey] = record
      await saveResults(results)

      const ship = await ensureFreeShipping(token, created.id)
      if (ship.changed) {
        record.freeShippingApplied = { ...ship, at: new Date().toISOString() }
        await saveResults(results)
      }

      if (process.env.ML_SKIP_FISCAL !== '1') {
        try {
          const fiscal = await applyFiscalToItem(token, created.id)
          record.fiscal = {
            ...fiscal.fiscal,
            canInvoice: fiscal.canInvoice,
            variations: fiscal.variations,
            at: new Date().toISOString(),
          }
          await saveResults(results)
        } catch (fiscalErr) {
          record.fiscalError = fiscalErr instanceof Error ? fiscalErr.message : String(fiscalErr)
          await saveResults(results)
        }
      }

      const desc = sanitizeDescription(product.description)
      if (desc) {
        try {
          await api('POST', `/items/${created.id}/description`, {
            token,
            body: { plain_text: desc.slice(0, 50000) },
          })
        } catch (descErr) {
          record.descriptionError = descErr.response || descErr.message
          await saveResults(results)
          console.log(`OK → ${created.id} (sem descrição${record.fiscalError ? ', fiscal pendente' : ''})`)
          continue
        }
      }
      console.log(`OK → ${created.id}${record.fiscalError ? ' (fiscal pendente)' : ''}`)
      if (fam === 'SHORT CUECA') {
        const prices = item.variations.map((v) => v.price)
        await appendShortCuecaLog(
          `OK shopee=${job.shopeeId} ml=${created.id} permalink=${created.permalink} prices=${JSON.stringify(prices)} source=shopee`,
        )
      }
    } catch (err) {
      console.log('FALHOU')
      if (fam === 'SHORT CUECA') {
        await appendShortCuecaLog(
          `FAIL shopee=${job.shopeeId} error=${JSON.stringify(err.response || err.message)}`,
        )
      }
      console.error(JSON.stringify(err.response || err.message, null, 2))
      results.published[publishKey] = {
        error: err.response || err.message,
        family: fam,
        shopeeId: job.shopeeId,
        at: new Date().toISOString(),
      }
      await saveResults(results)
    }
    if (delayMs > 0) await sleep(delayMs)
  }

  const ok = Object.values(results.published).filter((r) => r.mlItemId).length
  console.log(`\nTotal publicados no registro: ${ok}`)
  } finally {
    await releaseLock()
  }
}

async function listSellerItemIds(token, userId, { status } = {}) {
  const ids = new Set()
  let scrollId = null
  for (;;) {
    const qs = new URLSearchParams({ search_type: 'scan' })
    if (status) qs.set('status', status)
    if (scrollId) qs.set('scroll_id', scrollId)
    const page = await api('GET', `/users/${userId}/items/search?${qs}`, { token })
    for (const id of page.results || []) ids.add(id)
    scrollId = page.scroll_id
    if (!scrollId || !page.results?.length) break
  }
  return ids
}

function itemIsDeleted(item) {
  return (item.sub_status || []).includes('deleted')
}

/** inactive e under_review+forbidden não aceitam status:closed — só PUT deleted. */
function canDeleteDirect(item) {
  const status = item.status
  const subStatus = item.sub_status || []
  if (status === 'closed' || status === 'inactive') return true
  if (status === 'under_review' && subStatus.includes('forbidden')) return true
  return false
}

async function deleteMlItem(token, itemId, { delayMs = 350 } = {}) {
  let item
  try {
    item = await api('GET', `/items/${itemId}`, { token })
  } catch (err) {
    if (err.status === 404) return { ok: true, action: 'already_gone' }
    throw err
  }

  const status = item.status
  const subStatus = item.sub_status || []

  if (itemIsDeleted(item)) {
    return { ok: true, action: 'already_deleted', status, subStatus }
  }

  let closedFirst = false
  if (!canDeleteDirect(item) && status !== 'under_review') {
    try {
      await api('PUT', `/items/${itemId}`, { token, body: { status: 'closed' } })
      closedFirst = true
      await sleep(Math.max(delayMs, 800))
    } catch (err) {
      if (err.status !== 400) throw err
      // ex.: inactive waiting_for_patch — status não modificável; tenta deleted direto
    }
  }

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await api('PUT', `/items/${itemId}`, { token, body: { deleted: 'true' } })
      await sleep(Math.max(400, delayMs / 2))
      const check = await api('GET', `/items/${itemId}`, { token })
      if (!itemIsDeleted(check)) {
        throw new Error(`sub_status sem deleted após PUT (${check.status}: ${(check.sub_status || []).join(',')})`)
      }
      const action = closedFirst ? 'closed_and_deleted' : 'deleted'
      return { ok: true, action, status: check.status, subStatus: check.sub_status }
    } catch (err) {
      if (err.status === 409 || err.message?.includes('sub_status sem deleted')) {
        await sleep(1500 + attempt * 500)
        continue
      }
      if (err.status === 429) {
        await sleep(3000 + attempt * 1000)
        continue
      }
      throw err
    }
  }
  throw new Error('DELETE falhou após retentativas (409/429/verificação)')
}

async function cmdDelete({ keepIds, scanSeller, delayMs, onlyId }) {
  if (process.env.ML_DELETE !== '1') {
    die('Exclusão permanente bloqueada. Use ML_DELETE=1 para confirmar.')
  }
  const { accessToken: token, userId } = await loadToken()
  const results = await loadResults()
  const keep = new Set(keepIds)

  const fromRegistry = new Set()
  for (const rec of Object.values(results.published)) {
    if (rec.mlItemId) fromRegistry.add(rec.mlItemId)
  }

  const toDelete = new Set()
  for (const id of fromRegistry) {
    if (!keep.has(id)) toDelete.add(id)
  }

  if (scanSeller) {
    console.log(`Varrendo anúncios do vendedor ${userId} via API…`)
    const all = await listSellerItemIds(token, userId, {})
    console.log(`  todos (sem filtro status): ${all.size}`)
    for (const id of all) {
      if (!keep.has(id)) toDelete.add(id)
    }
  }

  if (onlyId) {
    toDelete.clear()
    if (!keep.has(onlyId)) toDelete.add(onlyId)
    else die(`--only ${onlyId} está na lista de preservação`)
  }

  const ids = [...toDelete].sort()
  console.log(
    `Excluindo permanentemente ${ids.length} anúncios (preservando ${keep.size} IDs de teste)…`,
  )
  await writeFile(
    DELETE_LOG_FILE,
    `# delete run ${new Date().toISOString()} — ${ids.length} alvos\n`,
  )

  let deleted = 0
  let failed = 0
  /** @type {Record<string, string[]>} */
  const failuresByReason = {}

  for (const itemId of ids) {
    process.stdout.write(`\n[${itemId}]… `)
    try {
      const result = await deleteMlItem(token, itemId, { delayMs })
      deleted++
      console.log(`OK (${result.action})`)
      await appendDeleteLog(`OK ${itemId} ${result.action}`)
    } catch (err) {
      failed++
      const reason = errSummary(err)
      failuresByReason[reason] = failuresByReason[reason] || []
      failuresByReason[reason].push(itemId)
      console.log(`FALHOU — ${reason}`)
      await appendDeleteLog(`FAIL ${itemId} ${reason}`)
      if (err.status === 401) die('Token inválido — renove OAuth antes de continuar.')
    }
    await sleep(delayMs)
  }

  const next = { published: {} }
  for (const [key, rec] of Object.entries(results.published)) {
    if (rec.mlItemId && keep.has(rec.mlItemId)) next.published[key] = rec
  }
  await saveResults(next)

  console.log(`\n--- Resumo exclusão ---`)
  console.log(`Excluídos: ${deleted}`)
  console.log(`Falhas: ${failed}`)
  console.log(`Registro: ${Object.keys(next.published).length} entradas mantidas`)
  if (failed) {
    console.log('\nFalhas por motivo:')
    for (const [reason, list] of Object.entries(failuresByReason)) {
      console.log(`  ${reason}: ${list.length}`)
      if (list.length <= 8) console.log(`    ${list.join(', ')}`)
    }
  }
  console.log(`Log: ${DELETE_LOG_FILE}`)
}

async function cmdCleanup({ keepFamily, deletePermanently, keepIds, scanSeller, delayMs, onlyId }) {
  if (deletePermanently) {
    return cmdDelete({ keepIds, scanSeller, delayMs, onlyId })
  }
  if (process.env.ML_CLEANUP !== '1') {
    die('Limpeza bloqueada. Use ML_CLEANUP=1 para confirmar.')
  }
  const { accessToken: token } = await loadToken()
  const results = await loadResults()
  const keep = keepFamily && keepFamily !== 'NONE' ? keepFamily : null
  const toClose = Object.entries(results.published).filter(
    ([, rec]) => rec.mlItemId && (!keep || rec.family !== keep),
  )
  console.log(`Fechando ${toClose.length} anúncios${keep ? ` (mantendo ${keep})` : ' (todos)'}…`)

  let closed = 0
  let failed = 0
  for (const [key, rec] of toClose) {
    process.stdout.write(`\n[${key}] ${rec.mlItemId}… `)
    try {
      await api('PUT', `/items/${rec.mlItemId}`, { token, body: { status: 'closed' } })
      closed++
      console.log('OK')
    } catch (err) {
      failed++
      console.log('FALHOU')
      console.error(JSON.stringify(err.response || err.message, null, 2))
      if (err.status === 401) die('Token inválido — renove OAuth antes de continuar.')
    }
  }

  const next = { published: {} }
  if (keep) {
    for (const [key, rec] of Object.entries(results.published)) {
      if (rec.family === keep) next.published[key] = rec
    }
  }
  await saveResults(next)
  console.log(`\nRegistro limpo: ${closed} fechados no ML, ${failed} falhas, ${Object.keys(next.published).length} mantidos.`)
}

async function main() {
  const args = parseArgs(process.argv)
  switch (args.cmd) {
    case 'parse':
      await cmdParse()
      break
    case 'scan-f-photos':
      await cmdScanFPhotos()
      break
    case 'preview-publish':
      if (!process.argv.includes('--family')) args.family = 'ALL'
      await cmdPreviewPublish(args)
      break
    case 'publish':
      await cmdPublish(args)
      break
    case 'apply-skus':
      await cmdApplySkus(args)
      break
    case 'apply-prices':
      if (!process.argv.includes('--family')) args.family = 'ALL'
      await cmdApplyPrices(args)
      break
    case 'apply-listing-config':
      if (!process.argv.includes('--family')) args.family = 'ALL'
      await cmdApplyListingConfig(args)
      break
    case 'fix-gender-short': {
      const scan = process.argv.includes('--scan')
      const apply = process.env.ML_GENDER_FIX === '1' && !scan
      if (!scan && !apply) {
        console.log('Modo análise (dry-run). Use --scan ou ML_GENDER_FIX=1 para corrigir.')
      }
      await cmdFixGenderShort({ ...args, scan, apply })
      break
    }
    case 'apply-attributes':
      if (!process.argv.includes('--family')) args.family = 'ALL'
      await cmdApplyAttributes(args)
      break
    case 'apply-pictures':
      if (!process.argv.includes('--family')) args.family = 'ALL'
      await cmdApplyPictures(args)
      break
    case 'delete':
      await cmdDelete(args)
      break
    case 'cleanup':
      await cmdCleanup(args)
      break
    default:
      console.log(
        'Comandos: parse | preview-publish [--family ALL] | scan-f-photos (obsoleto) | publish [--sample] [--force] --limit N --family ALL | apply-skus | apply-prices [--sample] [--family ALL] | apply-listing-config [--sample] [--family ALL] | apply-attributes [--sample] [--family ALL] | fix-gender-short [--scan] [--sample] [--only-id MLB...] | apply-pictures [--sample] [--family ALL] | cleanup [--delete] [--scan-seller] [--keep-id ID] | delete [--scan-seller] [--keep-id ID]',
      )
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
