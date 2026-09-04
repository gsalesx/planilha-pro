/**
 * Registro client-side dos workbooks automáticos de marketplace.
 * Espelha server/src/marketplace.ts + marketplace-columns.
 */

export type MarketplaceChannel = 'shopee' | 'tiktok' | 'mercadolivre'

export interface MarketplaceStatusFilterOption {
  value: string
  label: string
}

export interface MarketplaceWorkbookDef {
  id: string
  name: string
  channel: MarketplaceChannel
  statusHeader: string
  statusColumnIndex: number
  photoColumnStart: number
  photoCount: number
  minColumnCount: number
  defaultStatusFilter: string
  statusFilterOptions: MarketplaceStatusFilterOption[]
  /** Alguns filtros casam mais de 1 status real (ex. Shopee "A enviar"). */
  statusFilterMatch?: Record<string, string[]>
}

export const SHOPEE_WORKBOOK_ID = 'wb_shopee'
export const TIKTOK_WORKBOOK_ID = 'wb_tiktok'
export const MERCADOLIVRE_WORKBOOK_ID = 'wb_mercadolivre'

export const DEFAULT_PHOTO_COLUMN_INDEX = 7
export const DEFAULT_PHOTO_COLUMN_INDICES = Array.from({ length: 10 }, (_, i) => DEFAULT_PHOTO_COLUMN_INDEX + i)
export const DEFAULT_MIN_COLUMN_COUNT = 17

const MP_PHOTO_START = 8
const MP_PHOTO_COUNT = 10
const MP_STATUS_COL = 7
const MP_MIN_COLS = 18

const SHOPEE_STATUS_FILTER_OPTIONS: MarketplaceStatusFilterOption[] = [
  { value: '', label: 'Todos' },
  { value: 'UNPAID', label: 'Não pagos' },
  { value: 'READY_TO_SHIP', label: 'A enviar' },
  { value: 'PROCESSED', label: 'Enviado' },
  { value: 'TO_CONFIRM_RECEIVE', label: 'Aguardando confirmação' },
  { value: 'TO_RETURN', label: 'Retornando' },
  { value: 'CANCELLED', label: 'Cancelados' },
  { value: 'COMPLETED', label: 'Completos' },
]

const TIKTOK_STATUS_FILTER_OPTIONS: MarketplaceStatusFilterOption[] = [
  { value: '', label: 'Todos' },
  { value: 'UNPAID', label: 'Não pagos' },
  { value: 'ON_HOLD', label: 'Em espera' },
  { value: 'AWAITING_SHIPMENT', label: 'A enviar' },
  { value: 'AWAITING_COLLECTION', label: 'Aguardando coleta' },
  { value: 'IN_TRANSIT', label: 'Em trânsito' },
  { value: 'DELIVERED', label: 'Entregues' },
  { value: 'COMPLETED', label: 'Completos' },
  { value: 'CANCELLED', label: 'Cancelados' },
]

const ML_STATUS_FILTER_OPTIONS: MarketplaceStatusFilterOption[] = [
  { value: '', label: 'Todos' },
  { value: 'paid', label: 'Pagos' },
  { value: 'ready_to_ship', label: 'A enviar' },
  { value: 'shipped', label: 'Enviados' },
  { value: 'delivered', label: 'Entregues' },
  { value: 'cancelled', label: 'Cancelados' },
]

