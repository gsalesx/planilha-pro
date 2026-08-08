import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { env, type ShopeeRuntimeEnv } from './env.js'
import { loadShopeeAuth, saveShopeeAuth, type ShopeeAuthRecord } from './shopee-store.js'

export interface ShopeeApiResponse<T = unknown> {
  error?: string
  message?: string
  request_id?: string
  response?: T
  [key: string]: unknown
}

const HOSTS: Record<ShopeeRuntimeEnv, string> = {
  sandbox: 'https://openplatform.sandbox.test-stable.shopee.sg',
  production: 'https://partner.shopeemobile.com',
}

export function shopeeHost(): string {
  return HOSTS[env.shopeeEnv]
}

function signBase(partnerId: string, path: string, timestamp: number, tail = ''): string {
  return `${partnerId}${path}${timestamp}${tail}`
}

export function hmacSign(base: string): string {
  return createHmac('sha256', env.shopeePartnerKey).update(base).digest('hex')
}

export function signPublic(path: string, timestamp: number): string {
  return hmacSign(signBase(env.shopeePartnerId, path, timestamp))
}

export function signShop(path: string, timestamp: number, accessToken: string, shopId: number): string {
  return hmacSign(signBase(env.shopeePartnerId, path, timestamp, `${accessToken}${shopId}`))
}

function buildSignedUrl(path: string, sign: string, timestamp: number, extra: Record<string, string | number> = {}): string {
  const params = new URLSearchParams({
    partner_id: env.shopeePartnerId,
    timestamp: String(timestamp),
    sign,
  })
  for (const [key, value] of Object.entries(extra)) {
    params.set(key, String(value))
  }
  return `${shopeeHost()}${path}?${params.toString()}`
}

async function parseShopeeJson<T>(response: Response): Promise<ShopeeApiResponse<T>> {
  const text = await response.text()
  try {
    return JSON.parse(text) as ShopeeApiResponse<T>
  } catch {
    throw new Error(`Resposta inválida da Shopee (${response.status}): ${text.slice(0, 300)}`)
  }
}

function hasShopeeError(data: ShopeeApiResponse): boolean {
  return Boolean(data.error && data.error !== '')
}

function unwrapShopeeResponse<T extends Record<string, unknown>>(
  data: ShopeeApiResponse<T>,
  context: string,
): T {
  if (hasShopeeError(data)) {
    throw new Error(`${context}: ${data.error}${data.message ? ` — ${data.message}` : ''}`)
  }
  if (data.response != null && typeof data.response === 'object') {
    return data.response as T
  }
  const meta = new Set(['error', 'message', 'request_id'])
  const flat = Object.fromEntries(Object.entries(data).filter(([k]) => !meta.has(k))) as T
  if (Object.keys(flat).length === 0) {
    throw new Error(`${context}: resposta vazia — ${JSON.stringify(data).slice(0, 300)}`)
  }
  return flat
}

export function assertShopeeOk<T extends Record<string, unknown>>(data: ShopeeApiResponse<T>, context: string): T {
  return unwrapShopeeResponse(data, context)
}

type TokenPayload = Record<string, unknown> & {
  access_token?: string
  refresh_token?: string
  expire_in?: number
  expires_in?: number
  shop_id?: number
}

function tokenExpireSeconds(payload: TokenPayload): number {
  return payload.expire_in ?? payload.expires_in ?? 4 * 3600
}

export function buildAuthPartnerUrl(): string {
  const path = '/api/v2/shop/auth_partner'
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signPublic(path, timestamp)
  const redirect = encodeURIComponent(env.shopeeRedirectUrl)
  return `${shopeeHost()}${path}?partner_id=${env.shopeePartnerId}&timestamp=${timestamp}&sign=${sign}&redirect=${redirect}`
}

export async function exchangeAuthCode(code: string, shopId: number): Promise<ShopeeAuthRecord> {
  const path = '/api/v2/auth/token/get'
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signPublic(path, timestamp)
  const url = buildSignedUrl(path, sign, timestamp)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code,
      shop_id: shopId,
      partner_id: Number(env.shopeePartnerId),
    }),
  })
  const data = await parseShopeeJson<TokenPayload>(response)
  const payload = assertShopeeOk(data, 'token/get')
  if (!payload.access_token || !payload.refresh_token) {
    throw new Error(`token/get: resposta incompleta — ${JSON.stringify(data).slice(0, 300)}`)
  }
  const now = Date.now()
  const record: ShopeeAuthRecord = {
    shopId: payload.shop_id ?? shopId,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessExpireAt: now + tokenExpireSeconds(payload) * 1000,
    updatedAt: now,
  }
  saveShopeeAuth(record)
  return record
}

export async function refreshShopAccessToken(record: ShopeeAuthRecord): Promise<ShopeeAuthRecord> {
  const path = '/api/v2/auth/access_token/get'
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signPublic(path, timestamp)
  const url = buildSignedUrl(path, sign, timestamp)
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shop_id: record.shopId,
      refresh_token: record.refreshToken,
      partner_id: Number(env.shopeePartnerId),
    }),
  })
  const data = await parseShopeeJson<TokenPayload>(response)
  const payload = assertShopeeOk(data, 'access_token/get')
  if (!payload.access_token || !payload.refresh_token) {
    throw new Error(`access_token/get: resposta incompleta — ${JSON.stringify(data).slice(0, 300)}`)
  }
  const now = Date.now()
  const updated: ShopeeAuthRecord = {
    shopId: payload.shop_id ?? record.shopId,
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    accessExpireAt: now + tokenExpireSeconds(payload) * 1000,
    updatedAt: now,
  }
  saveShopeeAuth(updated)
  return updated
}

export async function ensureShopAuth(): Promise<ShopeeAuthRecord> {
  let record = loadShopeeAuth()
  if (!record) throw new Error('Loja não autorizada. Use o link de autorização no painel Shopee.')
  if (Date.now() >= record.accessExpireAt - 5 * 60 * 1000) {
    record = await refreshShopAccessToken(record)
  }
  return record
}

async function shopApiGet(path: string, query: Record<string, string | number> = {}): Promise<ShopeeApiResponse> {
  const auth = await ensureShopAuth()
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signShop(path, timestamp, auth.accessToken, auth.shopId)
  const url = buildSignedUrl(path, sign, timestamp, {
    access_token: auth.accessToken,
    shop_id: auth.shopId,
    ...query,
  })
  const response = await fetch(url, { method: 'GET' })
  return parseShopeeJson(response)
}

async function shopApiPost(
  path: string,
  body: unknown,
  query: Record<string, string | number> = {},
): Promise<ShopeeApiResponse> {
  const auth = await ensureShopAuth()
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signShop(path, timestamp, auth.accessToken, auth.shopId)
  const url = buildSignedUrl(path, sign, timestamp, {
    access_token: auth.accessToken,
    shop_id: auth.shopId,
    ...query,
  })
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return parseShopeeJson(response)
}

export interface OrderListParams {
  timeFrom: number
  timeTo: number
  orderStatus?: string
  pageSize?: number
  cursor?: string
  timeRangeField?: 'create_time' | 'update_time'
}

