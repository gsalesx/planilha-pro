import {
  assertShopeeOk,
  fetchAllItemIds,
  getItemBaseInfo,
  getModelList,
  type ShopeeApiResponse,
  updateItemSku,
  updateModelSkus,
} from './shopee-api.js'

export interface CatalogModel {
  modelId: number
  modelSku: string
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
    models.push({ modelId: m.model_id, modelSku: m.model_sku ?? '' })
  }
  return models
}

function parseItemList(data: ShopeeApiResponse): ItemBaseRow[] {
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_item_base_info') as {
    item_list?: ItemBaseRow[]
  }
  return body.item_list ?? []
}

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

  products.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
  return products
}

export interface SkuUpdateInput {
  itemId: number
  sku: string
}

export interface SkuUpdateResult {
  itemId: number
  ok: boolean
  error?: string
}

/** Atualiza item_sku e, se houver variantes, todos os model_sku com o mesmo valor. */
export async function applyProductSkuUpdate(
  itemId: number,
  sku: string,
  _catalog?: CatalogProduct,
): Promise<void> {
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

export async function applyBulkSkuUpdates(
  updates: SkuUpdateInput[],
  catalog: CatalogProduct[],
): Promise<SkuUpdateResult[]> {
  const byId = new Map(catalog.map((p) => [p.itemId, p]))
  const results: SkuUpdateResult[] = []
  for (const { itemId, sku } of updates) {
    try {
      await applyProductSkuUpdate(itemId, sku, byId.get(itemId))
      results.push({ itemId, ok: true })
    } catch (error) {
      results.push({
        itemId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return results
}
