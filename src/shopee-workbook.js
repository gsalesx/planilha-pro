/** Layout da planilha automática Shopee — espelha server/src/shopee-columns.ts */
export const SHOPEE_WORKBOOK_ID = 'wb_shopee';
export const DEFAULT_PHOTO_COLUMN_INDEX = 7;
export const DEFAULT_PHOTO_COLUMN_INDICES = Array.from({ length: 10 }, (_, i) => DEFAULT_PHOTO_COLUMN_INDEX + i);
export const DEFAULT_MIN_COLUMN_COUNT = 17;
export const SHOPEE_PHOTO_COLUMN_START = 8;
export const SHOPEE_PHOTO_COLUMN_INDICES = Array.from({ length: 10 }, (_, i) => SHOPEE_PHOTO_COLUMN_START + i);
export const SHOPEE_MIN_COLUMN_COUNT = 18;
/** Coluna H — Status Shopee (READY_TO_SHIP, CANCELLED, ...). Espelha SHOPEE_COL_SHOPEE_STATUS no server. */
export const SHOPEE_STATUS_COLUMN_INDEX = 7;
/** Seletor rápido de status Shopee (dropdown, igual ao de data) — combina em AND com a data selecionada. */
export const SHOPEE_STATUS_FILTER_OPTIONS = [
    { value: '', label: 'Todos' },
    { value: 'UNPAID', label: 'Não pagos' },
    { value: 'READY_TO_SHIP', label: 'A enviar' },
    { value: 'PROCESSED', label: 'Enviado' },
    { value: 'TO_CONFIRM_RECEIVE', label: 'Aguardando confirmação' },
    { value: 'TO_RETURN', label: 'Retornando' },
    { value: 'CANCELLED', label: 'Cancelados' },
    { value: 'COMPLETED', label: 'Completos' },
];
/** Status padrão ao entrar na planilha Shopee — também define quais datas aparecem no quick-select. */
export const SHOPEE_DEFAULT_STATUS_FILTER = 'READY_TO_SHIP';
/**
 * "A enviar" precisa casar mais de 1 status da Shopee: READY_TO_SHIP (ainda não confirmado),
 * PROCESSED (pago/confirmado, mas ainda não postado — apesar do nome, não significa "enviado")
 * e IN_CANCEL (cancelamento em andamento — ainda aparece na fila de envio da Shopee).
 * Valores sem entrada aqui casam só consigo mesmo (ver `shopeeStatusMatchValues`).
 */
const SHOPEE_STATUS_FILTER_MATCH = {
    READY_TO_SHIP: ['READY_TO_SHIP', 'PROCESSED', 'IN_CANCEL'],
};
/** Valores de Status Shopee (coluna H) que um filtro do dropdown deve casar — alguns filtros
 * (ex. "A enviar") representam mais de 1 status real da Shopee. */
export function shopeeStatusMatchValues(filterValue) {
    return SHOPEE_STATUS_FILTER_MATCH[filterValue] ?? [filterValue];
}
export const SHOPEE_HEADERS = [
    'ID do pedido',
    'SKU',
    'Modelo',
    'Qnt.',
    'Nome de usuário',
    'Status',
    'Nome do destinatário',
    'Status Shopee',
    ...Array.from({ length: 10 }, (_, i) => `Foto ${i + 1}`),
];
export function isShopeeWorkbookId(id) {
    return id === SHOPEE_WORKBOOK_ID;
}
export function workbookLayout(workbookId) {
    if (isShopeeWorkbookId(workbookId)) {
        return { photoColumnIndices: [...SHOPEE_PHOTO_COLUMN_INDICES], minColumnCount: SHOPEE_MIN_COLUMN_COUNT };
    }
    return { photoColumnIndices: [...DEFAULT_PHOTO_COLUMN_INDICES], minColumnCount: DEFAULT_MIN_COLUMN_COUNT };
}
export function photoColumnIndicesForWorkbook(workbookId) {
    return workbookLayout(workbookId).photoColumnIndices;
}
export function headersForWorkbook(workbookId, standardHeaders) {
    return isShopeeWorkbookId(workbookId) ? SHOPEE_HEADERS : standardHeaders;
}