export async function getOrderList(params: OrderListParams): Promise<ShopeeApiResponse> {
  const query: Record<string, string | number> = {
    time_range_field: params.timeRangeField ?? 'create_time',
    time_from: params.timeFrom,
    time_to: params.timeTo,
    page_size: params.pageSize ?? 50,
    response_optional_fields: 'order_status',
  }
  if (params.orderStatus) query.order_status = params.orderStatus
  if (params.cursor) query.cursor = params.cursor
  return shopApiGet('/api/v2/order/get_order_list', query)
}

const ORDER_DETAIL_FIELDS =
  'buyer_username,recipient_address,item_list,order_status,create_time,ship_by_date'

export async function getOrderDetail(
  orderSnList: string[],
  optionalFields: string = ORDER_DETAIL_FIELDS,
): Promise<ShopeeApiResponse> {
  if (!orderSnList.length) throw new Error('orderSnList obrigatório')
  return shopApiGet('/api/v2/order/get_order_detail', {
    order_sn_list: orderSnList.slice(0, 50).join(','),
    response_optional_fields: optionalFields,
  })
}

export const ORDER_BUYER_FIELDS = 'buyer_user_id,buyer_username'

export interface OrderListPage {
  orderSnList: string[]
  more: boolean
  nextCursor: string
}

export async function fetchOrderListPage(params: OrderListParams): Promise<OrderListPage> {
  const data = await getOrderList(params)
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_order_list') as {
    order_list?: Array<{ order_sn?: string }>
    more?: boolean
    next_cursor?: string
  }
  const orderSnList = (body.order_list ?? [])
    .map((o) => o.order_sn)
    .filter((sn): sn is string => Boolean(sn))
  return {
    orderSnList,
    more: Boolean(body.more),
    nextCursor: body.next_cursor ?? '',
  }
}

export async function getShopInfo(): Promise<ShopeeApiResponse> {
  return shopApiGet('/api/v2/shop/get_shop_info')
}

export interface ItemListParams {
  offset?: number
  pageSize?: number
  itemStatus?: string
  updateTimeFrom?: number
  updateTimeTo?: number
}

export async function getItemList(params: ItemListParams = {}): Promise<ShopeeApiResponse> {
  const query: Record<string, string | number> = {
    offset: params.offset ?? 0,
    page_size: params.pageSize ?? 20,
    item_status: params.itemStatus ?? 'NORMAL',
  }
  if (params.updateTimeFrom != null) query.update_time_from = params.updateTimeFrom
  if (params.updateTimeTo != null) query.update_time_to = params.updateTimeTo
  return shopApiGet('/api/v2/product/get_item_list', query)
}

/** price_info/stock_info_v2 não vêm por padrão — a Shopee só devolve o que response_optional_fields pedir. */
export async function getItemBaseInfo(itemIds: number[]): Promise<ShopeeApiResponse> {
  if (!itemIds.length) throw new Error('itemIds obrigatório')
  return shopApiGet('/api/v2/product/get_item_base_info', {
    item_id_list: itemIds.join(','),
    need_tax_info: 'false',
    need_complaint_policy: 'false',
    response_optional_fields: 'price_info,stock_info_v2,pre_order',
  })
}

export async function getModelList(itemId: number): Promise<ShopeeApiResponse> {
  return shopApiGet('/api/v2/product/get_model_list', {
    item_id: itemId,
    response_optional_fields: 'price_info,stock_info_v2,tier_index',
  })
}

export async function updateItemSku(itemId: number, itemSku: string): Promise<ShopeeApiResponse> {
  return shopApiPost('/api/v2/product/update_item', {
    item_id: itemId,
    item_sku: itemSku,
  })
}

/** Publica/despublica via o endpoint DEDICADO. `update_item` também aceita um campo
 * `unlist`, e ele até funciona, mas de forma ASSÍNCRONA: medido ao vivo em dois itens
 * reais, a resposta ecoa item_status:UNLIST e o item só vira NORMAL ~3min depois (o
 * update_time do item nem muda antes disso) — era isso que fazia parecer que a
 * publicação não acontecia. unlist_item aplica na hora (item já NORMAL em segundos) e,
 * melhor ainda, devolve o resultado POR ITEM em success_list/failure_list, com o motivo
 * de cada recusa (ex: item em promoção) em vez de silêncio. */
export async function updateItemUnlist(itemId: number, unlist: boolean): Promise<ShopeeApiResponse> {
  return shopApiPost('/api/v2/product/unlist_item', {
    item_list: [{ item_id: itemId, unlist }],
  })
}

/** Prazo de postagem (dias pra despachar) — `is_pre_order` precisa ir junto, a Shopee rejeita
 * `days_to_ship` sozinho sem o par. Ler o valor atual de `is_pre_order` (get_item_base_info,
 * campo pre_order) antes de chamar, pra não mudar esse flag sem querer. */
export async function updateItemDaysToShip(
  itemId: number,
  daysToShip: number,
  isPreOrder: boolean,
): Promise<ShopeeApiResponse> {
  return shopApiPost('/api/v2/product/update_item', {
    item_id: itemId,
    pre_order: { is_pre_order: isPreOrder, days_to_ship: daysToShip },
  })
}

export async function updateModelSkus(
  itemId: number,
  models: Array<{ model_id: number; model_sku: string }>,
): Promise<ShopeeApiResponse> {
  if (!models.length) throw new Error('model list vazia')
  return shopApiPost('/api/v2/product/update_model', {
    item_id: itemId,
    model: models,
  })
}

/** NORMAL+UNLIST sozinhos ficavam ~13 produtos abaixo do total real da loja (2026-07-15) —
 * REVIEWING (produto em análise da Shopee, ainda não publicado) também conta pro vendedor.
 * DELETED/BANNED ficam de fora de propósito (não editáveis, não fazem sentido no catálogo). */
export const SHOPEE_ITEM_LIST_STATUSES = ['NORMAL', 'UNLIST', 'REVIEWING'] as const

export async function fetchAllItemIds(statuses = SHOPEE_ITEM_LIST_STATUSES): Promise<number[]> {
  const seen = new Set<number>()
  for (const itemStatus of statuses) {
    let offset = 0
    const pageSize = 100
    while (true) {
      const data = await getItemList({ offset, pageSize, itemStatus })
      const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_item_list') as {
        item?: Array<{ item_id?: number }>
        has_next_page?: boolean
        next_offset?: number
      }
      const batch = (body.item ?? [])
        .map((row) => row.item_id)
        .filter((id): id is number => typeof id === 'number' && id > 0)
      for (const id of batch) seen.add(id)
      if (!body.has_next_page || batch.length === 0) break
      offset = body.next_offset ?? offset + pageSize
    }
  }
  return [...seen]
}

export interface ConversationListParams {
  /** latest = aceito; older = candidato ao enum correto; oldest/newest = só para teste no Shopee Test */
  direction?: 'latest' | 'older' | 'oldest' | 'newest' | string
  type?: 'all' | 'pinned' | 'unread'
  pageSize?: number
  /**
   * Paginação — request usa next_timestamp_nano (string; nanos não cabem em Number seguro).
   * Com direction=latest a API começa no passado e avança em direção ao presente via next_timestamp_nano.
   */
  nextTimestampNano?: string
}

