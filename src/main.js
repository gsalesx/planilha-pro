import './style.css';
import { AuthRequiredError, checkAuth, createWorkbook, deleteImage, deleteOrdersBySheetDate, fetchWorkbook, logout, patchOrderDelta, replaceWorkbook, serverWorkbookToLocal, linkShopeeConversationsScanChunk, fetchLinkedBuyerUsernames, fetchShopeeLinkStatus, clearShopeeBuyerChats, uploadImage, sendShopeePreview, startShopeeConversation, } from './api';
import { openAlertDialog, openCalendarPickerDialog, openConfirmDialog, openPreviewPickerDialog, openTextareaDialog, } from './dialog';
import { GridView, MODEL_COLUMN_INDEX, RECIPIENT_COLUMN_INDEX, } from './grid';
import { showLoginScreen } from './login';
import { formatHitRef, highlightMatch, searchWorkbook } from './search';
import { STATUS_COLUMN_INDEX, PREVIEW_SENT_STATUS } from './status';
import { showWorkbooksList } from './workbooks-list';
import { isShopeeWorkbookId, SHOPEE_DEFAULT_STATUS_FILTER, SHOPEE_STATUS_COLUMN_INDEX, SHOPEE_STATUS_FILTER_OPTIONS, shopeeStatusMatchValues, } from './shopee-workbook';
import { openShopeeChatPanel } from './shopee-chat-panel';
import { FIXED_HEADERS, parseXlsx } from './xlsx-parser';
const POLL_INTERVAL_MS = 8000;
const ID_COL = 0;
const PRODUCT_COL = 1;
const QTY_COL = 3;
const BUYER_USERNAME_COL = 4;
let workbook = null;
let grid;
let serverUpdatedAt = 0;
let pollTimer = null;
let searchTimer = null;
let lastSearchHits = [];
let searchHighlightIndex = -1;
let currentWorkbookId = null;
function el(selector) {
    const node = document.querySelector(selector);
    if (!node)
        throw new Error(`Elemento não encontrado: ${selector}`);
    return node;
}
function buildShell() {
    const app = el('#app');
    app.innerHTML = `
    <div class="app">
      <header class="app-header">
        <button class="btn btn-back" id="back-btn" title="Voltar para Minhas planilhas">← Voltar</button>
        <h1>Planilha Pro</h1>
        <span class="filename" id="filename">Relatórios</span>
        <div class="search-box">
          <span class="search-icon">⌕</span>
          <input id="search-input" type="search" placeholder="Buscar em toda a planilha..." autocomplete="off" />
          <span class="search-count" id="search-count" hidden></span>
          <div class="search-results" id="search-results" hidden></div>
        </div>
        <div class="toolbar-actions">
          <label class="btn btn-primary" id="xlsx-update-label" title="Carrega um novo XLSX preservando edições manuais por ID do pedido">
            <input type="file" id="file-input" accept=".xlsx,.xls" hidden />
            ⟳ Atualizar Planilha
          </label>
          <label class="btn" id="xlsx-photos-label" title="Atualiza só as fotos a partir de um XLSX, casando por ID do pedido. Pedidos sem match são ignorados.">
            <input type="file" id="photos-input" accept=".xlsx,.xls" hidden />
            🖼 Atualizar Fotos
          </label>
          <button type="button" class="btn btn-primary" id="shopee-link-conversations-btn" hidden title="Cruza username da col E com to_name do chat Shopee e grava conversation_id (não altera a planilha)">
            💬 Vincular conversas Shopee
          </button>
          <button type="button" class="btn" id="baixar-aprovados-data-btn" hidden title="Gera e baixa as artes dos pedidos Aprovado da data selecionada">
            ⬇ Baixar aprovados (data)
          </button>
          <button type="button" class="btn" id="baixar-aprovados-todos-btn" hidden title="Gera e baixa as artes de TODOS os pedidos Aprovado, de todas as datas (substitui a Remessa manual)">
            ⬇ Baixar todos aprovados
          </button>
          <button class="btn" id="logout-btn" title="Sair">Sair</button>
        </div>
      </header>
      <div id="shopee-action-banner" class="shopee-action-banner" hidden role="status" aria-live="polite"></div>
      <div class="etiqueta-bar" role="toolbar" aria-label="Etiquetas">
        <span id="selection-count" style="font-size:12px;color:#475569;font-weight:600;">1 linha selecionada</span>
        <button type="button" class="pending-mutations-btn" id="pending-mutations-btn" hidden>Pendências: 0</button>
        <span style="margin-right:auto"></span>
        <div class="zoom-controls" role="group" aria-label="Zoom da planilha">
          <button type="button" class="zoom-btn" id="zoom-out" title="Diminuir zoom" aria-label="Diminuir zoom">−</button>
          <span class="zoom-display" id="zoom-display">100%</span>
          <button type="button" class="zoom-btn" id="zoom-in" title="Aumentar zoom" aria-label="Aumentar zoom">+</button>
        </div>
        <span class="etiqueta-bar-divider" aria-hidden="true"></span>
        <div class="date-select-wrap" id="shopee-status-filter-wrap" hidden>
          <label class="date-select-label" for="shopee-status-select">Status:</label>
          <select class="date-select" id="shopee-status-select"></select>
        </div>
        <div class="date-select-wrap" id="date-select-wrap" hidden>
          <label class="date-select-label" for="date-select">Data:</label>
          <select class="date-select" id="date-select"></select>
          <button type="button" class="date-delete-btn" id="date-delete-btn" title="Apagar todos os pedidos desta data" aria-label="Apagar data">🗑</button>
        </div>
        <span class="etiqueta-bar-divider" aria-hidden="true"></span>
        <span class="etiqueta-bar-label">Etiqueta:</span>
        <button class="etiqueta-btn" data-bg="#93c5fd" title="Marcar como Etiqueta">
          <span class="etiqueta-dot" style="background:#93c5fd"></span>Etiqueta
        </button>
        <button class="etiqueta-btn" data-bg="#fde047" title="Marcar como Faltando">
          <span class="etiqueta-dot" style="background:#fde047"></span>Faltando
        </button>
        <button class="etiqueta-btn" data-bg="#86efac" title="Marcar como Correto">
          <span class="etiqueta-dot" style="background:#86efac"></span>Correto
        </button>
        <button class="etiqueta-btn" data-bg="#fca5a5" title="Marcar como Erro">
          <span class="etiqueta-dot" style="background:#fca5a5"></span>Erro
        </button>
        <button class="etiqueta-btn" data-bg="#c084fc" title="Marcar como Conjuntos">
          <span class="etiqueta-dot" style="background:#c084fc"></span>Conjuntos
        </button>
        <button class="etiqueta-btn etiqueta-clear" data-bg="" title="Remover etiqueta">
          <span class="etiqueta-dot etiqueta-dot-empty"></span>Limpar
        </button>
      </div>
      <div class="sheet-wrap" id="sheet-root"></div>
      <div class="status-bar">
        <span id="status-text">Pronto</span>
        <span class="spacer"></span>
        <span id="status-counts"></span>
      </div>
    </div>
  `;
}
function setStatusText(text) {
    el('#status-text').textContent = text;
}
function setToolbarBtnVisible(node, visible) {
    if (!node)
        return;
    node.hidden = !visible;
    node.style.display = visible ? '' : 'none';
}
function setShopeeActionBanner(message, tone) {
    const banner = document.querySelector('#shopee-action-banner');
    if (!banner)
        return;
    if (tone === 'hidden') {
        banner.hidden = true;
        banner.textContent = '';
        delete banner.dataset.tone;
        return;
    }
    banner.hidden = false;
    banner.dataset.tone = tone;
    banner.textContent = message;
}
function setFilename(text) {
    el('#filename').textContent = text;
}
function renderSheetLoading() {
    grid.setLoading(true);
}
function stopSheetLoading() {
    grid.setLoading(false);
}
function updateStatusCounts() {
    const sheet = grid.getActiveSheet();
    const target = el('#status-counts');
    if (!sheet) {
        target.textContent = '';
        return;
    }
    const visible = grid.getVisibleRowCount();
    const total = sheet.rows.length;
    target.textContent = visible === total ? `${total} pedidos` : `${visible} de ${total} pedidos`;
}
const PENDING_MUTATIONS_KEY_PREFIX = 'planilha-pro-pending-mutations';
function pendingMutationsKey(workbookId = currentWorkbookId) {
    return workbookId ? `${PENDING_MUTATIONS_KEY_PREFIX}:${workbookId}` : null;
}
function readPendingMutations() {
    const key = pendingMutationsKey();
    if (!key)
        return [];
    try {
        const parsed = JSON.parse(localStorage.getItem(key) ?? '[]');
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
function writePendingMutations(items) {
    const key = pendingMutationsKey();
    if (!key)
        return;
    try {
        localStorage.setItem(key, JSON.stringify(items));
    }
    catch {
        // Se o navegador bloquear storage, ainda mantemos a UI funcionando.
    }
    updatePendingMutationsButton();
}
function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return String(error || 'Erro desconhecido');
}
function addPendingMutation(input) {
    if (!currentWorkbookId)
        return;
    const items = readPendingMutations();
    items.unshift({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        workbookId: currentWorkbookId,
        kind: input.kind,
        orderId: input.orderId,
        rowIndex: input.rowIndex,
        col: input.col,
        sheetDate: input.sheetDate,
        description: input.description,
        error: errorMessage(input.error),
        createdAt: Date.now(),
    });
    writePendingMutations(items.slice(0, 50));
}
function removePendingMutation(id) {
    writePendingMutations(readPendingMutations().filter((item) => item.id !== id));
}
function updatePendingMutationsButton() {
    const button = document.querySelector('#pending-mutations-btn');
    if (!button)
        return;
    const count = readPendingMutations().length;
    button.hidden = count === 0;
    button.textContent = `Pendências: ${count}`;
}
function navigateToPendingMutation(item) {
    if (!workbook)
        return;
    const sheetId = workbook.sheetOrder[0];
    const sheet = workbook.sheets[sheetId];
    if (!sheet)
        return;
    const rowIndex = sheet.rows.findIndex((row) => String(row[ID_COL] ?? '').trim() === item.orderId);
    if (rowIndex < 0) {
        setStatusText('Pedido da pendência não está na planilha atual');
        return;
    }
    const sheetDate = sheet.rowDates?.[rowIndex];
    if (sheetDate && grid.getDateFilter() !== sheetDate) {
        grid.setDateFilter(sheetDate);
        setUrlDate(sheetDate);
        renderDateSelect();
    }
    grid.navigateTo(sheetId, rowIndex, item.col);
    setStatusText('Pendência localizada');
}
function openPendingMutationsPanel() {
    const items = readPendingMutations();
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
    <div class="modal-card pending-mutations-panel" role="dialog" aria-modal="true" aria-labelledby="pending-mutations-title">
      <h2 id="pending-mutations-title">Pendências locais</h2>
      <p>Alterações que falharam neste navegador para conferência.</p>
      <div class="pending-mutations-list">
        ${items.length === 0 ? '<div class="pending-mutations-empty">Nenhuma pendência.</div>' : items.map((item) => `
          <div class="pending-mutations-item" data-id="${escapeHtml(item.id)}">
            <div>
              <strong>${escapeHtml(item.description)}</strong>
              <span>Pedido ${escapeHtml(item.orderId)} · coluna ${item.col + 1}</span>
              <small>${new Date(item.createdAt).toLocaleString('pt-BR')} · ${escapeHtml(item.error)}</small>
            </div>
            <div class="pending-mutations-actions">
              <button type="button" class="btn pending-go">Ir para célula</button>
              <button type="button" class="btn pending-remove">Remover</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="modal-actions">
        <button type="button" class="btn btn-primary pending-close">Fechar</button>
      </div>
    </div>
  `;
    const close = () => overlay.remove();
    overlay.addEventListener('click', (event) => {
        if (event.target === overlay)
            close();
    });
    overlay.querySelector('.pending-close')?.addEventListener('click', close);
    overlay.querySelectorAll('.pending-mutations-item').forEach((node) => {
        const id = node.dataset.id;
        const item = items.find((entry) => entry.id === id);
        if (!id || !item)
            return;
        node.querySelector('.pending-go')?.addEventListener('click', () => {
            close();
            navigateToPendingMutation(item);
        });
        node.querySelector('.pending-remove')?.addEventListener('click', () => {
            removePendingMutation(id);
            node.remove();
            if (readPendingMutations().length === 0)
                close();
        });
    });
    document.body.appendChild(overlay);
}
function bindPendingMutationsButton() {
    el('#pending-mutations-btn').addEventListener('click', openPendingMutationsPanel);
    updatePendingMutationsButton();
}
/* ===========================================================
   Zoom da planilha
   =========================================================== */
const ZOOM_KEY = 'planilha-zoom';
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2.4;
const ZOOM_STEP = 0.1;
let currentZoom = 1;
function loadZoom() {
    const raw = localStorage.getItem(ZOOM_KEY);
    if (!raw)
        return;
    const v = parseFloat(raw);
    if (Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX)
        currentZoom = v;
}
function applyZoom() {
    document.documentElement.style.setProperty('--sheet-zoom', String(currentZoom));
    try {
        localStorage.setItem(ZOOM_KEY, String(currentZoom));
    }
    catch {
        // ignore (modo privado, etc)
    }
    const display = document.querySelector('#zoom-display');
    if (display)
        display.textContent = `${Math.round(currentZoom * 100)}%`;
    const zoomOut = document.querySelector('#zoom-out');
    const zoomIn = document.querySelector('#zoom-in');
    if (zoomOut)
        zoomOut.disabled = currentZoom <= ZOOM_MIN + 1e-6;
    if (zoomIn)
        zoomIn.disabled = currentZoom >= ZOOM_MAX - 1e-6;
}
function clampZoom(v) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 10) / 10));
}
function bindZoomControls() {
    el('#zoom-out').addEventListener('click', () => {
        currentZoom = clampZoom(currentZoom - ZOOM_STEP);
        applyZoom();
    });
    el('#zoom-in').addEventListener('click', () => {
        currentZoom = clampZoom(currentZoom + ZOOM_STEP);
        applyZoom();
    });
    applyZoom();
}
const WEEKDAY_FMT = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' });
function parseSheetDate(raw) {
    // Aceita DD-MM-YYYY (formato novo), DD_MM_YYYY e YYYY_MM_DD (legados).
    let m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw);
    if (m)
        return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    m = /^(\d{2})_(\d{2})_(\d{4})$/.exec(raw);
    if (m)
        return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
    m = /^(\d{4})_(\d{2})_(\d{2})/.exec(raw);
    if (m)
        return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return null;
}
function sortDates(dates) {
    return [...dates].sort((a, b) => {
        const da = parseSheetDate(a)?.getTime() ?? 0;
        const db = parseSheetDate(b)?.getTime() ?? 0;
        return da - db;
    });
}
/** Sempre exibe DD-MM-YYYY Dia mesmo pra dados antigos salvos com underscores. */
function formatDateForDisplay(raw) {
    const date = parseSheetDate(raw);
    if (!date || Number.isNaN(date.getTime()))
        return raw;
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    const weekday = WEEKDAY_FMT.format(date).replace(/\.$/, '');
    const weekdayLabel = weekday.charAt(0).toUpperCase() + weekday.slice(1);
    return `${dd}-${mm}-${yyyy} ${weekdayLabel}`;
}
function formatDateForUrl(raw) {
    const date = parseSheetDate(raw);
    if (!date || Number.isNaN(date.getTime()))
        return raw;
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const yyyy = date.getFullYear();
    return `${dd}-${mm}-${yyyy}`;
}
function getUrlDate() {
    const raw = new URLSearchParams(location.search).get('date')?.trim();
    return raw ? formatDateForUrl(raw) : null;
}
function setUrlDate(date) {
    const url = new URL(location.href);
    if (date)
        url.searchParams.set('date', formatDateForUrl(date));
    else
        url.searchParams.delete('date');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
function applyUrlDateFilter() {
    const requested = getUrlDate();
    if (!requested)
        return;
    const match = grid.getAvailableDates().find((d) => formatDateForUrl(d) === requested);
    if (!match) {
        setUrlDate(null);
        return;
    }
    if (grid.getDateFilter() !== match)
        grid.setDateFilter(match);
    setUrlDate(match);
}
function getUrlWorkbookId() {
    const raw = new URLSearchParams(location.search).get('workbook')?.trim();
    return raw || null;
}
function setUrlWorkbookId(workbookId) {
    const url = new URL(location.href);
    if (workbookId) {
        url.searchParams.set('workbook', workbookId);
    }
    else {
        url.searchParams.delete('workbook');
        url.searchParams.delete('date');
        url.searchParams.delete('modelo');
        url.searchParams.delete('status');
        url.searchParams.delete('sort');
    }
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
function getUrlGridViewState() {
    const params = new URLSearchParams(location.search);
    const filters = [];
    const modelos = params.getAll('modelo');
    const statuses = params.getAll('status');
    if (modelos.length > 0)
        filters.push({ col: MODEL_COLUMN_INDEX, values: modelos });
    if (statuses.length > 0)
        filters.push({ col: STATUS_COLUMN_INDEX, values: statuses });
    const sortRaw = params.get('sort');
    const sortMatch = /^(\d+):(asc|desc)$/.exec(sortRaw ?? '');
    return {
        filters,
        sort: sortMatch
            ? { col: Number(sortMatch[1]), dir: sortMatch[2] }
            : null,
    };
}
function setUrlGridViewState(state) {
    const url = new URL(location.href);
    url.searchParams.delete('modelo');
    url.searchParams.delete('status');
    url.searchParams.delete('sort');
    for (const filter of state.filters) {
        const param = filter.col === MODEL_COLUMN_INDEX
            ? 'modelo'
            : filter.col === STATUS_COLUMN_INDEX
                ? 'status'
                : null;
        if (!param)
            continue;
        for (const value of filter.values)
            url.searchParams.append(param, value);
    }
    if (state.sort)
        url.searchParams.set('sort', `${state.sort.col}:${state.sort.dir}`);
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}
function applyUrlGridViewState() {
    grid.setViewState(getUrlGridViewState());
    setUrlGridViewState(grid.getViewState());
}
const CUSTOM_DATE_VALUE = '__custom__';
function renderDateSelect() {
    const wrap = el('#date-select-wrap');
    const select = el('#date-select');
    const deleteBtn = el('#date-delete-btn');
    const allDates = grid.getAvailableDates();
    if (allDates.length === 0) {
        wrap.hidden = true;
        select.innerHTML = '';
        setUrlDate(null);
        return;
    }
    wrap.hidden = false;
    const active = grid.getDateFilter();
    const isShopee = isShopeeWorkbookId(currentWorkbookId ?? '');
    if (!isShopee) {
        const sorted = sortDates(allDates);
        select.innerHTML = sorted
            .map((d) => `<option value="${d}"${d === active ? ' selected' : ''}>${formatDateForDisplay(d)}</option>`)
            .join('');
        select.onchange = () => {
            grid.setDateFilter(select.value);
            setUrlDate(select.value);
            updateStatusCounts();
        };
    }
    else {
        // Quick-list: só datas com pedido "a enviar" (READY_TO_SHIP) + a data ativa (se for outra,
        // ex.: chegou via busca/pendência) + "Personalizado" abrindo o calendário com TODAS as datas.
        const readyDates = sortDates(grid.getAvailableDatesForColumnValue(SHOPEE_STATUS_COLUMN_INDEX, shopeeStatusMatchValues(SHOPEE_DEFAULT_STATUS_FILTER)));
        const quickDates = active && !readyDates.includes(active) ? sortDates([...readyDates, active]) : readyDates;
        select.innerHTML =
            quickDates
                .map((d) => `<option value="${d}"${d === active ? ' selected' : ''}>${formatDateForDisplay(d)}</option>`)
                .join('') + `<option value="${CUSTOM_DATE_VALUE}">Personalizado…</option>`;
        select.onchange = () => {
            if (select.value === CUSTOM_DATE_VALUE) {
                select.value = active ?? '';
                openCalendarPickerDialog({
                    title: 'Escolher data',
                    availableDates: sortDates(allDates),
                    initialDate: active,
                    onSelect: (date) => {
                        grid.setDateFilter(date);
                        setUrlDate(date);
                        updateStatusCounts();
                        renderDateSelect();
                    },
                });
                return;
            }
            grid.setDateFilter(select.value);
            setUrlDate(select.value);
            updateStatusCounts();
        };
    }
    deleteBtn.onclick = () => {
        const date = grid.getDateFilter();
        if (!date || !currentWorkbookId)
            return;
        const sheet = grid.getActiveSheet();
        const count = (sheet?.rowDates ?? []).filter((d) => d === date).length;
        openConfirmDialog({
            title: `Apagar data ${formatDateForDisplay(date)}?`,
            body: `Vai apagar <strong>${count} pedido${count === 1 ? '' : 's'}</strong> desta data (e suas fotos). A data sai do seletor. Esta ação não pode ser desfeita.`,
            confirmLabel: 'Apagar',
            danger: true,
            onConfirm: async () => {
                setStatusText(`Apagando data ${date}...`);
                try {
                    const result = await deleteOrdersBySheetDate(currentWorkbookId, date);
                    await refreshFromServer({ force: true });
                    setStatusText(`Data ${date} apagada (${result.deleted} pedidos removidos)`);
                }
                catch (error) {
                    handleApiError(error, 'Falha ao apagar data');
                }
            },
        });
    };
}
/** Vale só na planilha Shopee — sobrevive ao grid.setWorkbook() (limpa filtros a cada poll). */
let currentShopeeStatusFilter = SHOPEE_DEFAULT_STATUS_FILTER;
/** true depois que a data padrão (1º dia "a enviar") já foi aplicada nesta sessão de enterWorkbook. */
let shopeeDateDefaultApplied = false;
function renderShopeeStatusSelect() {
    const wrap = el('#shopee-status-filter-wrap');
    const select = el('#shopee-status-select');
    if (!isShopeeWorkbookId(currentWorkbookId ?? '')) {
        wrap.hidden = true;
        return;
    }
    wrap.hidden = false;
    select.innerHTML = SHOPEE_STATUS_FILTER_OPTIONS.map((opt) => `<option value="${opt.value}"${opt.value === currentShopeeStatusFilter ? ' selected' : ''}>${opt.label}</option>`).join('');
    select.onchange = () => {
        currentShopeeStatusFilter = select.value;
        grid.setColumnFilter(SHOPEE_STATUS_COLUMN_INDEX, currentShopeeStatusFilter ? shopeeStatusMatchValues(currentShopeeStatusFilter) : null);
        updateStatusCounts();
    };
    // Reaplica após poll/applyUrlGridViewState — o dropdown sozinho não restaura o filtro na grid.
    grid.setColumnFilter(SHOPEE_STATUS_COLUMN_INDEX, currentShopeeStatusFilter ? shopeeStatusMatchValues(currentShopeeStatusFilter) : null);
}
function getOrderId(rowIndex) {
    if (!workbook)
        return null;
    const sheet = workbook.sheets[workbook.sheetOrder[0]];
    const id = sheet?.rows[rowIndex]?.[ID_COL];
    return id == null ? null : String(id).trim() || null;
}
function getOrderKey(rowIndex) {
    if (!workbook)
        return null;
    const sheet = workbook.sheets[workbook.sheetOrder[0]];
    return sheet?.rowKeys?.[rowIndex] ?? getOrderId(rowIndex);
}
async function handleCellChange(changes) {
    if (!workbook || !currentWorkbookId || changes.length === 0)
        return;
    const sheetId = grid.getActiveSheetId();
    if (!sheetId)
        return;
    const sheet = workbook.sheets[sheetId];
    if (!sheet)
        return;
    const byRow = new Map();
    for (const { row, col, value } of changes) {
        if (!sheet.rows[row])
            sheet.rows[row] = [];
        sheet.rows[row][col] = value;
        const list = byRow.get(row) ?? [];
        list.push({ col, value });
        byRow.set(row, list);
    }
    grid.render();
    await Promise.all([...byRow.entries()].map(([row, cells]) => enqueueMutation(async () => {
        if (!workbook || !currentWorkbookId)
            return;
        const orderKey = getOrderKey(row);
        const orderId = getOrderId(row) ?? orderKey;
        if (!orderKey)
            return;
        try {
            const result = await patchOrderDelta(currentWorkbookId, orderKey, { cells });
            serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt);
            setStatusText('Alteração salva');
        }
        catch (error) {
            addPendingMutation({
                kind: 'cell',
                orderId: orderId ?? '',
                rowIndex: row,
                col: cells[0]?.col ?? 0,
                sheetDate: sheet.rowDates?.[row] ?? '',
                description: `Alteração em ${cells.length} célula${cells.length === 1 ? '' : 's'}`,
                error,
            });
            handleApiError(error, 'Falha ao salvar alteração');
        }
    })));
}
function handleSelect(_ref, _value, count) {
    el('#selection-count').textContent =
        `${count} linha${count === 1 ? '' : 's'} selecionada${count === 1 ? '' : 's'}`;
}
async function handleEtiqueta(color) {
    if (!workbook || !currentWorkbookId)
        return;
    const sel = grid.getSelection();
    if (!sel)
        return;
    const rows = getCurrentSelectedRows();
    const col = sel.col;
    const stylePatch = color ? { col, bg: color } : { col, clearBg: true };
    grid.applyCellBackground(color);
    const sheet = workbook.sheets[workbook.sheetOrder[0]];
    await Promise.all(rows.map((row) => enqueueMutation(async () => {
        if (!workbook || !currentWorkbookId)
            return;
        const orderKey = getOrderKey(row);
        const orderId = getOrderId(row) ?? orderKey;
        if (!orderKey)
            return;
        try {
            const result = await patchOrderDelta(currentWorkbookId, orderKey, { stylePatches: [stylePatch] });
            serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt);
            setStatusText('Etiqueta salva');
        }
        catch (error) {
            addPendingMutation({
                kind: 'style',
                orderId: orderId ?? '',
                rowIndex: row,
                col,
                sheetDate: sheet?.rowDates?.[row] ?? '',
                description: color ? 'Aplicar etiqueta' : 'Limpar etiqueta',
                error,
            });
            handleApiError(error, 'Falha ao salvar etiqueta');
        }
    })));
}
function handleCommentRequest(row, col) {
    if (!workbook || !currentWorkbookId || col !== RECIPIENT_COLUMN_INDEX)
        return;
    const sheet = workbook.sheets[workbook.sheetOrder[0]];
    if (!sheet)
        return;
    const key = `${row}:${col}`;
    const current = sheet.cellStyles?.[key]?.comment ?? '';
    openTextareaDialog({
        title: 'Comentário do destinatário',
        label: 'Comentário',
        defaultValue: current,
        confirmLabel: 'Salvar',
        onConfirm: async (value) => {
            const next = value.trim();
            const stylePatch = next ? { col, comment: next } : { col, clearComment: true };
            sheet.cellStyles ||= {};
            if (next) {
                sheet.cellStyles[key] = { ...(sheet.cellStyles[key] ?? {}), comment: next };
            }
            else {
                const style = sheet.cellStyles[key];
                if (style) {
                    delete style.comment;
                    if (Object.keys(style).length === 0)
                        delete sheet.cellStyles[key];
                }
            }
            grid.render();
            await enqueueMutation(async () => {
                if (!workbook || !currentWorkbookId)
                    return;
                const orderKey = getOrderKey(row);
                const orderId = getOrderId(row) ?? orderKey;
                if (!orderKey)
                    return;
                try {
                    const result = await patchOrderDelta(currentWorkbookId, orderKey, { stylePatches: [stylePatch] });
                    serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt);
                    setStatusText('Comentário salvo');
                }
                catch (error) {
                    addPendingMutation({
                        kind: 'comment',
                        orderId: orderId ?? '',
                        rowIndex: row,
                        col,
                        sheetDate: sheet.rowDates?.[row] ?? '',
                        description: next ? 'Salvar comentário' : 'Limpar comentário',
                        error,
                    });
                    handleApiError(error, 'Falha ao salvar comentário');
                }
            });
        },
    });
}
function cellText(row, col) {
    const v = row[col];
    return v == null ? '' : String(v).trim();
}
async function refreshLinkedBuyerChats() {
    if (!grid)
        return;
    try {
        const usernames = await fetchLinkedBuyerUsernames();
        grid.setLinkedChatUsernames(usernames);
    }
    catch {
        grid.setLinkedChatUsernames([]);
    }
}
function listPreviewPhotoCols(sheet, row) {
    const cols = grid?.getPhotoColumnIndices() ?? [];
    return cols.filter((col) => Boolean(sheet.images[`${row}:${col}`]));
}
async function sendPreviewForRow(row, photoCol) {
    if (!workbook || !currentWorkbookId || !grid)
        return;
    const sheet = workbook.sheets[workbook.sheetOrder[0]];
    if (!sheet)
        return;
    const orderKey = getOrderKey(row);
    if (!orderKey) {
        openAlertDialog({ title: 'Enviar prévia', body: 'Pedido sem ID.' });
        return;
    }
    const workbookId = currentWorkbookId;
    const buyerUsername = cellText(sheet.rows[row] ?? [], BUYER_USERNAME_COL);
    if (!buyerUsername)
        return;
    setStatusText('Enviando prévia...');
    try {
        await withPollingPaused(async () => {
            await sendShopeePreview({
                username: buyerUsername,
                workbookId,
                orderKey,
                col: photoCol,
            });
        });
        if (!sheet.rows[row])
            sheet.rows[row] = [];
        sheet.rows[row][STATUS_COLUMN_INDEX] = PREVIEW_SENT_STATUS;
        grid.render();
        await enqueueMutation(async () => {
            if (!currentWorkbookId)
                return;
            const result = await patchOrderDelta(currentWorkbookId, orderKey, {
                cells: [{ col: STATUS_COLUMN_INDEX, value: PREVIEW_SENT_STATUS }],
            });
            serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt);
            setStatusText('Prévia enviada');
        });
    }
    catch (error) {
        handleApiError(error, 'Falha ao enviar prévia');
        throw error;
    }
}
function handlePreviewRequest(row, col) {
    if (!workbook || col !== RECIPIENT_COLUMN_INDEX)
        return;
    const sheet = workbook.sheets[workbook.sheetOrder[0]];
    if (!sheet)
        return;
    const cells = sheet.rows[row];
    if (!cells)
        return;
    const buyerUsername = cellText(cells, BUYER_USERNAME_COL);
    if (!buyerUsername)
        return;
    if (!grid?.getLinkedChatUsernames().has(buyerUsername.toLowerCase())) {
        openAlertDialog({ title: 'Enviar prévia', body: 'Chat não vinculado.' });
        return;
    }
    const photoCols = listPreviewPhotoCols(sheet, row);
    if (photoCols.length === 0) {
        openAlertDialog({ title: 'Enviar prévia', body: 'Esta linha não tem foto.' });
        return;
    }
    if (photoCols.length === 1) {
        void sendPreviewForRow(row, photoCols[0]);
        return;
    }
    openPreviewPickerDialog({
        title: 'Enviar prévia',
        items: photoCols.map((photoCol) => {
            const img = sheet.images[`${row}:${photoCol}`];
            const header = String(sheet.headers[photoCol] ?? '').trim() || `Coluna ${photoCol + 1}`;
            return { col: photoCol, label: header, imageUrl: img.url ?? '' };
        }).filter((item) => item.imageUrl),
        onSend: (photoCol) => sendPreviewForRow(row, photoCol),
    });
}
function handleChatRequest(row, col) {
    if (!workbook || col !== RECIPIENT_COLUMN_INDEX)
        return;
    const sheet = workbook.sheets[workbook.sheetOrder[0]];
    if (!sheet)
        return;
    const cells = sheet.rows[row];
    if (!cells)
        return;
    const buyerUsername = cellText(cells, BUYER_USERNAME_COL);
    if (!buyerUsername) {
        openAlertDialog({ title: 'Chat Shopee', body: 'Esta linha não tem username na coluna E.' });
        return;
    }
    const orderKey = getOrderKey(row);
    if (!orderKey || !currentWorkbookId) {
        openAlertDialog({ title: 'Chat Shopee', body: 'Não foi possível identificar o pedido desta linha.' });
        return;
    }
    const linked = grid?.getLinkedChatUsernames().has(buyerUsername.toLowerCase());
    if (!linked) {
        openConfirmDialog({
            title: 'Chat Shopee',
            body: 'Chat não vinculado ainda (comprador nunca mandou mensagem). Use "Vincular conversas Shopee" ' +
                'na barra de ferramentas se ele já tiver conversado, ou clique em "Iniciar conversa" pra mandar ' +
                'um "Oi" agora e abrir o chat.',
            confirmLabel: 'Iniciar conversa',
            onConfirm: () => startChatForRow(row, col, orderKey, buyerUsername),
        });
        return;
    }
    openChatPanelForRow(row, col, orderKey, cells, sheet, buyerUsername);
}
function openChatPanelForRow(row, col, orderKey, cells, sheet, buyerUsername) {
    if (!currentWorkbookId)
        return;
    void openShopeeChatPanel({
        workbookId: currentWorkbookId,
        orderKey,
        orderId: cellText(cells, ID_COL) || '—',
        product: cellText(cells, PRODUCT_COL),
        model: cellText(cells, MODEL_COLUMN_INDEX),
        quantity: cellText(cells, QTY_COL),
        status: cellText(cells, STATUS_COLUMN_INDEX),
        buyerUsername,
        recipient: cellText(cells, RECIPIENT_COLUMN_INDEX),
        sheetDate: sheet.rowDates?.[row] ?? '',
        productImageUrl: sheet.rowProductImages?.[row] ?? '',
        onConfirmed: () => grid?.selectAndReveal(row, col),
    });
}
/** Manda "Oi" pro comprador via order_detail (sem precisar de chat prévio), religa
 * o cache local de chats vinculados e abre o painel de chat na sequência. */
