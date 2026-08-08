import {
  assertShopeeOk,
  fetchAllItemIds,
  getItemBaseInfo,
  getModelList,
  type ShopeeApiResponse,
  updateItemDaysToShip,
  updateItemSku,
  updateItemUnlist,
  updateModelSkus,
} from './shopee-api.js'

export interface CatalogModel {
  modelId: number
  modelSku: string
  price: number | null
  stock: number | null
}

export interface CatalogProduct {
  itemId: number
  name: string
  imageUrl: string
  price: number | null
  stock: number | null
  sku: string
  hasModel: boolean
  models: CatalogModel[]
  status: string
  daysToShip: number | null
}

interface ItemBaseRow {
  item_id?: number
  item_name?: string
  item_sku?: string
  item_status?: string
  has_model?: boolean
  image?: { image_url_list?: string[]; image_url?: string }
  price_info?: Array<{ current_price?: number; original_price?: number }> | { current_price?: number }
  stock_info_v2?: { summary_info?: { total_available_stock?: number } }
  pre_order?: { is_pre_order?: boolean; days_to_ship?: number }
}

interface ModelRow {
  model_id?: number
  model_sku?: string
  stock_info_v2?: { summary_info?: { total_available_stock?: number } }
  price_info?: Array<{ current_price?: number }>
}

function readPrice(info: ItemBaseRow['price_info']): number | null {
  if (!info) return null
  if (Array.isArray(info)) return info[0]?.current_price ?? null
  return info.current_price ?? null
}

function formatStock(n: number | null | undefined): number | null {
  if (n == null || !Number.isFinite(n)) return null
  return n
}

function mapItemBaseFromRow(row: ItemBaseRow): CatalogProduct {
  const imageUrl = row.image?.image_url_list?.[0] ?? row.image?.image_url ?? ''
  return {
    itemId: row.item_id ?? 0,
    name: row.item_name ?? '',
    imageUrl,
    price: readPrice(row.price_info),
    stock: formatStock(row.stock_info_v2?.summary_info?.total_available_stock),
    sku: row.item_sku ?? '',
    hasModel: Boolean(row.has_model),
    models: [],
    status: row.item_status ?? '',
    daysToShip: row.pre_order?.days_to_ship ?? null,
  }
}

async function fetchModels(itemId: number): Promise<CatalogModel[]> {
  const data = await getModelList(itemId)
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_model_list') as {
    model?: ModelRow[]
  }
  const models: CatalogModel[] = []
  for (const m of body.model ?? []) {
    if (typeof m.model_id !== 'number') continue
    models.push({
      modelId: m.model_id,
      modelSku: m.model_sku ?? '',
      price: readPrice(m.price_info),
      stock: formatStock(m.stock_info_v2?.summary_info?.total_available_stock),
    })
  }
  return models
}

/** Roda `fn` sobre `items` com no máximo `limit` chamadas em paralelo. */
async function mapWithConcurrency<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const item = items[cursor++]
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()))
}

function parseItemList(data: ShopeeApiResponse): ItemBaseRow[] {
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_item_base_info') as {
    item_list?: ItemBaseRow[]
  }
  return body.item_list ?? []
}

/** Quantas chamadas get_model_list em paralelo — produtos com variação não têm preço no get_item_base_info. */
const MODEL_FETCH_CONCURRENCY = 10

export async function fetchProductCatalog(): Promise<CatalogProduct[]> {
  const itemIds = await fetchAllItemIds()
  const products: CatalogProduct[] = []

  for (let i = 0; i < itemIds.length; i += 50) {
    const batch = itemIds.slice(i, i + 50)
    const data = await getItemBaseInfo(batch)
    for (const row of parseItemList(data)) {
      if (!row.item_id) continue
      products.push(mapItemBaseFromRow(row))
    }
  }

  // Produto com variação não traz price_info/stock_info_v2 no get_item_base_info — só por
  // variante, via get_model_list. Preço exibido = menor entre as variantes; estoque = soma.
  const withModels = products.filter((p) => p.hasModel)
  await mapWithConcurrency(withModels, MODEL_FETCH_CONCURRENCY, async (product) => {
    try {
      const models = await fetchModels(product.itemId)
      const prices = models.map((m) => m.price).filter((v): v is number => v != null)
      const stocks = models.map((m) => m.stock).filter((v): v is number => v != null)
      product.price = prices.length ? Math.min(...prices) : null
      product.stock = stocks.length ? stocks.reduce((sum, s) => sum + s, 0) : null
    } catch {
      // mantém price/stock null pra este produto — não derruba o catálogo inteiro
    }
  })

  products.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  return products
}

/** Atualiza item_sku e, se houver variantes, todos os model_sku com o mesmo valor. */
export async function applyProductSkuUpdate(itemId: number, sku: string): Promise<void> {
  const trimmed = sku.trim()
  if (!trimmed) throw new Error('SKU obrigatório')
  if (trimmed.length > 100) throw new Error('SKU deve ter no máximo 100 caracteres')

  const data = await getItemBaseInfo([itemId])
  const row = parseItemList(data)[0]
  if (!row) throw new Error('Produto não encontrado')

  const itemData = await updateItemSku(itemId, trimmed)
  assertShopeeOk(itemData as ShopeeApiResponse<Record<string, unknown>>, 'update_item')

  if (row.has_model) {
    const models = await fetchModels(itemId)
    if (models.length) {
      const modelData = await updateModelSkus(
        itemId,
        models.map((m) => ({ model_id: m.modelId, model_sku: trimmed })),
      )
      assertShopeeOk(modelData as ShopeeApiResponse<Record<string, unknown>>, 'update_model')
    }
  }
}

/** Lista todo item_id do catálogo — o client chama isso e depois aplica o prazo de postagem
 * 1 produto por vez (ver applyDaysToShipToItem), pra UI mostrar progresso real e não estourar
 * rate limit da Shopee com escrita em paralelo. */
export async function listAllProductItemIds(): Promise<number[]> {
  return fetchAllItemIds()
}

/** Aplica o prazo de postagem (dias) a 1 produto. `is_pre_order` é preservado (lido do próprio
 * get_item_base_info — não dá pra mudar só days_to_ship sem mandar o par pra Shopee). */
export async function applyDaysToShipToItem(itemId: number, daysToShip: number): Promise<void> {
  if (!Number.isFinite(daysToShip) || daysToShip < 1 || daysToShip > 30) {
    throw new Error('Prazo de postagem deve ser um número entre 1 e 30 dias')
  }
  const data = await getItemBaseInfo([itemId])
  const row = parseItemList(data)[0]
  if (!row) throw new Error('Produto não encontrado')

  const isPreOrder = row.pre_order?.is_pre_order ?? false
  const updateData = await updateItemDaysToShip(itemId, daysToShip, isPreOrder)
  assertShopeeOk(updateData as ShopeeApiResponse<Record<string, unknown>>, 'update_item')
}

/** Republica um item com item_status "UNLIST" (a Shopee despublica sozinha às vezes —
 * violação de política, falta de estoque momentânea, etc.). `unlist: false` = publicar. */
export async function republishItem(itemId: number): Promise<void> {
  const updateData = await updateItemUnlist(itemId, false)
  assertShopeeOk(updateData as ShopeeApiResponse<Record<string, unknown>>, 'update_item')
}