export async function getConversationList(params: ConversationListParams = {}): Promise<ShopeeApiResponse> {
  const query: Record<string, string | number> = {
    direction: params.direction ?? 'latest',
    type: params.type ?? 'all',
    page_size: params.pageSize ?? 20,
  }
  if (params.nextTimestampNano) query.next_timestamp_nano = params.nextTimestampNano
  return shopApiGet('/api/v2/sellerchat/get_conversation_list', query)
}

export interface MessageListParams {
  conversationId: string
  pageSize?: number
  /** message_id cursor — omita ou '' para as mais recentes (padrão Shopee) */
  offset?: number | string
}

export async function getMessageList(params: MessageListParams): Promise<ShopeeApiResponse> {
  const query: Record<string, string | number> = {
    conversation_id: params.conversationId,
    page_size: params.pageSize ?? 20,
  }
  if (params.offset != null && params.offset !== '') {
    query.offset = params.offset
  } else {
    query.offset = ''
  }
  return shopApiGet('/api/v2/sellerchat/get_message', query)
}

export interface SendChatMessageParams {
  toId: number
  text: string
  /** Só obrigatório se business_type ≠ 0 */
  conversationId?: string
  businessType?: number
}

export async function sendChatMessage(params: SendChatMessageParams): Promise<ShopeeApiResponse> {
  const toId = Number(params.toId)
  if (!toId || toId <= 0) throw new Error('toId obrigatório')
  const text = params.text.trim()
  if (!text) throw new Error('texto da mensagem obrigatório')
  const body: Record<string, unknown> = {
    to_id: toId,
    message_type: 'text',
    content: { text },
  }
  const businessType = params.businessType ?? 0
  if (businessType > 0) {
    body.business_type = businessType
    if (!params.conversationId?.trim()) {
      throw new Error('conversation_id obrigatório quando business_type ≠ 0')
    }
    body.conversation_id = params.conversationId.trim()
  }
  return shopApiPost('/api/v2/sellerchat/send_message', body)
}

export async function uploadChatImage(filePath: string): Promise<string> {
  const auth = await ensureShopAuth()
  const apiPath = '/api/v2/sellerchat/upload_image'
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signShop(apiPath, timestamp, auth.accessToken, auth.shopId)
  const url = buildSignedUrl(apiPath, sign, timestamp, {
    access_token: auth.accessToken,
    shop_id: auth.shopId,
  })
  const buffer = readFileSync(filePath)
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: 'image/jpeg' }), basename(filePath) || 'preview.jpg')
  const response = await fetch(url, { method: 'POST', body: form })
  const data = await parseShopeeJson(response)
  const body = assertShopeeOk(
    data as ShopeeApiResponse<Record<string, unknown>>,
    'upload_image',
  )
  const nested =
    body.response != null && typeof body.response === 'object'
      ? (body.response as Record<string, unknown>)
      : body
  const imageUrl = String(nested.url ?? nested.image_url ?? '').trim()
  if (!imageUrl) {
    throw new Error(`upload_image: URL não retornada — ${JSON.stringify(data).slice(0, 300)}`)
  }
  return imageUrl
}

export async function sendChatImageMessage(params: {
  toId: number
  imageUrl: string
}): Promise<void> {
  const toId = Number(params.toId)
  if (!toId || toId <= 0) throw new Error('toId obrigatório')
  const imageUrl = params.imageUrl.trim()
  if (!imageUrl) throw new Error('imageUrl obrigatório')
  const body: Record<string, unknown> = {
    to_id: toId,
    message_type: 'image',
    content: { image_url: imageUrl },
  }
  const data = await shopApiPost('/api/v2/sellerchat/send_message', body)
  assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'send_message')
}

/* ===========================================================
   Organizar envio (logistics/ship_order) — atribui o rastreio
   =========================================================== */

export interface ShippingPickupAddress {
  addressId: number
  timeSlotIds: string[]
}

export interface ShippingParameter {
  /** Campos que a Shopee pede pra cada modo. `null` = a chave NÃO veio no `info_needed`
   *  (modo não se aplica a este pedido); `[]` = o modo se aplica e não exige nenhum campo. */
  pickupFields: string[] | null
  dropoffFields: string[] | null
  nonIntegratedFields: string[] | null
  pickupAddresses: ShippingPickupAddress[]
  dropoffBranchIds: number[]
}

/** Mensagens amigáveis pra códigos de erro de logistics que aparecem tanto no
 *  get_shipping_parameter quanto no ship_order. */
function friendlyLogisticsError(error: string, message: string): string {
  if (error === 'logistics.lack_of_invoice_data') {
    return 'Nota fiscal ainda não emitida/registrada na Shopee — emita a nota antes de organizar o envio.'
  }
  return `${error}${message ? ` — ${message}` : ''}`
}

/** O modo de envio do pedido é dado pela PRESENÇA da chave em `info_needed`; o conteúdo do
 *  array diz só quais campos são obrigatórios. Array vazio (ex.: `{"dropoff":[]}`) significa
 *  "é este o modo e não precisa de campo nenhum" — a doc do ship_order é explícita:
 *  "Developer should still include the field in the call even if it has empty value".
 *  Confirmado ao vivo (pedido 2608017D73AB9A): a Shopee devolve `info_needed:{dropoff:[]}`,
 *  só a chave do modo aplicável. */
function infoNeededFields(value: unknown): string[] | null {
  return Array.isArray(value) ? value.map((field) => String(field)) : null
}

/** Resposta CRUA do get_shipping_parameter — usada só pelo endpoint de diagnóstico, pra
 *  inspecionar quais chaves de `info_needed` a Shopee manda de verdade num pedido real
 *  (presente-mas-vazia vs ausente muda a decisão do arrangeShipment). */
export async function getShippingParameterRaw(orderSn: string): Promise<ShopeeApiResponse> {
  return shopApiGet('/api/v2/logistics/get_shipping_parameter', { order_sn: orderSn })
}

/** Pedido cujo envio JÁ foi organizado: o get_shipping_parameter passa a recusar
 *  reagendamento (`error_other` — "Package ... not eligible for rescheduling"). Não é falha,
 *  é o estado esperado de quem já despachou — o fluxo só segue pra etiqueta. Confirmado ao
 *  vivo em 2608017D73AB9A depois do ship_order dar certo (status virou PROCESSED). */
export class ShipmentAlreadyArrangedError extends Error {}

function isAlreadyArrangedMessage(message: string): boolean {
  return /not eligible for rescheduling/i.test(message)
}