async function startChatForRow(row, col, orderKey, buyerUsername) {
    setStatusText('Iniciando conversa...');
    try {
        await startShopeeConversation({ orderKey });
        await refreshLinkedBuyerChats();
        setStatusText('Conversa iniciada');
        const sheet = workbook?.sheets[workbook.sheetOrder[0]];
        const cells = sheet?.rows[row];
        if (!sheet || !cells)
            return;
        openChatPanelForRow(row, col, orderKey, cells, sheet, buyerUsername);
    }
    catch (error) {
        handleApiError(error, 'Falha ao iniciar conversa');
    }
}
function getCurrentSelectedRows() {
    const sel = grid.getSelection();
    if (!sel)
        return [];
    const tds = document.querySelectorAll('td.is-selected');
    const rows = new Set();
    tds.forEach((td) => {
        const r = Number(td.dataset.row);
        if (Number.isFinite(r))
            rows.add(r);
    });
    if (rows.size === 0)
        rows.add(sel.row);
    return [...rows];
}
async function blobToJpeg(blob, quality = 0.85) {
    if (blob.type === 'image/jpeg')
        return blob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx)
        return blob;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
    return new Promise((resolve) => {
        canvas.toBlob((result) => resolve(result ?? blob), 'image/jpeg', quality);
    });
}
async function pickImageFile(row, col) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        input.remove();
        if (!file || !file.type.startsWith('image/'))
            return;
        await uploadAndSetImage(row, col, file, file.name);
    });
    input.click();
}
async function uploadAndSetImage(row, col, blob, fileName) {
    if (!currentWorkbookId)
        return;
    const orderKey = getOrderKey(row);
    const orderId = getOrderId(row) ?? orderKey;
    if (!orderKey) {
        setStatusText('Pedido sem ID — não pode ter foto');
        return;
    }
    grid.setCellImage(row, col, blob, fileName);
    setStatusText('Convertendo e enviando foto...');
    try {
        const jpeg = await blobToJpeg(blob);
        const safeName = fileName.replace(/\.[^.]+$/, '') + '.jpg';
        await enqueueMutation(async () => {
            if (!currentWorkbookId)
                return;
            try {
                const result = await uploadImage(currentWorkbookId, orderKey, col, jpeg, safeName);
                if (!workbook)
                    return;
                const sheet = workbook.sheets[workbook.sheetOrder[0]];
                if (!sheet)
                    return;
                sheet.images[`${row}:${col}`] = { url: result.url, fileName: safeName, updatedAt: result.updatedAt };
                grid.render();
                serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt);
                setStatusText(`Foto enviada (${Math.round(jpeg.size / 1024)} KB)`);
            }
            catch (error) {
                addPendingMutation({
                    kind: 'image',
                    orderId: orderId ?? '',
                    rowIndex: row,
                    col,
                    sheetDate: workbook?.sheets[workbook.sheetOrder[0]]?.rowDates?.[row] ?? '',
                    description: `Enviar foto ${grid.getPhotoColumnIndices().indexOf(col) + 1}`,
                    error,
                });
                handleApiError(error, 'Falha ao enviar foto');
            }
        });
    }
    catch (error) {
        handleApiError(error, 'Falha ao enviar foto');
    }
}
async function deleteImageAt(row, col) {
    if (!currentWorkbookId)
        return;
    const orderKey = getOrderKey(row);
    const orderId = getOrderId(row) ?? orderKey;
    if (!orderKey)
        return;
    const sheetDate = workbook?.sheets[workbook.sheetOrder[0]]?.rowDates?.[row] ?? '';
    grid.removeCellImage(row, col);
    await enqueueMutation(async () => {
        if (!currentWorkbookId)
            return;
        try {
            const result = await deleteImage(currentWorkbookId, orderKey, col);
            serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt);
            setStatusText('Foto removida');
        }
        catch (error) {
            addPendingMutation({
                kind: 'image',
                orderId: orderId ?? '',
                rowIndex: row,
                col,
                sheetDate,
                description: `Remover foto ${grid.getPhotoColumnIndices().indexOf(col) + 1}`,
                error,
            });
            handleApiError(error, 'Falha ao remover foto');
        }
    });
}
function bindClipboardPaste() {
    document.addEventListener('paste', (event) => {
        const target = event.target;
        const tag = target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (target?.isContentEditable ?? false))
            return;
        const items = event.clipboardData?.items;
        if (!items)
            return;
        for (const item of items) {
            if (!item.type.startsWith('image/'))
                continue;
            const blob = item.getAsFile();
            if (!blob)
                continue;
            event.preventDefault();
            const sel = grid.getSelection();
            if (!sel || !grid.getPhotoColumnIndices().includes(sel.col)) {
                setStatusText('Selecione uma célula de Foto 1 a Foto 10 para colar a imagem');
                return;
            }
            const fileName = `clipboard-${Date.now()}.jpg`;
            void uploadAndSetImage(sel.row, sel.col, blob, fileName);
            return;
        }
    });
}
function bindEtiquetas() {
    document.querySelectorAll('.etiqueta-btn').forEach((button) => {
        button.addEventListener('click', () => {
            const color = button.dataset.bg || null;
            void handleEtiqueta(color);
        });
    });
}
function closeSearchResults() {
    const panel = el('#search-results');
    panel.hidden = true;
    panel.innerHTML = '';
    searchHighlightIndex = -1;
}
function renderSearchResults(query) {
    const panel = el('#search-results');
    const counter = el('#search-count');
    if (!workbook || !query) {
        closeSearchResults();
        counter.hidden = true;
        return;
    }
    const hits = searchWorkbook(workbook, query);
    lastSearchHits = hits;
    if (hits.length === 0) {
        panel.hidden = false;
        panel.innerHTML = '<div class="search-empty">Nenhum resultado</div>';
        counter.hidden = false;
        counter.textContent = '0';
        return;
    }
    counter.hidden = false;
    counter.textContent = hits.length >= 80 ? '80+' : String(hits.length);
    panel.hidden = false;
    panel.innerHTML = '';
    hits.forEach((hit, index) => {
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'search-result' + (index === 0 ? ' is-focused' : '');
        item.dataset.index = String(index);
        item.innerHTML = `
      <span class="search-result-tag">${escapeHtml(hit.sheetName)}</span>
      <span class="search-result-ref">${formatHitRef(hit)}</span>
      <span class="search-result-value">${highlightMatch(hit.value, query)}</span>
    `;
        item.addEventListener('click', () => {
            // troca pra data do hit antes de navegar — search retorna hits de outros
            // dias e o navigateTo so funciona em rows visiveis no filtro atual.
            if (hit.sheetDate && grid.getDateFilter() !== hit.sheetDate) {
                grid.setDateFilter(hit.sheetDate);
                setUrlDate(hit.sheetDate);
                renderDateSelect();
            }
            grid.navigateTo(hit.sheetId, hit.rowIndex < 0 ? 0 : hit.rowIndex, hit.colIndex);
            closeSearchResults();
            el('#search-input').value = '';
            counter.hidden = true;
        });
        panel.appendChild(item);
    });
    searchHighlightIndex = 0;
}
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}
function moveSearchFocus(delta) {
    if (lastSearchHits.length === 0)
        return;
    const items = el('#search-results').querySelectorAll('.search-result');
    if (items.length === 0)
        return;
    items[searchHighlightIndex]?.classList.remove('is-focused');
    searchHighlightIndex = (searchHighlightIndex + delta + items.length) % items.length;
    const next = items[searchHighlightIndex];
    next?.classList.add('is-focused');
    next?.scrollIntoView({ block: 'nearest' });
}
function jumpToFocusedHit() {
    if (lastSearchHits.length === 0)
        return;
    const hit = lastSearchHits[searchHighlightIndex] ?? lastSearchHits[0];
    if (!hit)
        return;
    grid.navigateTo(hit.sheetId, hit.rowIndex < 0 ? 0 : hit.rowIndex, hit.colIndex);
    el('#search-input').value = '';
    el('#search-count').hidden = true;
    closeSearchResults();
}
function bindSearch() {
    const input = el('#search-input');
    input.addEventListener('input', () => {
        const query = input.value;
        if (searchTimer)
            window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => renderSearchResults(query), 120);
    });
    input.addEventListener('focus', () => {
        if (input.value.trim())
            renderSearchResults(input.value);
    });
    input.addEventListener('keydown', (event) => {
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            moveSearchFocus(1);
        }
        else if (event.key === 'ArrowUp') {
            event.preventDefault();
            moveSearchFocus(-1);
        }
        else if (event.key === 'Enter') {
            event.preventDefault();
            jumpToFocusedHit();
        }
        else if (event.key === 'Escape') {
            event.preventDefault();
            input.value = '';
            el('#search-count').hidden = true;
            closeSearchResults();
            input.blur();
        }
    });
    document.addEventListener('mousedown', (event) => {
        const target = event.target;
        if (!target.closest('.search-box'))
            closeSearchResults();
    });
    window.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
            event.preventDefault();
            input.focus();
            input.select();
            return;
        }
        // Não processa atalhos da grid se o foco está em algum input/textarea/edit.
        const target = event.target;
        const tag = target?.tagName;
        const inField = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true;
        if (inField)
            return;
        // Chat da Shopee aberto por cima da grid: a seleção de célula continua
        // "ativa" por baixo mesmo sem foco em input, então sem essa checagem
        // Ctrl+C dentro do chat (ex.: copiar imagem de emoji) roubava o valor
        // da célula em vez do que o usuário estava copiando no chat.
        if (document.body.classList.contains('shopee-chat-open'))
            return;
        if (!grid)
            return;
        // Ctrl/Cmd+C: copia os valores das células selecionadas (1 col × N linhas).
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
            event.preventDefault();
            void grid.copySelectedToClipboard().then((n) => {
                if (n > 0)
                    setStatusText(`${n} valor(es) copiado(s)`);
            });
            return;
        }
        // Type-to-jump (Windows Explorer style) — só pra caracteres imprimíveis,
        // sem modificadores. Pula pra próxima célula da coluna selecionada que
        // comece com o que o user digitou.
        if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
            if (grid.typeAheadJump(event.key)) {
                event.preventDefault();
            }
        }
    });
}
async function loadFile(file) {
    if (!currentWorkbookId)
        return;
    setStatusText('Lendo arquivo...');
    try {
        const parsed = await parseXlsx(file, {
            existing: workbook,
            onProgress: (msg, current, total) => {
                if (current != null && total != null) {
                    setStatusText(`${msg}: ${current} / ${total}`);
                }
                else {
                    setStatusText(msg);
                }
            },
        });
        setStatusText('Enviando para o servidor...');
        const sheet = parsed.sheets[parsed.sheetOrder[0]];
        const blobImages = [];
        for (const [key, img] of Object.entries(sheet.images)) {
            const [r, c] = key.split(':').map(Number);
            if (img.blob && !img.url) {
                blobImages.push({ row: r, col: c, blob: img.blob, fileName: img.fileName });
            }
        }
        const orders = sheet.rows.map((row, idx) => ({
            key: sheet.rowKeys?.[idx],
            id: String(row[ID_COL] ?? '').trim() || `order-${idx}-${Date.now()}`,
            row,
            styles: Object.fromEntries(Object.entries(sheet.cellStyles ?? {})
                .filter(([k]) => k.startsWith(`${idx}:`))
                .map(([k, v]) => [k.split(':')[1], v])),
            disappeared: !!sheet.rowFlags?.[idx]?.disappeared,
            sheetDate: sheet.rowDates?.[idx] ?? '',
        }));
        const result = await replaceWorkbook(currentWorkbookId, {
            orders,
            columnWidths: sheet.columnWidths,
        });
        serverUpdatedAt = result.updatedAt;
        for (const item of blobImages) {
            const orderKey = orders[item.row]?.key ?? orders[item.row]?.id;
            if (!orderKey)
                continue;
            try {
                const jpeg = await blobToJpeg(item.blob);
                await uploadImage(currentWorkbookId, orderKey, item.col, jpeg, item.fileName.replace(/\.[^.]+$/, '') + '.jpg');
            }
            catch (error) {
                console.warn('Falha ao enviar imagem do XLSX:', error);
            }
        }
        await refreshFromServer({ force: true });
        setStatusText(`Importado · ${result.count} pedidos`);
    }
    catch (error) {
        if (error instanceof AuthRequiredError) {
            handleApiError(error);
            return;
        }
        console.error(error);
        setStatusText('Falha ao importar');
        alert(`Não foi possível importar este arquivo: ${error.message}`);
    }
}
function bindFileInput() {
    const input = el('#file-input');
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file)
            void loadFile(file);
        input.value = '';
    });
}
async function loadPhotos(file) {
    if (!currentWorkbookId || !workbook)
        return;
    setStatusText('Lendo XLSX de fotos...');
    try {
        const parsed = await parseXlsx(file, {
            existing: workbook,
            onProgress: (msg, current, total) => {
                if (current != null && total != null) {
                    setStatusText(`${msg}: ${current} / ${total}`);
                }
                else {
                    setStatusText(msg);
                }
            },
        });
        const sheet = parsed.sheets[parsed.sheetOrder[0]];
        if (!sheet) {
            setStatusText('XLSX sem dados');
            return;
        }
        const currentSheet = workbook.sheets[workbook.sheetOrder[0]];
        const existingIds = new Set();
        for (const row of currentSheet?.rows ?? []) {
            const id = String(row[ID_COL] ?? '').trim();
            if (id)
                existingIds.add(id);
        }
        const uploads = [];
        const skippedIds = new Set();
        for (const [key, img] of Object.entries(sheet.images)) {
            if (!img.blob || img.url)
                continue;
            const [r, c] = key.split(':').map(Number);
            const id = String(sheet.rows[r]?.[ID_COL] ?? '').trim();
            if (!id)
                continue;
            if (!existingIds.has(id)) {
                skippedIds.add(id);
                continue;
            }
            uploads.push({ id, col: c, blob: img.blob, fileName: img.fileName });
        }
        if (uploads.length === 0) {
            const skipMsg = skippedIds.size > 0 ? ` (${skippedIds.size} IDs sem match foram ignorados)` : '';
            setStatusText(`Nenhuma foto pra atualizar${skipMsg}`);
            return;
        }
        let done = 0;
        let failed = 0;
        for (const u of uploads) {
            try {
                const jpeg = await blobToJpeg(u.blob);
                const safeName = u.fileName.replace(/\.[^.]+$/, '') + '.jpg';
                await uploadImage(currentWorkbookId, u.id, u.col, jpeg, safeName);
                done++;
                setStatusText(`Enviando fotos: ${done} / ${uploads.length}`);
            }
            catch (error) {
                failed++;
                console.warn('Falha ao enviar foto:', error);
            }
        }
        await refreshFromServer({ force: true });
        const skipMsg = skippedIds.size > 0 ? ` · ${skippedIds.size} IDs ignorados` : '';
        const failMsg = failed > 0 ? ` · ${failed} falhas` : '';
        setStatusText(`Fotos atualizadas: ${done}${skipMsg}${failMsg}`);
    }
    catch (error) {
        if (error instanceof AuthRequiredError) {
            handleApiError(error);
            return;
        }
        console.error(error);
        setStatusText('Falha ao atualizar fotos');
        alert(`Falha ao ler XLSX: ${error.message}`);
    }
}
function bindPhotosInput() {
    const input = el('#photos-input');
    input.addEventListener('change', () => {
        const file = input.files?.[0];
        if (file)
            void loadPhotos(file);
        input.value = '';
    });
}
function bindDropZone() {
    const sheetRoot = el('#sheet-root');
    sheetRoot.addEventListener('dragover', (event) => {
        event.preventDefault();
        const dropZone = sheetRoot.querySelector('.drop-zone');
        if (dropZone)
            dropZone.classList.add('is-dragging');
    });
    sheetRoot.addEventListener('dragleave', () => {
        const dropZone = sheetRoot.querySelector('.drop-zone');
        if (dropZone)
            dropZone.classList.remove('is-dragging');
    });
    sheetRoot.addEventListener('drop', (event) => {
        event.preventDefault();
        const file = event.dataTransfer?.files[0];
        if (file)
            void loadFile(file);
    });
    sheetRoot.addEventListener('click', (event) => {
        const target = event.target;
        if (target.closest('.drop-zone')) {
            el('#file-input').click();
        }
    });
}
function bindLogout() {
    el('#logout-btn').addEventListener('click', async () => {
        try {
            await logout();
        }
        catch {
            // ignore
        }
        location.reload();
    });
}
function bindBackButton() {
    el('#back-btn').addEventListener('click', () => {
        leaveWorkbook();
        setUrlWorkbookId(null);
        showHome();
    });
}
async function refreshFromServer(options = {}) {
    if (!currentWorkbookId)
        return false;
    try {
        const previousSelection = grid.getSelection();
        const response = await fetchWorkbook(currentWorkbookId, options.force ? undefined : serverUpdatedAt || undefined);
        if (response.unchanged) {
            serverUpdatedAt = response.updatedAt;
            return true;
        }
        workbook = serverWorkbookToLocal(currentWorkbookId, response);
        grid.setWorkbook(workbook);
        if (isShopeeWorkbookId(currentWorkbookId)) {
            // grid.setWorkbook() limpa this.filters a cada poll — reaplica o status ativo.
            grid.setColumnFilter(SHOPEE_STATUS_COLUMN_INDEX, currentShopeeStatusFilter ? shopeeStatusMatchValues(currentShopeeStatusFilter) : null);
            if (!shopeeDateDefaultApplied) {
                shopeeDateDefaultApplied = true;
                const readyDates = sortDates(grid.getAvailableDatesForColumnValue(SHOPEE_STATUS_COLUMN_INDEX, shopeeStatusMatchValues(SHOPEE_DEFAULT_STATUS_FILTER)));
                const requestedUrlDate = getUrlDate();
                const requestedHasReady = requestedUrlDate != null && readyDates.some((d) => formatDateForUrl(d) === requestedUrlDate);
                // Só pula pro 1º dia "a enviar" se a data da URL (se houver) não tiver
                // nenhum pedido READY_TO_SHIP — senão isso sempre sobrescrevia a data
                // pedida na URL a cada recarregamento, antes de applyUrlDateFilter() rodar.
                if (!requestedHasReady && readyDates.length > 0) {
                    grid.setDateFilter(readyDates[0]);
                    setUrlDate(readyDates[0]);
                }
            }
        }
        applyUrlDateFilter();
        applyUrlGridViewState();
        if (previousSelection && previousSelection.sheetId === workbook.sheetOrder[0]) {
            grid.restoreSelection(previousSelection.row, previousSelection.col);
        }
        renderDateSelect();
        renderShopeeStatusSelect();
        updateStatusCounts();
        setFilename(workbook.name);
        serverUpdatedAt = response.updatedAt;
        return true;
    }
    catch (error) {
        handleApiError(error, 'Falha ao sincronizar');
        return false;
    }
}
function startPolling() {
    if (pollTimer)
        window.clearInterval(pollTimer);
    pollTimer = window.setInterval(() => void refreshFromServer(), POLL_INTERVAL_MS);
}
function stopPolling() {
    if (pollTimer) {
        window.clearInterval(pollTimer);
        pollTimer = null;
    }
}
let inflightBatches = 0;
async function withPollingPaused(fn) {
    inflightBatches++;
    stopPolling();
    try {
        return await fn();
    }
    finally {
        inflightBatches--;
        if (inflightBatches === 0 && currentWorkbookId)
            startPolling();
    }
}
let mutationQueue = Promise.resolve();
function enqueueMutation(fn) {
    mutationQueue = mutationQueue
        .catch(() => {
        // A próxima gravação da fila não deve ficar presa por falha anterior.
    })
        .then(() => withPollingPaused(async () => {
        setStatusText('Salvando...');
        await fn();
    }));
    return mutationQueue;
}
function handleApiError(error, fallback) {
    if (error instanceof AuthRequiredError) {
        stopPolling();
        showLoginScreen(() => {
            void init();
        });
        return;
    }
    if (fallback)
        setStatusText(fallback);
    console.error(error);
}
function leaveWorkbook() {
    stopPolling();
    workbook = null;
    currentWorkbookId = null;
    serverUpdatedAt = 0;
}
function fmtScanDate(iso) {
    if (!iso)
        return '—';
    return iso.slice(0, 10);
}
function samplePageMetrics(metrics) {
    if (metrics.length <= 30)
        return metrics;
    const picked = new Map();
    for (const m of metrics.slice(0, 8))
        picked.set(m.page, m);
    for (const m of metrics) {
        if (m.page % 20 === 0)
            picked.set(m.page, m);
    }
    for (const m of metrics.slice(-12))
        picked.set(m.page, m);
    return [...picked.values()].sort((a, b) => a.page - b.page);
}
function formatPageMetricsLines(metrics) {
    if (!metrics.length)
        return [];
    const sample = samplePageMetrics(metrics);
    const lines = [
        '',
        `--- Paginação (${metrics.length} página(s); amostra abaixo) ---`,
    ];
    let prevPage = 0;
    for (const m of sample) {
        if (prevPage && m.page > prevPage + 1)
            lines.push('…');
        lines.push(`Pág ${m.page}: ${m.chatsOnPage} chats (${m.indexedOnPage} indexados) | acum. ${m.scannedTotal} | ${fmtScanDate(m.oldestOnPage)} → ${fmtScanDate(m.newestOnPage)}`);
        if (m.nextTimestampNano) {
            lines.push(`     próximo cursor: ${m.nextTimestampNano}`);
        }
        prevPage = m.page;
    }
    return lines;
}
function bindShopeeLinkConversations() {
    const SHOPEE_LINK_MAX_PAGES = 10;
    const btn = document.querySelector('#shopee-link-conversations-btn');
    if (!btn)
        return;
    btn.addEventListener('click', async () => {
        if (!currentWorkbookId)
            return;
        const workbookId = currentWorkbookId;
        const prevLabel = btn.textContent ?? '';
        btn.disabled = true;
        btn.textContent = 'Vinculando…';
        try {
            const status = await fetchShopeeLinkStatus(workbookId);
            if (status.allLinked) {
                const relink = await new Promise((resolve) => {
                    openConfirmDialog({
                        title: 'Conversas já vinculadas',
                        body: `${status.linked} de ${status.buyersFound} compradores desta planilha já têm chat vinculado.\n\nVincular novamente apaga os vínculos atuais e varre a Shopee de novo (older, até ${SHOPEE_LINK_MAX_PAGES} páginas).`,
                        confirmLabel: 'Vincular novamente',
                        danger: true,
                        onConfirm: () => resolve(true),
                        onCancel: () => resolve(false),
                    });
                });
                if (!relink) {
                    setStatusText(`${status.linked} compradores já vinculados — nada a fazer`);
                    setShopeeActionBanner('Todos os compradores já estão vinculados', 'success');
                    return;
                }
                await clearShopeeBuyerChats(workbookId);
                await refreshLinkedBuyerChats();
            }
            setShopeeActionBanner('Buscando conversas na Shopee (older, até 10 páginas)…', 'loading');
            renderSheetLoading();
            setStatusText('Vinculando conversas Shopee…');
            await withPollingPaused(async () => {
                let nextTimestampNano;
                let pageNumber = 0;
                let scannedBefore = 0;
                let indexedBefore = 0;
                let linked = 0;
                let buyersFound = 0;
                let ordersQueried = 0;
                let done = false;
                let doneReason = null;
                const pageMetricsSample = [];
                const errors = [];
                let resumeCursor = null;
                let newestGlobal = null;
                let oldestGlobal = null;
                const maxPages = SHOPEE_LINK_MAX_PAGES;
                while (!done && pageNumber < maxPages) {
                    const chunk = await linkShopeeConversationsScanChunk(workbookId, {
                        nextTimestampNano,
                        pageNumber,
                        scannedBefore,
                        indexedBefore,
                    });
                    ordersQueried = chunk.ordersQueried;
                    buyersFound = chunk.buyersFound;
                    linked = chunk.linked;
                    pageNumber = chunk.conversationPages;
                    scannedBefore = chunk.conversationsScanned;
                    indexedBefore = chunk.conversationsIndexed;
                    if (chunk.errors.length)
                        errors.push(...chunk.errors);
                    if (chunk.pageMetric) {
                        pageMetricsSample.push(chunk.pageMetric);
                        const n = chunk.pageMetric.newestOnPage;
                        const o = chunk.pageMetric.oldestOnPage;
                        if (n && (!newestGlobal || n > newestGlobal))
                            newestGlobal = n;
                        if (o && (!oldestGlobal || o < oldestGlobal))
                            oldestGlobal = o;
                        const pm = chunk.pageMetric;
                        setStatusText(`Pág ${pm.page}: ${pm.chatsOnPage} chats | acum. ${pm.scannedTotal} | ${fmtScanDate(pm.oldestOnPage)} → ${fmtScanDate(pm.newestOnPage)} | ${linked}/${buyersFound} vinculados`);
                        setShopeeActionBanner(`Varrendo conversas Shopee… página ${pm.page}, ${pm.scannedTotal} chats, ${linked} de ${buyersFound} vinculados`, 'loading');
                    }
                    resumeCursor = chunk.nextTimestampNano;
                    done = chunk.done;
                    doneReason = chunk.doneReason;
                    if (chunk.errors.length)
                        break;
                    if (done)
                        break;
                    if (!chunk.hasMore || !chunk.nextTimestampNano)
                        break;
                    nextTimestampNano = chunk.nextTimestampNano;
                }
                const notFound = Math.max(buyersFound - linked, 0);
                const ok = errors.length === 0 && buyersFound > 0;
                const short = buyersFound === 0
                    ? 'Nenhum comprador encontrado nos pedidos desta planilha.'
                    : `${linked} conversa(s) vinculada(s), ${notFound} sem chat (${buyersFound} compradores).`;
                setShopeeActionBanner(short, ok ? 'success' : 'error');
                setStatusText(short);
                const detail = [
                    `Varredura older (máx. ${SHOPEE_LINK_MAX_PAGES} páginas)`,
                    `Pedidos únicos consultados: ${ordersQueried}`,
                    `Compradores na planilha (col E): ${buyersFound}`,
                    `Conversas vinculadas: ${linked}`,
                    `Sem chat encontrado: ${notFound}`,
                    `Chats listados na Shopee: ${scannedBefore} (${pageNumber} página(s))`,
                    `Chats com ID reconhecido: ${indexedBefore}`,
                ];
                if (doneReason === 'all_found')
                    detail.push('Parou: todos os compradores vinculados.');
                if (doneReason === 'no_more') {
                    detail.push(pageNumber >= SHOPEE_LINK_MAX_PAGES
                        ? `Parou: limite de ${SHOPEE_LINK_MAX_PAGES} páginas.`
                        : 'Parou: fim da lista de conversas na Shopee.');
                }
                if (newestGlobal)
                    detail.push(`Chat mais recente varrido: ${newestGlobal.slice(0, 10)}`);
                if (oldestGlobal)
                    detail.push(`Chat mais antigo varrido: ${oldestGlobal.slice(0, 10)}`);
                detail.push(...formatPageMetricsLines(pageMetricsSample));
                if (resumeCursor && !done) {
                    detail.push('', 'Para retomar (startTimestampNano):', resumeCursor);
                }
                if (errors.length) {
                    detail.push('', 'Erros:', ...errors.slice(0, 8));
                    if (errors.length > 8)
                        detail.push(`… e mais ${errors.length - 8}`);
                }
                openAlertDialog({
                    title: errors.length ? 'Vincular conversas — com avisos' : 'Vincular conversas — concluído',
                    body: detail.join('\n'),
                });
                if (errors.length)
                    console.warn('[shopee-link-conversations]', errors);
                if (pageMetricsSample.length) {
                    console.info('[shopee-link-conversations] pageMetrics', pageMetricsSample);
                }
                await refreshLinkedBuyerChats();
            });
        }
        catch (error) {
            const msg = error.message;
            setShopeeActionBanner(`Falha ao vincular conversas: ${msg}`, 'error');
            setStatusText(`Erro ao vincular conversas: ${msg}`);
            openAlertDialog({ title: 'Vincular conversas — erro', body: msg });
        }
        finally {
            btn.disabled = false;
            btn.textContent = prevLabel;
            stopSheetLoading();
        }
    });
}
/**
 * Baixa as artes dos pedidos Aprovado — substitui a Remessa manual (varrer
 * aprovados, copiar arte por arte pra uma pasta). As artes são montadas na
 * hora no servidor e vêm num zip; o status NÃO muda, então dá pra baixar só
 * pra conferir.
 */
