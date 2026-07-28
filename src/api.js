import { headersForWorkbook } from './shopee-workbook';
const API_BASE = '/api';
export class AuthRequiredError extends Error {
    constructor() {
        super('Login necessário');
    }
}
async function request(path, init = {}) {
    const response = await fetch(`${API_BASE}${path}`, {
        credentials: 'include',
        ...init,
        headers: {
            'Content-Type': 'application/json',
            ...(init.headers ?? {}),
        },
    });
    if (response.status === 401)
        throw new AuthRequiredError();
    if (!response.ok) {
        const detail = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(detail.error ?? `HTTP ${response.status}`);
    }
    return (await response.json());
}
export async function checkAuth() {
    try {
        await request('/me');
        return true;
    }
    catch (error) {
        if (error instanceof AuthRequiredError)
            return false;
        throw error;
    }
}
export async function login(username, password) {
    await request('/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
    });
}
export async function logout() {
    await request('/logout', { method: 'POST' });
}
/* ===========================================================
   Workbook CRUD
   =========================================================== */
export async function listWorkbooks() {
    return request('/workbooks');
}
export async function createWorkbook(name) {
    return request('/workbooks', {
        method: 'POST',
        body: JSON.stringify({ name }),
    });
}
export async function renameWorkbook(id, name) {
    return request(`/workbooks/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name }),
    });
}
export async function deleteWorkbook(id) {
    return request(`/workbooks/${encodeURIComponent(id)}`, {
        method: 'DELETE',
    });
}
export async function duplicateWorkbook(id, name) {
    return request(`/workbooks/${encodeURIComponent(id)}/duplicate`, {
        method: 'POST',
        body: JSON.stringify({ name }),
    });
}
/* ===========================================================
   Workbook data (orders/images) — scoped por workbookId
   =========================================================== */
export async function fetchWorkbook(workbookId, since) {
    const query = since != null ? `?since=${since}` : '';
    return request(`/workbooks/${encodeURIComponent(workbookId)}/data${query}`);
}
export async function replaceWorkbook(workbookId, payload) {
    return request(`/workbooks/${encodeURIComponent(workbookId)}/replace`, {
        method: 'POST',
        body: JSON.stringify(payload),
    });
}
export async function patchOrder(workbookId, orderId, patch) {
    return request(`/workbooks/${encodeURIComponent(workbookId)}/orders/${encodeURIComponent(orderId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
    });
}
export async function patchOrderDelta(workbookId, orderId, patch) {
    return request(`/workbooks/${encodeURIComponent(workbookId)}/orders/${encodeURIComponent(orderId)}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
    });
}
export async function uploadImage(workbookId, orderId, col, blob, fileName) {
    const body = new FormData();
    body.append('image', blob, fileName);
    const response = await fetch(`${API_BASE}/workbooks/${encodeURIComponent(workbookId)}/images/${encodeURIComponent(orderId)}/${col}`, {
        method: 'POST',
        credentials: 'include',
        body,
    });
    if (response.status === 401)
        throw new AuthRequiredError();
    if (!response.ok) {
        const detail = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(detail.error ?? `HTTP ${response.status}`);
    }
    return (await response.json());
}
export async function deleteImage(workbookId, orderId, col) {
    return request(`/workbooks/${encodeURIComponent(workbookId)}/images/${encodeURIComponent(orderId)}/${col}`, { method: 'DELETE' });
}
export async function deleteOrdersBySheetDate(workbookId, sheetDate) {
    return request(`/workbooks/${encodeURIComponent(workbookId)}/orders?sheetDate=${encodeURIComponent(sheetDate)}`, { method: 'DELETE' });
}
export async function syncShopeeWorkbook(days = 90, offsetDays = 0) {
    return request('/shopee/sync-workbook', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days, offsetDays }),
    });
}
/** Sincronização manual — mesma rotina do poll de 8h, sob demanda. */
export async function syncShopeeNow() {
    return request('/shopee/sync-now', { method: 'POST' });
}
/** Importação inicial parcelada — 1 request por dia para evitar timeout. */
export async function syncShopeeWorkbookInitial(totalDays = 5, onProgress) {
    const acc = { listed: 0, created: 0, updated: 0, errors: [] };
    for (let d = 0; d < totalDays; d++) {
        const r = await syncShopeeWorkbook(1, d);
        acc.listed += r.listed;
        acc.created += r.created;
        acc.updated += r.updated;
        acc.errors.push(...r.errors);
        onProgress?.(d + 1, totalDays, r);
    }
    return acc;
}
export async function linkShopeeConversations(workbookId, options = {}) {
    return request('/shopee/link-conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workbookId, ...options }),
    });
}
export async function linkShopeeConversationsScanChunk(workbookId, state) {
    return request('/shopee/link-conversations/scan-chunk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workbookId, ...state }),
    });
}
export async function fetchShopeeLinkBootstrap() {
    return request('/shopee/link-conversations/bootstrap');
}
export async function saveShopeeLinkStartCursor(nextTimestampNano) {
    return request('/shopee/link-conversations/start-cursor', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nextTimestampNano }),
    });
}
export async function fetchShopeeLinkStatus(workbookId) {
    const qs = new URLSearchParams({ workbookId });
    return request(`/shopee/link-conversations/status?${qs}`);
}
export async function clearShopeeBuyerChats(workbookId) {
    return request('/shopee/buyer-chats/clear', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workbookId }),
    });
}
export async function fetchLinkedBuyerUsernames() {
    const data = await request('/shopee/buyer-chats');
    return data.usernames ?? [];
}
export async function fetchShopeeChatHistory(username) {
    const qs = new URLSearchParams({ username });
    return request(`/shopee/chat-history?${qs}`);
}
export async function sendShopeeChatMessage(opts) {
    return request('/shopee/messages/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
    });
}
export async function sendShopeePreview(opts) {
    return request('/shopee/messages/send-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
    });
}
/** Manda uma mensagem inicial (ex. "Oi") pro comprador de um pedido sem chat vinculado
 * ainda — a Shopee cria a conversa na hora, sem precisar de contato prévio do comprador. */
export async function startShopeeConversation(opts) {
    return request('/shopee/messages/start-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
    });
}
export async function getOrderPieces(workbookId, orderKey) {
    return request(`/workbooks/${encodeURIComponent(workbookId)}/pieces/${encodeURIComponent(orderKey)}`);
}
/** Baixa e salva de verdade todas as fotos pendentes das peças do pedido — chamar ANTES
 * de marcar o status "Pronto" (botão "Confirmar pedido"). */
export async function confirmPiecesForOrder(workbookId, orderKey) {
    return request(`/workbooks/${encodeURIComponent(workbookId)}/pieces/${encodeURIComponent(orderKey)}/confirm`, { method: 'POST' });
}
export async function addOrderPiece(workbookId, orderKey) {
    return request(`/workbooks/${encodeURIComponent(workbookId)}/pieces/${encodeURIComponent(orderKey)}`, {
        method: 'POST',
    });
}
export async function updateOrderPiece(pieceId, patch) {
    return request(`/pieces/${pieceId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
}
export async function deleteOrderPiece(pieceId) {
    return request(`/pieces/${pieceId}`, { method: 'DELETE' });
}
export async function assignPiecePhoto(pieceId, slot, url) {
    return request(`/pieces/${pieceId}/photo/${slot}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
    });
}
/** Sobe uma foto de arquivo local (ex.: cliente mandou link do Drive, operador baixou
 * na mão e sobe aqui) — diferente de assignPiecePhoto (URL do chat), grava direto,
 * sem passar pelo estado "pendente". */
export async function uploadPiecePhoto(pieceId, slot, file) {
    const body = new FormData();
    body.append('image', file, file.name);
    const response = await fetch(`${API_BASE}/pieces/${pieceId}/photo/${slot}/upload`, {
        method: 'POST',
        credentials: 'include',
        body,
    });
    if (response.status === 401)
        throw new AuthRequiredError();
    if (!response.ok) {
        const detail = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(detail.error ?? `HTTP ${response.status}`);
    }
    return (await response.json());
}
export async function removePiecePhoto(pieceId, slot) {
    return request(`/pieces/${pieceId}/photo/${slot}`, { method: 'DELETE' });
}
/** Troca só o tipo de composição (recorte/silhueta vs coração) de uma foto já escolhida. */
export async function setPiecePhotoCrop(pieceId, slot, crop) {
    return request(`/pieces/${pieceId}/photo/${slot}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ crop }),
    });
}
/** Copia fotos (slots 1/2) + emoji1/emoji2 de `sourceId` pra `pieceId` — não mexe em
 * tipo/gênero/tamanho/cor (cada peça mantém o seu). */