export async function getShippingParameter(orderSn: string): Promise<ShippingParameter> {
  const data = await shopApiGet('/api/v2/logistics/get_shipping_parameter', { order_sn: orderSn })
  if (hasShopeeError(data)) {
    if (isAlreadyArrangedMessage(String(data.message ?? ''))) {
      throw new ShipmentAlreadyArrangedError('Envio já organizado na Shopee.')
    }
    throw new Error(friendlyLogisticsError(String(data.error ?? ''), String(data.message ?? '')))
  }
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_shipping_parameter')
  const infoNeeded = (body.info_needed as Record<string, unknown> | undefined) ?? {}
  const pickup = (body.pickup as Record<string, unknown> | undefined) ?? {}
  const dropoff = (body.dropoff as Record<string, unknown> | undefined) ?? {}
  const addressList = (pickup.address_list as Array<Record<string, unknown>> | undefined) ?? []
  const branchList = (dropoff.branch_list as Array<Record<string, unknown>> | undefined) ?? []
  return {
    pickupFields: infoNeededFields(infoNeeded.pickup),
    dropoffFields: infoNeededFields(infoNeeded.dropoff),
    nonIntegratedFields: infoNeededFields(infoNeeded.non_integrated),
    pickupAddresses: addressList.map((addr) => ({
      addressId: Number(addr.address_id ?? 0),
      timeSlotIds: ((addr.time_slot_list as Array<Record<string, unknown>> | undefined) ?? [])
        .map((slot) => String(slot.pickup_time_id ?? ''))
        .filter(Boolean),
    })),
    dropoffBranchIds: branchList.map((branch) => Number(branch.branch_id ?? 0)).filter((id) => id > 0),
  }
}

/** `ship_order` — corresponde ao passo "organizar envio" do fluxo Shopee (emitir nota →
 *  organizar envio → imprimir etiqueta). Escolhe automaticamente o 1º endereço de coleta
 *  (com o 1º horário disponível, se houver) ou a 1ª unidade de despacho. Canal
 *  non_integrated (transportadora própria) não dá pra automatizar — precisa do rastreio
 *  já emitido por fora da Shopee, então isso vira erro explicativo pro operador.
 *  `logistics.package_already_shipped` é tratado como sucesso (idempotência: o pedido já
 *  foi organizado antes, então só segue pra etiqueta). `logistics.lack_of_invoice_data` é
 *  o bloqueio mais comum — a nota fiscal ainda não está registrada na Shopee.
 *
 *  ⚠️ Modo vazio (ex.: `info_needed:{dropoff:[]}`) NÃO é falta de dado do lado da Shopee:
 *  é o modo aplicável sem nenhum campo obrigatório, e o campo tem que ir no ship_order
 *  mesmo assim (objeto vazio) — ver `infoNeededFields`. Exigir campo dentro do array
 *  travava o fluxo antes de despachar o pedido (caso 2608017D73AB9A/maduardafreitas,
 *  2026-08-07: a etiqueta nunca saía, e o `shipping_document_should_print_first` que
 *  aparecia depois era só consequência do pedido nunca ter sido organizado). */
export async function arrangeShipment(orderSn: string): Promise<void> {
  let param: ShippingParameter
  try {
    param = await getShippingParameter(orderSn)
  } catch (error) {
    if (error instanceof ShipmentAlreadyArrangedError) return
    throw error
  }
  const body: Record<string, unknown> = { order_sn: orderSn }

  if (param.pickupFields) {
    const pickup: Record<string, unknown> = {}
    if (param.pickupFields.includes('address_id')) {
      const addr = param.pickupAddresses[0]
      if (!addr) throw new Error('Nenhum endereço de coleta cadastrado na Shopee pra este pedido.')
      pickup.address_id = addr.addressId
      if (addr.timeSlotIds[0]) pickup.pickup_time_id = addr.timeSlotIds[0]
    }
    body.pickup = pickup
  } else if (param.dropoffFields) {
    const dropoff: Record<string, unknown> = {}
    if (param.dropoffFields.includes('branch_id')) {
      const branchId = param.dropoffBranchIds[0]
      if (!branchId) throw new Error('Nenhuma unidade de despacho disponível na Shopee pra este pedido.')
      dropoff.branch_id = branchId
    }
    body.dropoff = dropoff
  } else if (param.nonIntegratedFields) {
    if (param.nonIntegratedFields.includes('tracking_no')) {
      throw new Error(
        'Este pedido usa transportadora não integrada — informe o código de rastreio manualmente no app da Shopee antes de imprimir a etiqueta.',
      )
    }
    body.non_integrated = {}
  } else {
    throw new Error(
      'A Shopee não retornou nenhum modo de envio pra este pedido — organize o envio manualmente no app da Shopee e tente imprimir a etiqueta de novo depois.',
    )
  }

  const shipped = await shopApiPost('/api/v2/logistics/ship_order', body)
  if (hasShopeeError(shipped)) {
    if (shipped.error === 'logistics.package_already_shipped') return
    throw new Error(friendlyLogisticsError(String(shipped.error ?? ''), String(shipped.message ?? '')))
  }
}

/* ===========================================================
   Etiqueta de envio (logistics/shipping document)
   =========================================================== */

export type ShippingDocumentType = 'THERMAL_AIR_WAYBILL' | 'NORMAL_AIR_WAYBILL'

export interface ShippingDocumentParameter {
  suggested: ShippingDocumentType | null
  selectable: ShippingDocumentType[]
}

/** get_shipping_document_parameter — diz quais formatos de etiqueta ESTE pedido aceita
 *  (`selectable_shipping_document_type`) e qual a Shopee sugere. Sem isso o formato fica
 *  chutado: 2608017D73AB9A só aceitava NORMAL_AIR_WAYBILL e o download falhava com
 *  `logistics.shipping_document_should_print_first ... NORMAL_AIR_WAYBILL` enquanto o
 *  código insistia no térmico. */
export async function getShippingDocumentParameter(orderSn: string): Promise<ShippingDocumentParameter> {
  const data = await shopApiPost('/api/v2/logistics/get_shipping_document_parameter', {
    order_list: [{ order_sn: orderSn }],
  })
  const resultList =
    data.response != null && typeof data.response === 'object'
      ? ((data.response as Record<string, unknown>).result_list as Array<Record<string, unknown>> | undefined)
      : undefined
  const row = resultList?.[0]
  if (row?.fail_error) {
    const failError = String(row.fail_error)
    const failMessage = String(row.fail_message ?? '')
    if (failError === 'logistics.can_not_print_jit_order') {
      throw new Error(
        'O canal de envio deste pedido só permite imprimir a etiqueta no painel da Shopee (Seller Centre) — não dá pela API.',
      )
    }
    throw new Error(`get_shipping_document_parameter: ${failError}${failMessage ? ` — ${failMessage}` : ''}`)
  }
  if (!row) {
    if (hasShopeeError(data)) {
      throw new Error(
        `get_shipping_document_parameter: ${data.error}${data.message ? ` — ${data.message}` : ''}`,
      )
    }
    return { suggested: null, selectable: [] }
  }
  const suggested = String(row.suggest_shipping_document_type ?? '').trim()
  const selectable = ((row.selectable_shipping_document_type as unknown[] | undefined) ?? [])
    .map((value) => String(value).trim())
    .filter(Boolean)
  return {
    suggested: (suggested || null) as ShippingDocumentType | null,
    selectable: selectable as ShippingDocumentType[],
  }
}