function bindBaixarAprovados() {
    const porData = document.querySelector('#baixar-aprovados-data-btn');
    const todos = document.querySelector('#baixar-aprovados-todos-btn');
    async function baixar(btn, sheetDate) {
        const rotulo = btn.textContent;
        btn.disabled = true;
        btn.textContent = '⏳ Gerando artes…';
        setStatusText(sheetDate
            ? `Gerando artes dos aprovados de ${sheetDate}…`
            : 'Gerando artes de todos os aprovados… (pode levar alguns minutos)');
        try {
            const qs = sheetDate ? `?sheetDate=${encodeURIComponent(sheetDate)}` : '';
            const r = await fetch(`/api/picker/artes-aprovadas.zip${qs}`, { credentials: 'include' });
            if (!r.ok) {
                const detalhe = (await r.json().catch(() => ({})));
                throw new Error(detalhe.error ?? `HTTP ${r.status}`);
            }
            const blob = await r.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = sheetDate ? `aprovados ${sheetDate}.zip` : 'aprovados (todas as datas).zip';
            a.click();
            URL.revokeObjectURL(url);
            setStatusText(`Download pronto (${(blob.size / 1024 / 1024).toFixed(1)}MB).`);
        }
        catch (error) {
            setStatusText(`Falha ao gerar artes: ${error.message}`);
        }
        finally {
            btn.disabled = false;
            btn.textContent = rotulo;
        }
    }
    porData?.addEventListener('click', () => {
        const data = document.querySelector('#date-select')?.value ?? '';
        if (!data) {
            setStatusText('Selecione uma data primeiro.');
            return;
        }
        void baixar(porData, data);
    });
    todos?.addEventListener('click', () => void baixar(todos, null));
}
function applyShopeeWorkbookToolbar(workbookId) {
    const isShopee = isShopeeWorkbookId(workbookId);
    setToolbarBtnVisible(document.querySelector('#baixar-aprovados-data-btn'), isShopee);
    setToolbarBtnVisible(document.querySelector('#baixar-aprovados-todos-btn'), isShopee);
    // "Vincular conversas" sai da barra (pedido do user), mas a FUNÇÃO continua:
    // passou a rodar sozinha junto do poll de 2h no servidor. Sem isso, comprador
    // novo nunca vincularia e o disparo automático o pularia como "sem chat".
    setToolbarBtnVisible(document.querySelector('#shopee-link-conversations-btn'), false);
    setToolbarBtnVisible(document.querySelector('#xlsx-update-label'), !isShopee);
    setToolbarBtnVisible(document.querySelector('#xlsx-photos-label'), !isShopee);
    setShopeeActionBanner('', 'hidden');
}
async function enterWorkbook(workbookId) {
    currentWorkbookId = workbookId;
    setUrlWorkbookId(workbookId);
    serverUpdatedAt = 0;
    workbook = null;
    currentShopeeStatusFilter = SHOPEE_DEFAULT_STATUS_FILTER;
    shopeeDateDefaultApplied = false;
    buildShell();
    grid = new GridView(el('#sheet-root'), {
        onSelectCell: handleSelect,
        onCellChange: handleCellChange,
        onImageRequest: (row, col) => pickImageFile(row, col),
        onCellImageChange: () => {
            // not used here; image ops go through uploadAndSetImage/deleteImageAt
        },
        onImageDelete: (row, col) => openConfirmDialog({
            title: 'Excluir imagem?',
            body: 'Esta imagem será removida do pedido. Esta ação não pode ser desfeita.',
            confirmLabel: 'Excluir',
            danger: true,
            onConfirm: () => deleteImageAt(row, col),
        }),
        onCommentRequest: handleCommentRequest,
        onChatRequest: handleChatRequest,
        onPreviewRequest: handlePreviewRequest,
        onViewStateChange: () => {
            setUrlGridViewState(grid.getViewState());
            updateStatusCounts();
        },
    });
    renderSheetLoading();
    bindFileInput();
    bindPhotosInput();
    bindDropZone();
    bindSearch();
    bindEtiquetas();
    bindClipboardPaste();
    bindLogout();
    bindBackButton();
    bindZoomControls();
    bindPendingMutationsButton();
    applyShopeeWorkbookToolbar(workbookId);
    bindBaixarAprovados();
    bindShopeeLinkConversations();
    try {
        await refreshFromServer({ force: true });
    }
    finally {
        stopSheetLoading();
    }
    await refreshLinkedBuyerChats();
    startPolling();
}
async function createWorkbookFromXlsx(file) {
    const name = file.name.replace(/\.[^.]+$/, '').trim() || 'Sem nome';
    const wb = await createWorkbook(name);
    await enterWorkbook(wb.id);
    await loadFile(file);
}
function showHome() {
    const app = el('#app');
    showWorkbooksList({
        root: app,
        onOpen: (id) => void enterWorkbook(id),
        onCreateFromXlsx: createWorkbookFromXlsx,
        onAuthLost: () => {
            showLoginScreen(() => {
                void init();
            });
        },
        onLogout: async () => {
            try {
                await logout();
            }
            catch {
                // ignore
            }
            location.reload();
        },
    });
}
async function init() {
    void FIXED_HEADERS;
    loadZoom();
    const ok = await checkAuth();
    if (!ok) {
        showLoginScreen(() => {
            void init();
        });
        return;
    }
    const workbookId = getUrlWorkbookId();
    if (workbookId) {
        await enterWorkbook(workbookId);
        return;
    }
    showHome();
}
void init();
