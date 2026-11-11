#!/usr/bin/env node
/**
 * Guarda diária do catálogo Shopee.
 *
 * - Não republica os anúncios que já estavam desativados quando o arquivo
 *   /data/shopee-keep-unlisted.json foi criado.
 * - Republica um anúncio que estava no ar e saiu.
 * - Variante com estoque 0 volta para 20.000.
 * - Se essa variante não estiver na campanha das irmãs, entra com o mesmo
 *   preço promocional da irmã de mesmo preço original.
 * - NO_RESTOCK não é reposto nem republicado: quando acaba, fica acabado.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { ensureShopAuth, signShop, shopeeHost, assertShopeeOk, getItemList, getModelList, updateItemUnlist } from '/app/dist/shopee-api.js'
import { currentShopeeAccount } from '/app/dist/shopee-account.js'

const STOCK = 20_000
const KEEP_FILE = process.env.SHOPEE_KEEP_UNLISTED || '/data/shopee-keep-unlisted.json'
/** Fora da reposição automática. O cron não devolve estoque nem religa o anúncio. */
const NO_RESTOCK = new Set([
  44816396709, // cueca falsa, últimas unidades reais
  50115708214, // 12 Conjuntos com 13 rostos
])
const CONCURRENCY = 6

function log(entry) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...entry }))
}