/** Só usa o formato pedido se o pedido aceitar; senão segue o que a Shopee sugere. Falha na
 *  consulta não bloqueia a impressão — cai no formato pedido, como era antes. */
async function resolveShippingDocumentType(
  orderSn: string,
  preferred: ShippingDocumentType,
): Promise<ShippingDocumentType> {
  const param = await getShippingDocumentParameter(orderSn)
  if (param.selectable.length === 0) return param.suggested ?? preferred
  if (param.selectable.includes(preferred)) return preferred
  if (param.suggested && param.selectable.includes(param.suggested)) return param.suggested
  return param.selectable[0]
}

/** get_tracking_number — só depois do ship_order ter atribuído o rastreio. A maioria dos
 *  canais exige esse número no create_shipping_document (só alguns canais liberam
 *  impressão antes de organizar o envio). */
export async function getTrackingNumber(orderSn: string): Promise<string> {
  const data = await shopApiGet('/api/v2/logistics/get_tracking_number', { order_sn: orderSn })
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_tracking_number')
  return String(body.tracking_number ?? '').trim()
}

/** shipping_document_type vai DENTRO de cada item de order_list (não é campo separado no
 *  nível de cima) — confirmado na doc oficial do create_shipping_document. */
export async function createShippingDocument(
  orderSn: string,
  trackingNumber: string,
  shippingDocumentType: ShippingDocumentType,
): Promise<{ ok: true } | { ok: false; failError: string; failMessage: string }> {
  const data = await shopApiPost('/api/v2/logistics/create_shipping_document', {
    order_list: [
      {
        order_sn: orderSn,
        ...(trackingNumber ? { tracking_number: trackingNumber } : {}),
        shipping_document_type: shippingDocumentType,
      },
    ],
  })
  const resultList =
    data.response != null && typeof data.response === 'object'
      ? ((data.response as Record<string, unknown>).result_list as Array<Record<string, unknown>> | undefined)
      : undefined
  const item = resultList?.[0]
  if (item?.fail_error) {
    return {
      ok: false,
      failError: String(item.fail_error),
      failMessage: String(item.fail_message ?? ''),
    }
  }
  if (hasShopeeError(data)) {
    return { ok: false, failError: String(data.error ?? ''), failMessage: String(data.message ?? '') }
  }
  return { ok: true }
}

export interface ShippingDocumentResultItem {
  orderSn: string
  status: string
  failReason: string | null
}

/** Quando TODOS os pedidos do lote falham, a Shopee manda erro no nível de cima
 *  (ex.: `common.batch_api_all_failed`) mas ainda preenche `response.result_list` com o
 *  motivo real por pedido (`fail_error`/`fail_message`) — por isso lê result_list ANTES de
 *  checar o erro de topo, senão a mensagem específica (ex.:
 *  "shipping_document_should_print_first") se perde atrás de um erro genérico. */
export async function getShippingDocumentResult(
  orderSn: string,
  shippingDocumentType: ShippingDocumentType,
): Promise<ShippingDocumentResultItem | null> {
  const data = await shopApiPost('/api/v2/logistics/get_shipping_document_result', {
    order_list: [{ order_sn: orderSn, shipping_document_type: shippingDocumentType }],
  })
  const resultList =
    data.response != null && typeof data.response === 'object'
      ? ((data.response as Record<string, unknown>).result_list as Array<Record<string, unknown>> | undefined)
      : undefined
  const row = resultList?.[0]
  if (!row) {
    if (hasShopeeError(data)) {
      // ⚠️ NÃO tratar "should_print_first" como sucesso/READY — testado ao vivo: apareceu
      // pra um pedido que nunca tinha sido organizado de verdade (2608017D73AB9A), e um
      // fix anterior que tratava isso como "documento pronto" mascarou o erro real e
      // deixou o fluxo tentar baixar um documento que não existia. Propaga como erro.
      throw new Error(`get_shipping_document_result: ${data.error}${data.message ? ` — ${data.message}` : ''}`)
    }
    return null
  }
  return {
    orderSn: String(row.order_sn ?? ''),
    status: String(row.status ?? '').toUpperCase(),
    failReason:
      typeof row.fail_message === 'string' && row.fail_message
        ? row.fail_message
        : typeof row.fail_error === 'string' && row.fail_error
          ? row.fail_error
          : null,
  }
}

async function downloadShippingDocument(
  orderSn: string,
  shippingDocumentType: ShippingDocumentType,
): Promise<Buffer> {
  const auth = await ensureShopAuth()
  const path = '/api/v2/logistics/download_shipping_document'
  const timestamp = Math.floor(Date.now() / 1000)
  const sign = signShop(path, timestamp, auth.accessToken, auth.shopId)
  const url = buildSignedUrl(path, sign, timestamp, {
    access_token: auth.accessToken,
    shop_id: auth.shopId,
  })
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // ⚠️ No download_shipping_document o `shipping_document_type` vai no NÍVEL DE CIMA, fora
    // do order_list (≠ create_shipping_document e get_shipping_document_result, onde vai
    // DENTRO de cada item — conferido nas 3 docs oficiais). Mandando dentro, a Shopee
    // ignorava e baixava no default NORMAL_AIR_WAYBILL: com o documento criado como
    // THERMAL, o download acusava `shipping_document_should_print_first ...
    // NORMAL_AIR_WAYBILL` — reclamando de um formato que nunca tinha sido criado.
    body: JSON.stringify({
      order_list: [{ order_sn: orderSn }],
      shipping_document_type: shippingDocumentType,
    }),
  })
  const contentType = response.headers.get('content-type') ?? ''
  if (contentType.includes('application/json') || contentType.includes('text/')) {
    const text = await response.text()
    let parsed: ShopeeApiResponse | null = null
    try {
      parsed = JSON.parse(text) as ShopeeApiResponse
    } catch {
      // resposta não-JSON e não-PDF — reporta como texto bruto
    }
    const message = parsed
      ? `${parsed.error ?? 'erro'}${parsed.message ? ` — ${parsed.message}` : ''}`
      : text.slice(0, 300)
    throw new Error(`download_shipping_document: ${message}`)
  }
  const arrayBuffer = await response.arrayBuffer()
  return Buffer.from(arrayBuffer)
}

const SHIPPING_DOCUMENT_POLL_ATTEMPTS = 6
const SHIPPING_DOCUMENT_POLL_DELAY_MS = 1200
const TRACKING_NUMBER_POLL_ATTEMPTS = 4
const TRACKING_NUMBER_POLL_DELAY_MS = 1500

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** A Shopee pode demorar pra atribuir o rastreio depois do ship_order (depende do 3PL —
 *  a doc do get_tracking_number recomenda repetir por até 5min). Aqui insiste só uns
 *  segundos: se ainda não vier, segue sem rastreio — alguns canais liberam impressão
 *  mesmo assim (create_shipping_document aceita tracking_number vazio nesses casos). */