export async function copyPieceFrom(pieceId, sourceId) {
    return request(`/pieces/${pieceId}/copy-from/${sourceId}`, { method: 'POST' });
}
export async function getEmojiCatalog(query) {
    const qs = query && query.trim() ? `?q=${encodeURIComponent(query.trim())}` : '';
    return request(`/emoji-catalog${qs}`);
}
export async function createCustomEmoji(file, name, aliases) {
    const body = new FormData();
    body.append('image', file, name);
    body.append('name', name);
    if (aliases && aliases.length)
        body.append('aliases', JSON.stringify(aliases));
    const response = await fetch(`${API_BASE}/emoji-catalog`, {
        method: 'POST',
        credentials: 'include',
        body,
    });
    if (response.status === 401)
        throw new AuthRequiredError();
    if (!response.ok) {
        const detail = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error(detail.error ?? `HTTP ${response.status}`);
    }
    return (await response.json());
}
export async function updateEmojiAliases(id, aliases) {
    return request(`/emoji-catalog/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aliases }),
    });
}
export async function deleteCustomEmoji(id) {
    return request(`/emoji-catalog/${id}`, { method: 'DELETE' });
}
/** Converte payload do servidor pra WorkbookData (formato que a grid usa) */
export function serverWorkbookToLocal(workbookId, server) {
    const rows = [];
    const rowKeys = [];
    const rowDates = [];
    const rowProductImages = [];
    const images = {};
    const cellStyles = {};
    const rowFlags = {};
    server.orders.forEach((order, idx) => {
        rows.push(order.row);
        rowKeys.push(order.key ?? order.id);
        rowDates.push(order.sheetDate ?? '');
        rowProductImages.push(order.productImageUrl ?? '');
        for (const [colKey, style] of Object.entries(order.styles ?? {})) {
            cellStyles[`${idx}:${colKey}`] = style;
        }
        if (order.disappeared)
            rowFlags[idx] = { disappeared: true };
        for (const img of order.images) {
            images[`${idx}:${img.col}`] = { url: img.url, fileName: img.fileName, updatedAt: img.updatedAt };
        }
    });
    const columnWidths = {};
    for (const [colKey, width] of Object.entries(server.columnWidths ?? {})) {
        columnWidths[Number(colKey)] = width;
    }
    const sheetId = `sheet-${workbookId}`;
    return {
        id: workbookId,
        name: server.name,
        importedAt: new Date(server.updatedAt).toISOString(),
        sheetOrder: [sheetId],
        sheets: {
            [sheetId]: {
                id: sheetId,
                name: server.name,
                headers: headersForWorkbook(workbookId, FIXED_HEADERS),
                rows,
                rowKeys,
                rowDates,
                rowProductImages,
                images,
                cellStyles,
                rowFlags,
                columnWidths,
            },
        },
    };
}
const FIXED_HEADERS = [
    'ID do pedido',
    'Nome do Produto',
    'Modelo',
    'Qnt.',
    'Nome de usuário',
    'Status',
    'Nome do destinatário',
    ...Array.from({ length: 10 }, (_, i) => `Foto ${i + 1}`),
];