async function shop(method, path, query = {}, body) {
  const auth = await ensureShopAuth()
  const account = currentShopeeAccount()
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signShop(path, timestamp, auth.accessToken, auth.shopId)
  const params = new URLSearchParams({
    partner_id: String(account.partnerId),
    timestamp: String(timestamp),
    sign,
    access_token: auth.accessToken,
    shop_id: String(auth.shopId),
  })
  for (const [key, value] of Object.entries(query)) params.set(key, String(value))
  const response = await fetch(`${shopeeHost()}${path}?${params}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  return response.json()
}

async function listIds(status) {
  const ids = []
  let offset = 0
  for (let guard = 0; guard < 30; guard++) {
    const body = assertShopeeOk(await getItemList({ offset, pageSize: 100, itemStatus: status }), 'get_item_list')
    ids.push(...(body.item || []).map((row) => row.item_id).filter((id) => typeof id === 'number'))
    if (!body.has_next_page) break
    offset = body.next_offset ?? offset + 100
  }
  return ids
}

async function loadKeep(currentUnlisted) {
  try {
    const saved = JSON.parse(await readFile(KEEP_FILE, 'utf8'))
    return new Set((saved.ids || []).filter((id) => typeof id === 'number'))
  } catch {
    const ids = [...currentUnlisted].sort((a, b) => a - b)
    await writeFile(KEEP_FILE, JSON.stringify({ createdAt: new Date().toISOString(), ids }, null, 2))
    log({ event: 'desativados.congelados', total: ids.length })
    return new Set(ids)
  }
}

async function mapPool(items, worker) {
  let cursor = 0
  async function run() {
    while (cursor < items.length) await worker(items[cursor++])
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, () => run()))
}

async function discountIndex() {
  const list = await shop('GET', '/api/v2/discount/get_discount_list', {
    discount_status: 'ongoing',
    page_no: 1,
    page_size: 100,
  })
  if (list.error) throw new Error(`get_discount_list: ${list.error} ${list.message || ''}`)
  const byItem = new Map()
  for (const discount of list.response?.discount_list || []) {
    for (let page = 1; page <= 40; page++) {
      const body = await shop('GET', '/api/v2/discount/get_discount', {
        discount_id: discount.discount_id,
        page_no: page,
        page_size: 50,
      })
      if (body.error) throw new Error(`get_discount ${discount.discount_id}: ${body.error}`)
      for (const item of body.response?.item_list || []) {
        const models = new Map()
        for (const model of item.model_list || []) {
          models.set(model.model_id, {
            original: model.model_original_price,
            promotion: model.model_promotion_price,
          })
        }
        byItem.set(item.item_id, { discountId: discount.discount_id, name: discount.discount_name, models })
      }
      if (!body.response?.more) break
    }
  }
  return byItem
}

function siblingPromotion(models, modelId, original) {
  const same = [...models.values()].filter((row) => row.original === original && row.promotion > 0)
  if (same.length) return same[0].promotion
  const any = [...models.values()].find((row) => row.promotion > 0)
  return any?.promotion ?? null
}

async function ensureDiscount(itemId, model, campaign) {
  if (!campaign) return { ok: false, action: 'sem_campanha' }
  if (campaign.models.has(model.model_id)) return { ok: true, action: 'ja_no_desconto' }
  const promotion = siblingPromotion(campaign.models, model.model_id, model.original)
  if (promotion == null) return { ok: false, action: 'sem_preco_irma' }
  const body = await shop('POST', '/api/v2/discount/add_discount_item', {}, {
    discount_id: campaign.discountId,
    item_list: [{
      item_id: itemId,
      purchase_limit: 0,
      model_list: [{ model_id: model.model_id, model_promotion_price: promotion }],
    }],
  })
  const failure = (body.response?.error_list || []).find((row) => row.item_id === itemId || row.model_id === model.model_id)
  if (body.error || failure) {
    return { ok: false, action: 'falha_desconto', error: body.message || failure?.fail_message || body.error }
  }
  return { ok: true, action: 'entrou_no_desconto', promotion, campaign: campaign.name }
}

async function refill(itemId, models) {
  const stockList = models.map((model) => ({
    model_id: model.model_id,
    seller_stock: [{ location_id: model.locationId || 'BRZ', stock: STOCK }],
  }))
  const body = await shop('POST', '/api/v2/product/update_stock', {}, { item_id: itemId, stock_list: stockList })
  const failures = body.response?.failure_list || []
  if (body.error || failures.length) {
    return { ok: false, error: body.message || body.error || JSON.stringify(failures).slice(0, 300) }
  }
  return { ok: true }
}

async function main() {
  const [normal, unlisted] = await Promise.all([listIds('NORMAL'), listIds('UNLIST')])
  const keep = await loadKeep(unlisted)
  const republish = []
  for (const itemId of unlisted) {
    if (keep.has(itemId) || NO_RESTOCK.has(itemId)) continue
    const data = await updateItemUnlist(itemId, false)
    const failure = (data.response?.failure_list || []).find((row) => row.item_id === itemId)
    const ok = !data.error && !failure
    republish.push({ itemId, ok, reason: failure?.failed_reason || data.message || '' })
    if (ok) normal.push(itemId)
  }

  let discounts = new Map()
  try {
    discounts = await discountIndex()
  } catch (error) {
    log({ event: 'descontos.indisponiveis', erro: error instanceof Error ? error.message : String(error) })
  }
  const refilled = []
  await mapPool([...new Set(normal)], async (itemId) => {
    if (NO_RESTOCK.has(itemId)) return
    const body = assertShopeeOk(await getModelList(itemId), 'get_model_list')
    const models = body.model || []
    const empty = (models.length ? models : [{ model_id: 0, price_info: [], stock_info_v2: body.stock_info_v2 }])
      .filter((model) => (model.stock_info_v2?.summary_info?.total_available_stock ?? 0) === 0)
      .map((model) => ({
        model_id: model.model_id,
        original: model.price_info?.[0]?.original_price ?? null,
        locationId: model.stock_info_v2?.seller_stock?.[0]?.location_id || 'BRZ',
      }))
    if (!empty.length) return
    const stock = await refill(itemId, empty)
    const campaign = discounts.get(itemId)
    const discount = []
    if (stock.ok) {
      for (const model of empty) discount.push({ modelId: model.model_id, ...(await ensureDiscount(itemId, model, campaign)) })
    }
    refilled.push({ itemId, models: empty.map((model) => model.model_id), stock, discount })
  })

  log({
    event: 'fim',
    publicados: normal.length,
    desativadosMantidos: [...keep].filter((id) => unlisted.includes(id)).length,
    republicados: republish.filter((row) => row.ok).length,
    republicacaoFalhou: republish.filter((row) => !row.ok),
    semReposicao: [...NO_RESTOCK],
    estoqueReposto: refilled.filter((row) => row.stock.ok).length,
    estoqueFalhou: refilled.filter((row) => !row.stock.ok),
    descontos: refilled.flatMap((row) => row.discount),
  })
}

main().catch((error) => {
  log({ event: 'falhou', erro: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