async function waitForTrackingNumber(orderSn: string): Promise<string> {
  for (let attempt = 0; attempt < TRACKING_NUMBER_POLL_ATTEMPTS; attempt++) {
    try {
      const tracking = await getTrackingNumber(orderSn)
      if (tracking) return tracking
    } catch (error) {
      console.warn('[shopee] get_tracking_number falhou', orderSn, error instanceof Error ? error.message : error)
    }
    if (attempt < TRACKING_NUMBER_POLL_ATTEMPTS - 1) await sleep(TRACKING_NUMBER_POLL_DELAY_MS)
  }
  return ''
}

/** Fluxo completo pra imprimir etiqueta: busca o rastreio (já precisa existir — ver
 *  arrangeShipment), cria o job do documento, espera ficar READY e baixa o PDF. */
export async function fetchShippingLabelPdf(
  orderSn: string,
  preferredDocumentType: ShippingDocumentType = 'THERMAL_AIR_WAYBILL',
): Promise<Buffer> {
  const shippingDocumentType = await resolveShippingDocumentType(orderSn, preferredDocumentType)
  const trackingNumber = await waitForTrackingNumber(orderSn)

  const created = await createShippingDocument(orderSn, trackingNumber, shippingDocumentType)
  let createErrorMessage: string | null = null
  if (!created.ok) {
    createErrorMessage = `${created.failError}${created.failMessage ? ` — ${created.failMessage}` : ''}`
    console.warn('[shopee] create_shipping_document', orderSn, createErrorMessage)
  }

  let lastStatus = ''
  for (let attempt = 0; attempt < SHIPPING_DOCUMENT_POLL_ATTEMPTS; attempt++) {
    const result = await getShippingDocumentResult(orderSn, shippingDocumentType)
    lastStatus = result?.status ?? ''
    // Sem status nenhum e o create falhou de verdade (não é "já existe") — não adianta
    // insistir, o pedido nem tem job criado. Propaga o erro real da Shopee na hora, em
    // vez de deixar o operador esperar ~7s pra ver uma mensagem genérica de timeout.
    if (!lastStatus && createErrorMessage) {
      throw new Error(createErrorMessage)
    }
    if (lastStatus === 'READY') break
    if (lastStatus === 'FAILED') {
      throw new Error(result?.failReason ?? 'Shopee não conseguiu gerar a etiqueta deste pedido.')
    }
    await sleep(SHIPPING_DOCUMENT_POLL_DELAY_MS)
  }
  if (lastStatus !== 'READY') {
    throw new Error('Etiqueta ainda não ficou pronta na Shopee — tente novamente em alguns segundos.')
  }

  return downloadShippingDocument(orderSn, shippingDocumentType)
}

/** Fluxo "organizar envio" + "imprimir etiqueta" num clique só: chama arrangeShipment
 *  (ship_order) e, se der certo (ou já tiver sido organizado antes), segue pra
 *  fetchShippingLabelPdf. Se faltar nota fiscal ou o pedido usar transportadora não
 *  integrada, o erro explicativo de arrangeShipment sobe direto pro operador. */
export async function arrangeShipmentAndFetchLabel(
  orderSn: string,
  shippingDocumentType: ShippingDocumentType = 'THERMAL_AIR_WAYBILL',
): Promise<Buffer> {
  await arrangeShipment(orderSn)
  return fetchShippingLabelPdf(orderSn, shippingDocumentType)
}

export interface ShopeeConversationEntry {
  conversationId: string
  toId: number
  toName: string
}

/** Quantos chats varrer no vínculo (get_conversation_list). */
export const SHOPEE_CONVERSATION_SCAN_MAX = 200_000

export interface ConversationPageMetric {
  page: number
  chatsOnPage: number
  indexedOnPage: number
  scannedTotal: number
  newestOnPage: string | null
  oldestOnPage: string | null
  /** Cursor enviado nesta requisição (vazio na 1ª página). */
  inputTimestampNano: string | null
  /** Cursor para pedir a página seguinte — use em startTimestampNano para retomar. */
  nextTimestampNano: string | null
}

function parseConversationRow(row: Record<string, unknown>): ShopeeConversationEntry | null {
  const toUserInfo =
    row.to_user_info && typeof row.to_user_info === 'object'
      ? (row.to_user_info as Record<string, unknown>)
      : undefined
  const toId = Number(
    row.to_id ??
      row.to_user_id ??
      row.buyer_user_id ??
      row.buyer_id ??
      row.user_id ??
      toUserInfo?.user_id ??
      toUserInfo?.to_id ??
      0,
  )
  const conversationId = String(row.conversation_id ?? row.id ?? row.latest_conversation_id ?? '').trim()
  const toName = String(
    row.to_name ??
      row.to_user_name ??
      row.username ??
      row.buyer_username ??
      toUserInfo?.name ??
      toUserInfo?.user_name ??
      '',
  ).trim()
  if (!conversationId || !toName) return null
  return { conversationId, toId, toName }
}

/** Campos de username que a Shopee pode devolver num chat (para debug / vínculo). */
export function conversationUsernameFields(row: Record<string, unknown>): Record<string, string | null> {
  const toUserInfo =
    row.to_user_info && typeof row.to_user_info === 'object'
      ? (row.to_user_info as Record<string, unknown>)
      : undefined
  const pick = (v: unknown): string | null => {
    const s = String(v ?? '').trim()
    return s || null
  }
  return {
    to_name: pick(row.to_name),
    to_user_name: pick(row.to_user_name),
    username: pick(row.username),
    buyer_username: pick(row.buyer_username),
    to_user_info_name: pick(toUserInfo?.name),
    to_user_info_user_name: pick(toUserInfo?.user_name),
    parsed_for_link: parseConversationRow(row)?.toName ?? null,
  }
}

export function summarizeConversationPage(body: Record<string, unknown>): {
  count: number
  more: boolean | null
  nextTimestampNano: string | null
  rows: Array<{
    conversation_id: string | null
    to_id: number | null
    shop_id: number | null
    last_message_ts: string | null
    usernames: Record<string, string | null>
  }>
} {
  const list = conversationListFromBody(body)
  const pageResult =
    body.page_result && typeof body.page_result === 'object'
      ? (body.page_result as Record<string, unknown>)
      : undefined
  const moreRaw = pageResult?.more ?? body.more
  const more = moreRaw === true || moreRaw === 'true' || moreRaw === 1 ? true : moreRaw === false ? false : null
  return {
    count: list.length,
    more,
    nextTimestampNano: resolveNextConversationTimestamp(body, list) ?? null,
    rows: list.map((row) => ({
      conversation_id: String(row.conversation_id ?? '').trim() || null,
      to_id: Number(row.to_id ?? 0) || null,
      shop_id: Number(row.shop_id ?? 0) || null,
      last_message_ts: String(
        row.last_message_timestamp ?? row.latest_message_timestamp_nano ?? row.latest_message_timestamp ?? '',
      ).trim() || null,
      usernames: conversationUsernameFields(row),
    })),
  }
}

function conversationListFromBody(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw =
    body.conversations ??
    body.conversation_list ??
    body.list ??
    body.conversation ??
    body.items
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
}

function parseMessageTimeNano(raw: unknown): bigint | undefined {
  if (raw == null || raw === '') return undefined
  try {
    const n = BigInt(String(raw))
    return n > 0n ? n : undefined
  } catch {
    return undefined
  }
}