export const MARKETPLACE_WORKBOOKS: readonly MarketplaceWorkbookDef[] = [
  {
    id: SHOPEE_WORKBOOK_ID,
    name: 'Shopee — automática',
    channel: 'shopee',
    statusHeader: 'Status Shopee',
    statusColumnIndex: MP_STATUS_COL,
    photoColumnStart: MP_PHOTO_START,
    photoCount: MP_PHOTO_COUNT,
    minColumnCount: MP_MIN_COLS,
    defaultStatusFilter: 'READY_TO_SHIP',
    statusFilterOptions: SHOPEE_STATUS_FILTER_OPTIONS,
    statusFilterMatch: {
      READY_TO_SHIP: ['READY_TO_SHIP', 'PROCESSED', 'IN_CANCEL'],
    },
  },
  {
    id: TIKTOK_WORKBOOK_ID,
    name: 'TikTok — automática',
    channel: 'tiktok',
    statusHeader: 'Status TikTok',
    statusColumnIndex: MP_STATUS_COL,
    photoColumnStart: MP_PHOTO_START,
    photoCount: MP_PHOTO_COUNT,
    minColumnCount: MP_MIN_COLS,
    defaultStatusFilter: 'AWAITING_SHIPMENT',
    statusFilterOptions: TIKTOK_STATUS_FILTER_OPTIONS,
  },
  {
    id: MERCADOLIVRE_WORKBOOK_ID,
    name: 'Mercado Livre — automática',
    channel: 'mercadolivre',
    statusHeader: 'Status Mercado Livre',
    statusColumnIndex: MP_STATUS_COL,
    photoColumnStart: MP_PHOTO_START,
    photoCount: MP_PHOTO_COUNT,
    minColumnCount: MP_MIN_COLS,
    defaultStatusFilter: 'ready_to_ship',
    statusFilterOptions: ML_STATUS_FILTER_OPTIONS,
    // Col H grava "order.status/shipment.status" (ex. paid/ready_to_ship).
    // O filtro casa o valor completo — não só o token isolado.
    statusFilterMatch: {
      paid: ['paid', 'paid/pending', 'paid/handling'],
      ready_to_ship: [
        'ready_to_ship',
        'paid/ready_to_ship',
        'paid/ready_to_print',
      ],
      shipped: ['shipped', 'paid/shipped'],
      delivered: ['delivered', 'paid/delivered'],
      cancelled: ['cancelled', 'cancelled/cancelled'],
    },
  },
] as const

const BY_ID = new Map(MARKETPLACE_WORKBOOKS.map((w) => [w.id, w]))

export function isMarketplaceWorkbookId(id: string): boolean {
  return BY_ID.has(id)
}

export function isShopeeWorkbookId(id: string): boolean {
  return id === SHOPEE_WORKBOOK_ID
}

export function channelOfWorkbook(id: string): MarketplaceChannel | null {
  return BY_ID.get(id)?.channel ?? null
}

export function marketplaceDef(id: string): MarketplaceWorkbookDef | undefined {
  return BY_ID.get(id)
}

export function marketplaceStatusMatchValues(workbookId: string, filterValue: string): string[] {
  const def = BY_ID.get(workbookId)
  if (!def || !filterValue) return filterValue ? [filterValue] : []
  return def.statusFilterMatch?.[filterValue] ?? [filterValue]
}

export function marketplaceHeaders(statusHeader: string): string[] {
  return [
    'ID do pedido',
    'SKU',
    'Modelo',
    'Qnt.',
    'Nome de usuário',
    'Status',
    'Nome do destinatário',
    statusHeader,
    ...Array.from({ length: MP_PHOTO_COUNT }, (_, i) => `Foto ${i + 1}`),
  ]
}

export interface WorkbookLayout {
  photoColumnIndices: number[]
  minColumnCount: number
}

export function workbookLayout(workbookId: string): WorkbookLayout {
  const def = BY_ID.get(workbookId)
  if (def) {
    return {
      photoColumnIndices: Array.from({ length: def.photoCount }, (_, i) => def.photoColumnStart + i),
      minColumnCount: def.minColumnCount,
    }
  }
  return { photoColumnIndices: [...DEFAULT_PHOTO_COLUMN_INDICES], minColumnCount: DEFAULT_MIN_COLUMN_COUNT }
}

export function photoColumnIndicesForWorkbook(workbookId: string): number[] {
  return workbookLayout(workbookId).photoColumnIndices
}

export function headersForWorkbook(workbookId: string, standardHeaders: string[]): string[] {
  const def = BY_ID.get(workbookId)
  return def ? marketplaceHeaders(def.statusHeader) : standardHeaders
}