function conversationMessageTimeNano(row: Record<string, unknown>): bigint | undefined {
  const raw =
    row.last_message_timestamp ??
    row.latest_message_timestamp ??
    row.last_message_timestamp_nano ??
    row.latest_message_timestamp_nano
  return parseMessageTimeNano(raw)
}

function pageMessageTimeRange(list: Array<Record<string, unknown>>): {
  newest: bigint | undefined
  oldest: bigint | undefined
} {
  let newest: bigint | undefined
  let oldest: bigint | undefined
  for (const row of list) {
    const ts = conversationMessageTimeNano(row)
    if (ts == null) continue
    if (newest == null || ts > newest) newest = ts
    if (oldest == null || ts < oldest) oldest = ts
  }
  return { newest, oldest }
}

function nanoBigIntToIso(nano: bigint): string {
  return new Date(Number(nano / 1_000_000n)).toISOString()
}

function resolveNextConversationTimestamp(
  body: Record<string, unknown>,
  list: Array<Record<string, unknown>>,
): string | undefined {
  const pageResult =
    body.page_result && typeof body.page_result === 'object'
      ? (body.page_result as Record<string, unknown>)
      : undefined
  const more = pageResult?.more ?? body.more
  if (more !== true && more !== 'true' && more !== 1) return undefined

  const rawNext = pageResult?.next_cursor ?? body.next_cursor
  if (typeof rawNext === 'object' && rawNext !== null) {
    const obj = rawNext as Record<string, unknown>
    const nano = parseMessageTimeNano(obj.next_message_time_nano ?? obj.next_timestamp_nano)
    if (nano != null) return nano.toString()
  }

  const flat = parseMessageTimeNano(pageResult?.next_timestamp_nano ?? body.next_timestamp_nano)
  if (flat != null) return flat.toString()

  if (typeof rawNext === 'string' || typeof rawNext === 'number') {
    const nano = parseMessageTimeNano(rawNext)
    if (nano != null) return nano.toString()
  }

  // fallback: último item da página (maior timestamp)
  const last = list[list.length - 1]
  const lastTs = last ? conversationMessageTimeNano(last) : undefined
  return lastTs?.toString()
}

/** Uma página de get_conversation_list (para varredura fragmentada). */
export async function fetchConversationPage(options: {
  nextTimestampNano?: string
  pageNumber: number
  scannedBefore: number
  direction?: 'latest' | 'older'
}): Promise<{
  pageMetric: ConversationPageMetric
  entries: ShopeeConversationEntry[]
  hasMore: boolean
  connectedShopId: number | null
}> {
  const auth = loadShopeeAuth()
  const inputTimestampNano = options.nextTimestampNano?.trim() || null
  const data = await getConversationList({
    direction: options.direction ?? 'older',
    type: 'all',
    pageSize: 50,
    nextTimestampNano: inputTimestampNano ?? undefined,
  })
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_conversation_list') as Record<
    string,
    unknown
  >
  const list = conversationListFromBody(body)
  const entries: ShopeeConversationEntry[] = []
  let indexedOnPage = 0
  let scanned = options.scannedBefore

  for (const row of list) {
    scanned++
    const entry = parseConversationRow(row)
    if (!entry) continue
    indexedOnPage++
    entries.push(entry)
  }

  const range = pageMessageTimeRange(list)
  const next = list.length > 0 ? resolveNextConversationTimestamp(body, list) ?? null : null
  const hasMore =
    list.length > 0 && next != null && next !== (inputTimestampNano ?? '')

  const pageMetric: ConversationPageMetric = {
    page: options.pageNumber,
    chatsOnPage: list.length,
    indexedOnPage,
    scannedTotal: scanned,
    newestOnPage: range.newest != null ? nanoBigIntToIso(range.newest) : null,
    oldestOnPage: range.oldest != null ? nanoBigIntToIso(range.oldest) : null,
    inputTimestampNano,
    nextTimestampNano: next,
  }

  return {
    pageMetric,
    entries,
    hasMore,
    connectedShopId: auth?.shopId ?? null,
  }
}

/** Pagina get_conversation_list — até maxConversations ou achar todos os to_name pedidos. */
export async function fetchConversationMap(
  options: {
    targetUsernames?: Set<string>
    maxConversations?: number
    /** Retomar varredura a partir deste next_timestamp_nano (copie do log de paginação). */
    startTimestampNano?: string
  } = {},
): Promise<{
  byUsername: Map<string, ShopeeConversationEntry>
  scanned: number
  indexed: number
  pages: number
  newestChatAt: string | null
  oldestScannedChatAt: string | null
  connectedShopId: number | null
  chatShopIds: number[]
  pageMetrics: ConversationPageMetric[]
  resumeCursor: string | null
}> {
  const auth = loadShopeeAuth()
  const chatShopIds = new Set<number>()
  const byUsername = new Map<string, ShopeeConversationEntry>()
  const pageMetrics: ConversationPageMetric[] = []
  const maxConversations = Math.min(
    Math.max(options.maxConversations ?? SHOPEE_CONVERSATION_SCAN_MAX, 50),
    SHOPEE_CONVERSATION_SCAN_MAX,
  )
  let nextTimestampNano: string | undefined = options.startTimestampNano?.trim() || undefined
  let scanned = 0
  let indexed = 0
  let pages = 0
  let prevTimestamp: string | undefined
  let newestTs: bigint | undefined
  let oldestTs: bigint | undefined
  let lastNextCursor: string | null = null

  const allFound = (): boolean => {
    if (!options.targetUsernames || options.targetUsernames.size === 0) return false
    for (const name of options.targetUsernames) {
      if (!byUsername.has(name)) return false
    }
    return true
  }

  while (scanned < maxConversations) {
    const inputTimestampNano = nextTimestampNano ?? null
    const pageSize = Math.min(50, maxConversations - scanned)
    const data = await getConversationList({
      direction: 'latest',
      type: 'all',
      pageSize,
      nextTimestampNano,
    })
    const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_conversation_list') as Record<
      string,
      unknown
    >
    const list = conversationListFromBody(body)
    pages++
    if (list.length === 0) {
      pageMetrics.push({
        page: pages,
        chatsOnPage: 0,
        indexedOnPage: 0,
        scannedTotal: scanned,
        newestOnPage: null,
        oldestOnPage: null,
        inputTimestampNano,
        nextTimestampNano: null,
      })
      break
    }

    let indexedOnPage = 0
    for (const row of list) {
      scanned++
      const shopId = Number(row.shop_id ?? 0)
      if (shopId > 0) chatShopIds.add(shopId)
      const entry = parseConversationRow(row)
      if (!entry) continue
      indexed++
      indexedOnPage++
      byUsername.set(entry.toName.toLowerCase(), entry)
      const ts = conversationMessageTimeNano(row)
      if (ts != null) {
        if (newestTs == null || ts > newestTs) newestTs = ts
        if (oldestTs == null || ts < oldestTs) oldestTs = ts
      }
    }

    const range = pageMessageTimeRange(list)
    const next = resolveNextConversationTimestamp(body, list) ?? null
    if (next) lastNextCursor = next
    pageMetrics.push({
      page: pages,
      chatsOnPage: list.length,
      indexedOnPage,
      scannedTotal: scanned,
      newestOnPage: range.newest != null ? nanoBigIntToIso(range.newest) : null,
      oldestOnPage: range.oldest != null ? nanoBigIntToIso(range.oldest) : null,
      inputTimestampNano,
      nextTimestampNano: next,
    })

    if (allFound() || scanned >= maxConversations) break

    if (next == null || next === prevTimestamp) break
    prevTimestamp = nextTimestampNano
    nextTimestampNano = next
  }

  const newestChatAt = newestTs != null ? nanoBigIntToIso(newestTs) : null
  const oldestScannedChatAt = oldestTs != null ? nanoBigIntToIso(oldestTs) : null

  return {
    byUsername,
    scanned,
    indexed,
    pages,
    newestChatAt,
    oldestScannedChatAt,
    connectedShopId: auth?.shopId ?? null,
    chatShopIds: [...chatShopIds],
    pageMetrics,
    resumeCursor: lastNextCursor,
  }
}

/** Resumo da mensagem citada (resposta a outra msg) — só o suficiente pra mostrar a
 *  faixa de contexto acima da mensagem, igual o app oficial da Shopee. */
export interface QuotedMessage {
  /** message_id da mensagem original — usado só pra rolar até ela na tela quando o
   *  operador clica na faixa de citação (a mensagem original pode não estar carregada
   *  na página atual, então o id nem sempre acha o elemento — nesse caso o clique é
   *  ignorado, sem erro). */
  id: string
  text: string
  imageUrl: string | null
  fromBuyer: boolean
}

export interface ParsedChatMessage {
  id: string
  fromId: number
  toId: number
  type: string
  text: string
  imageUrl: string | null
  createdAt: number | null
  /** true = mensagem do comprador; false = loja/vendedor */
  fromBuyer: boolean
  /** Preenchido quando esta mensagem é uma resposta a outra (`quoted_msg` da Shopee) —
   *  no app oficial aparece como anexo/faixa acima da mensagem; null = não é resposta. */
  quotedMessage: QuotedMessage | null
}

function messageListFromBody(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw =
    body.messages ??
    body.message_list ??
    (body.response && typeof body.response === 'object'
      ? (body.response as Record<string, unknown>).messages
      : undefined)
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
}

function messagePageNextOffset(body: Record<string, unknown>): string | null {
  const pageResult =
    body.page_result ??
    (body.response && typeof body.response === 'object'
      ? (body.response as Record<string, unknown>).page_result
      : undefined)
  if (!pageResult || typeof pageResult !== 'object') return null
  const next = (pageResult as Record<string, unknown>).next_offset
  if (next == null || next === '') return null
  return String(next)
}

function extractMessageImageUrl(msg: Record<string, unknown>, text: string): string | null {
  const content = msg.content
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>
    for (const key of ['url', 'image_url', 'thumb_url', 'imageUrl', 'thumbUrl']) {
      const raw = c[key]
      if (typeof raw === 'string' && /^https?:\/\//i.test(raw.trim())) return raw.trim()
    }
  }
  const type = String(msg.message_type ?? msg.type ?? '')
  if ((type === 'image' || type === 'sticker') && /^https?:\/\//i.test(text)) return text
  if (/^https?:\/\/img\.sp\.mms\.shopee/i.test(text)) return text
  return null
}

function extractMessageText(msg: Record<string, unknown>): string {
  const content = msg.content
  if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>
    if (typeof c.text === 'string' && c.text.trim()) return c.text.trim()
    if (typeof c.translation_text === 'string' && c.translation_text.trim()) return c.translation_text.trim()
    if (typeof c.url === 'string' && c.url.trim()) return c.url.trim()
  }
  const type = String(msg.message_type ?? msg.type ?? 'unknown')
  if (type === 'image' || type === 'sticker') return `[${type}]`
  if (type === 'text') return '(mensagem vazia)'
  return `[${type}]`
}

function parseMessageCreatedAt(msg: Record<string, unknown>): number | null {
  const raw =
    msg.created_timestamp ??
    msg.create_time ??
    msg.create_timestamp ??
    msg.message_timestamp ??
    msg.timestamp
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return n < 1e12 ? n * 1000 : n
}

/** `quoted_msg` vem no MESMO formato de uma mensagem inteira (message_type/content/from_id
 *  próprios) — só precisa de um resumo pra faixa de contexto, não o parse completo. */
function extractQuotedMessage(msg: Record<string, unknown>, buyerToId: number): QuotedMessage | null {
  const raw = msg.quoted_msg
  if (!raw || typeof raw !== 'object') return null
  const q = raw as Record<string, unknown>
  const text = extractMessageText(q)
  const fromId = Number(q.from_id ?? 0)
  return {
    id: String(q.message_id ?? q.id ?? '').trim(),
    text,
    imageUrl: extractMessageImageUrl(q, text),
    fromBuyer: fromId === buyerToId,
  }
}

export function parseChatMessage(
  msg: Record<string, unknown>,
  buyerToId: number,
): ParsedChatMessage | null {
  const fromId = Number(msg.from_id ?? msg.sender_id ?? 0)
  const toId = Number(msg.to_id ?? 0)
  const id = String(msg.message_id ?? msg.id ?? '').trim()
  if (!id) return null
  const type = String(msg.message_type ?? msg.type ?? 'text')
  const text = extractMessageText(msg)
  return {
    id,
    fromId,
    toId,
    type,
    text,
    imageUrl: extractMessageImageUrl(msg, text),
    createdAt: parseMessageCreatedAt(msg),
    fromBuyer: fromId === buyerToId,
    quotedMessage: extractQuotedMessage(msg, buyerToId),
  }
}

/** Histórico completo — pagina get_message até acabar (ou maxPages). */
export async function fetchAllChatMessages(
  conversationId: string,
  buyerToId: number,
  options: { pageSize?: number; maxPages?: number } = {},
): Promise<{ messages: ParsedChatMessage[]; pages: number; truncated: boolean }> {
  const pageSize = Math.min(Math.max(options.pageSize ?? 50, 1), 50)
  const maxPages = Math.min(Math.max(options.maxPages ?? 40, 1), 100)
  const byId = new Map<string, ParsedChatMessage>()
  let offset: string | undefined = ''
  let pages = 0

  while (pages < maxPages) {
    const data = await getMessageList({ conversationId, pageSize, offset })
    const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_message')
    const list = messageListFromBody(body)
    for (const row of list) {
      const parsed = parseChatMessage(row, buyerToId)
      if (parsed) byId.set(parsed.id, parsed)
    }
    pages++
    const next = messagePageNextOffset(body)
    if (!next || list.length === 0) break
    offset = next
  }

  const messages = [...byId.values()].sort((a, b) => {
    const ta = a.createdAt ?? 0
    const tb = b.createdAt ?? 0
    return ta - tb
  })
  return { messages, pages, truncated: pages >= maxPages }
}
