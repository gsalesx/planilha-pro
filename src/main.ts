import './style.css'

import {
  AuthRequiredError,
  checkAuth,
  createWorkbook,
  deleteImage,
  deleteOrdersBySheetDate,
  fetchWorkbook,
  logout,
  patchOrderDelta,
  replaceWorkbook,
  serverWorkbookToLocal,
  syncShopeeWorkbookInitial,
  linkShopeeConversationsScanChunk,
  fetchLinkedBuyerUsernames,
  uploadImage,
  type OrderStyleDelta,
} from './api'
import { openAlertDialog, openConfirmDialog, openTextareaDialog } from './dialog'
import {
  GridView,
  MODEL_COLUMN_INDEX,
  RECIPIENT_COLUMN_INDEX,
  type GridViewState,
} from './grid'
import { showLoginScreen } from './login'
import { formatHitRef, highlightMatch, searchWorkbook, type SearchHit } from './search'
import { STATUS_COLUMN_INDEX } from './status'
import type { CellValue, WorkbookData } from './types'
import { showWorkbooksList } from './workbooks-list'
import { isShopeeWorkbookId } from './shopee-workbook'
import { openShopeeChatPanel } from './shopee-chat-panel'
import { FIXED_HEADERS, parseXlsx } from './xlsx-parser'

const POLL_INTERVAL_MS = 8000
const ID_COL = 0
const PRODUCT_COL = 1
const QTY_COL = 3
const BUYER_USERNAME_COL = 4

let workbook: WorkbookData | null = null
let grid: GridView
let serverUpdatedAt = 0
let pollTimer: number | null = null
let searchTimer: number | null = null
let lastSearchHits: SearchHit[] = []
let searchHighlightIndex = -1
let currentWorkbookId: string | null = null

interface PendingMutation {
  id: string
  workbookId: string
  kind: 'cell' | 'style' | 'comment' | 'image'
  orderId: string
  rowIndex: number
  col: number
  sheetDate?: string
  description: string
  error: string
  createdAt: number
}

function el<T extends HTMLElement>(selector: string): T {
  const node = document.querySelector<T>(selector)
  if (!node) throw new Error(`Elemento não encontrado: ${selector}`)
  return node
}

function buildShell() {
  const app = el<HTMLDivElement>('#app')
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
          <button type="button" class="btn btn-primary" id="shopee-import-btn" hidden title="Importa pedidos dos últimos 5 dias da Shopee">
            ↓ Importar pedidos Shopee (5 dias)
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
  `
}

function setStatusText(text: string) {
  el<HTMLSpanElement>('#status-text').textContent = text
}

function setToolbarBtnVisible(node: HTMLElement | null, visible: boolean) {
  if (!node) return
  node.hidden = !visible
  node.style.display = visible ? '' : 'none'
}

function setShopeeActionBanner(
  message: string,
  tone: 'loading' | 'success' | 'error' | 'hidden',
) {
  const banner = document.querySelector<HTMLDivElement>('#shopee-action-banner')
  if (!banner) return
  if (tone === 'hidden') {
    banner.hidden = true
    banner.textContent = ''
    delete banner.dataset.tone
    return
  }
  banner.hidden = false
  banner.dataset.tone = tone
  banner.textContent = message
}

function setFilename(text: string) {
  el<HTMLSpanElement>('#filename').textContent = text
}

function renderSheetLoading() {
  grid.setLoading(true)
}

function stopSheetLoading() {
  grid.setLoading(false)
}

function updateStatusCounts() {
  const sheet = grid.getActiveSheet()
  const target = el<HTMLSpanElement>('#status-counts')
  if (!sheet) {
    target.textContent = ''
    return
  }
  const visible = grid.getVisibleRowCount()
  const total = sheet.rows.length
  target.textContent = visible === total ? `${total} pedidos` : `${visible} de ${total} pedidos`
}

const PENDING_MUTATIONS_KEY_PREFIX = 'planilha-pro-pending-mutations'

function pendingMutationsKey(workbookId = currentWorkbookId): string | null {
  return workbookId ? `${PENDING_MUTATIONS_KEY_PREFIX}:${workbookId}` : null
}

function readPendingMutations(): PendingMutation[] {
  const key = pendingMutationsKey()
  if (!key) return []
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? '[]') as PendingMutation[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writePendingMutations(items: PendingMutation[]) {
  const key = pendingMutationsKey()
  if (!key) return
  try {
    localStorage.setItem(key, JSON.stringify(items))
  } catch {
    // Se o navegador bloquear storage, ainda mantemos a UI funcionando.
  }
  updatePendingMutationsButton()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error || 'Erro desconhecido')
}

function addPendingMutation(input: Omit<PendingMutation, 'id' | 'workbookId' | 'error' | 'createdAt'> & { error: unknown }) {
  if (!currentWorkbookId) return
  const items = readPendingMutations()
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
  })
  writePendingMutations(items.slice(0, 50))
}

function removePendingMutation(id: string) {
  writePendingMutations(readPendingMutations().filter((item) => item.id !== id))
}

function updatePendingMutationsButton() {
  const button = document.querySelector<HTMLButtonElement>('#pending-mutations-btn')
  if (!button) return
  const count = readPendingMutations().length
  button.hidden = count === 0
  button.textContent = `Pendências: ${count}`
}

function navigateToPendingMutation(item: PendingMutation) {
  if (!workbook) return
  const sheetId = workbook.sheetOrder[0]
  const sheet = workbook.sheets[sheetId]
  if (!sheet) return
  const rowIndex = sheet.rows.findIndex((row) => String(row[ID_COL] ?? '').trim() === item.orderId)
  if (rowIndex < 0) {
    setStatusText('Pedido da pendência não está na planilha atual')
    return
  }
  const sheetDate = sheet.rowDates?.[rowIndex]
  if (sheetDate && grid.getDateFilter() !== sheetDate) {
    grid.setDateFilter(sheetDate)
    setUrlDate(sheetDate)
    renderDateSelect()
  }
  grid.navigateTo(sheetId, rowIndex, item.col)
  setStatusText('Pendência localizada')
}

function openPendingMutationsPanel() {
  const items = readPendingMutations()
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
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
  `
  const close = () => overlay.remove()
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  overlay.querySelector<HTMLButtonElement>('.pending-close')?.addEventListener('click', close)
  overlay.querySelectorAll<HTMLElement>('.pending-mutations-item').forEach((node) => {
    const id = node.dataset.id
    const item = items.find((entry) => entry.id === id)
    if (!id || !item) return
    node.querySelector<HTMLButtonElement>('.pending-go')?.addEventListener('click', () => {
      close()
      navigateToPendingMutation(item)
    })
    node.querySelector<HTMLButtonElement>('.pending-remove')?.addEventListener('click', () => {
      removePendingMutation(id)
      node.remove()
      if (readPendingMutations().length === 0) close()
    })
  })
  document.body.appendChild(overlay)
}

function bindPendingMutationsButton() {
  el<HTMLButtonElement>('#pending-mutations-btn').addEventListener('click', openPendingMutationsPanel)
  updatePendingMutationsButton()
}

/* ===========================================================
   Zoom da planilha
   =========================================================== */

const ZOOM_KEY = 'planilha-zoom'
const ZOOM_MIN = 0.6
const ZOOM_MAX = 2.4
const ZOOM_STEP = 0.1
let currentZoom = 1

function loadZoom() {
  const raw = localStorage.getItem(ZOOM_KEY)
  if (!raw) return
  const v = parseFloat(raw)
  if (Number.isFinite(v) && v >= ZOOM_MIN && v <= ZOOM_MAX) currentZoom = v
}

function applyZoom() {
  document.documentElement.style.setProperty('--sheet-zoom', String(currentZoom))
  try {
    localStorage.setItem(ZOOM_KEY, String(currentZoom))
  } catch {
    // ignore (modo privado, etc)
  }
  const display = document.querySelector<HTMLSpanElement>('#zoom-display')
  if (display) display.textContent = `${Math.round(currentZoom * 100)}%`
  const zoomOut = document.querySelector<HTMLButtonElement>('#zoom-out')
  const zoomIn = document.querySelector<HTMLButtonElement>('#zoom-in')
  if (zoomOut) zoomOut.disabled = currentZoom <= ZOOM_MIN + 1e-6
  if (zoomIn) zoomIn.disabled = currentZoom >= ZOOM_MAX - 1e-6
}

function clampZoom(v: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(v * 10) / 10))
}

function bindZoomControls() {
  el<HTMLButtonElement>('#zoom-out').addEventListener('click', () => {
    currentZoom = clampZoom(currentZoom - ZOOM_STEP)
    applyZoom()
  })
  el<HTMLButtonElement>('#zoom-in').addEventListener('click', () => {
    currentZoom = clampZoom(currentZoom + ZOOM_STEP)
    applyZoom()
  })
  applyZoom()
}

const WEEKDAY_FMT = new Intl.DateTimeFormat('pt-BR', { weekday: 'short' })

function parseSheetDate(raw: string): Date | null {
  // Aceita DD-MM-YYYY (formato novo), DD_MM_YYYY e YYYY_MM_DD (legados).
  let m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw)
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
  m = /^(\d{2})_(\d{2})_(\d{4})$/.exec(raw)
  if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
  m = /^(\d{4})_(\d{2})_(\d{2})/.exec(raw)
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return null
}

/** Sempre exibe DD-MM-YYYY Dia mesmo pra dados antigos salvos com underscores. */
function formatDateForDisplay(raw: string): string {
  const date = parseSheetDate(raw)
  if (!date || Number.isNaN(date.getTime())) return raw
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yyyy = date.getFullYear()
  const weekday = WEEKDAY_FMT.format(date).replace(/\.$/, '')
  const weekdayLabel = weekday.charAt(0).toUpperCase() + weekday.slice(1)
  return `${dd}-${mm}-${yyyy} ${weekdayLabel}`
}

function formatDateForUrl(raw: string): string {
  const date = parseSheetDate(raw)
  if (!date || Number.isNaN(date.getTime())) return raw
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const yyyy = date.getFullYear()
  return `${dd}-${mm}-${yyyy}`
}

function getUrlDate(): string | null {
  const raw = new URLSearchParams(location.search).get('date')?.trim()
  return raw ? formatDateForUrl(raw) : null
}

function setUrlDate(date: string | null) {
  const url = new URL(location.href)
  if (date) url.searchParams.set('date', formatDateForUrl(date))
  else url.searchParams.delete('date')
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

function applyUrlDateFilter() {
  const requested = getUrlDate()
  if (!requested) return
  const match = grid.getAvailableDates().find((d) => formatDateForUrl(d) === requested)
  if (!match) {
    setUrlDate(null)
    return
  }
  if (grid.getDateFilter() !== match) grid.setDateFilter(match)
  setUrlDate(match)
}

function getUrlWorkbookId(): string | null {
  const raw = new URLSearchParams(location.search).get('workbook')?.trim()
  return raw || null
}

function setUrlWorkbookId(workbookId: string | null) {
  const url = new URL(location.href)
  if (workbookId) {
    url.searchParams.set('workbook', workbookId)
  } else {
    url.searchParams.delete('workbook')
    url.searchParams.delete('date')
    url.searchParams.delete('modelo')
    url.searchParams.delete('status')
    url.searchParams.delete('sort')
  }
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

function getUrlGridViewState(): GridViewState {
  const params = new URLSearchParams(location.search)
  const filters: GridViewState['filters'] = []
  const modelos = params.getAll('modelo')
  const statuses = params.getAll('status')
  if (modelos.length > 0) filters.push({ col: MODEL_COLUMN_INDEX, values: modelos })
  if (statuses.length > 0) filters.push({ col: STATUS_COLUMN_INDEX, values: statuses })

  const sortRaw = params.get('sort')
  const sortMatch = /^(\d+):(asc|desc)$/.exec(sortRaw ?? '')
  return {
    filters,
    sort: sortMatch
      ? { col: Number(sortMatch[1]), dir: sortMatch[2] as 'asc' | 'desc' }
      : null,
  }
}

function setUrlGridViewState(state: GridViewState) {
  const url = new URL(location.href)
  url.searchParams.delete('modelo')
  url.searchParams.delete('status')
  url.searchParams.delete('sort')

  for (const filter of state.filters) {
    const param = filter.col === MODEL_COLUMN_INDEX
      ? 'modelo'
      : filter.col === STATUS_COLUMN_INDEX
        ? 'status'
        : null
    if (!param) continue
    for (const value of filter.values) url.searchParams.append(param, value)
  }
  if (state.sort) url.searchParams.set('sort', `${state.sort.col}:${state.sort.dir}`)
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
}

function applyUrlGridViewState() {
  grid.setViewState(getUrlGridViewState())
  setUrlGridViewState(grid.getViewState())
}

function renderDateSelect() {
  const wrap = el<HTMLDivElement>('#date-select-wrap')
  const select = el<HTMLSelectElement>('#date-select')
  const deleteBtn = el<HTMLButtonElement>('#date-delete-btn')
  const dates = grid.getAvailableDates()
  if (dates.length === 0) {
    wrap.hidden = true
    select.innerHTML = ''
    setUrlDate(null)
    return
  }
  wrap.hidden = false
  const sorted = [...dates].sort((a, b) => {
    const da = parseSheetDate(a)?.getTime() ?? 0
    const db = parseSheetDate(b)?.getTime() ?? 0
    return da - db
  })
  const active = grid.getDateFilter()
  select.innerHTML = sorted
    .map((d) => {
      const label = formatDateForDisplay(d)
      const selected = d === active ? ' selected' : ''
      return `<option value="${d}"${selected}>${label}</option>`
    })
    .join('')
  select.onchange = () => {
    grid.setDateFilter(select.value)
    setUrlDate(select.value)
    updateStatusCounts()
  }
  deleteBtn.onclick = () => {
    const date = grid.getDateFilter()
    if (!date || !currentWorkbookId) return
    const sheet = grid.getActiveSheet()
    const count = (sheet?.rowDates ?? []).filter((d) => d === date).length
    openConfirmDialog({
      title: `Apagar data ${formatDateForDisplay(date)}?`,
      body: `Vai apagar <strong>${count} pedido${count === 1 ? '' : 's'}</strong> desta data (e suas fotos). A data sai do seletor. Esta ação não pode ser desfeita.`,
      confirmLabel: 'Apagar',
      danger: true,
      onConfirm: async () => {
        setStatusText(`Apagando data ${date}...`)
        try {
          const result = await deleteOrdersBySheetDate(currentWorkbookId!, date)
          await refreshFromServer({ force: true })
          setStatusText(`Data ${date} apagada (${result.deleted} pedidos removidos)`)
        } catch (error) {
          handleApiError(error, 'Falha ao apagar data')
        }
      },
    })
  }
}

function getOrderId(rowIndex: number): string | null {
  if (!workbook) return null
  const sheet = workbook.sheets[workbook.sheetOrder[0]]
  const id = sheet?.rows[rowIndex]?.[ID_COL]
  return id == null ? null : String(id).trim() || null
}

function getOrderKey(rowIndex: number): string | null {
  if (!workbook) return null
  const sheet = workbook.sheets[workbook.sheetOrder[0]]
  return sheet?.rowKeys?.[rowIndex] ?? getOrderId(rowIndex)
}

type ChangeBatch = ReadonlyArray<{ row: number; col: number; value: CellValue }>

async function handleCellChange(changes: ChangeBatch) {
  if (!workbook || !currentWorkbookId || changes.length === 0) return
  const sheetId = grid.getActiveSheetId()
  if (!sheetId) return
  const sheet = workbook.sheets[sheetId]
  if (!sheet) return

  const byRow = new Map<number, Array<{ col: number; value: CellValue }>>()
  for (const { row, col, value } of changes) {
    if (!sheet.rows[row]) sheet.rows[row] = []
    sheet.rows[row][col] = value
    const list = byRow.get(row) ?? []
    list.push({ col, value })
    byRow.set(row, list)
  }
  grid.render()

  await Promise.all([...byRow.entries()].map(([row, cells]) =>
    enqueueMutation(async () => {
      if (!workbook || !currentWorkbookId) return
      const orderKey = getOrderKey(row)
      const orderId = getOrderId(row) ?? orderKey
      if (!orderKey) return
      try {
        const result = await patchOrderDelta(currentWorkbookId, orderKey, { cells })
        serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt)
        setStatusText('Alteração salva')
      } catch (error) {
        addPendingMutation({
          kind: 'cell',
          orderId: orderId ?? '',
          rowIndex: row,
          col: cells[0]?.col ?? 0,
          sheetDate: sheet.rowDates?.[row] ?? '',
          description: `Alteração em ${cells.length} célula${cells.length === 1 ? '' : 's'}`,
          error,
        })
        handleApiError(error, 'Falha ao salvar alteração')
      }
    }),
  ))
}

function handleSelect(_ref: string, _value: CellValue, count: number) {
  el<HTMLSpanElement>('#selection-count').textContent =
    `${count} linha${count === 1 ? '' : 's'} selecionada${count === 1 ? '' : 's'}`
}

async function handleEtiqueta(color: string | null) {
  if (!workbook || !currentWorkbookId) return
  const sel = grid.getSelection()
  if (!sel) return
  const rows = getCurrentSelectedRows()
  const col = sel.col
  const stylePatch: OrderStyleDelta = color ? { col, bg: color } : { col, clearBg: true }
  grid.applyCellBackground(color)
  const sheet = workbook.sheets[workbook.sheetOrder[0]]
  await Promise.all(rows.map((row) =>
    enqueueMutation(async () => {
      if (!workbook || !currentWorkbookId) return
      const orderKey = getOrderKey(row)
      const orderId = getOrderId(row) ?? orderKey
      if (!orderKey) return
      try {
        const result = await patchOrderDelta(currentWorkbookId, orderKey, { stylePatches: [stylePatch] })
        serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt)
        setStatusText('Etiqueta salva')
      } catch (error) {
        addPendingMutation({
          kind: 'style',
          orderId: orderId ?? '',
          rowIndex: row,
          col,
          sheetDate: sheet?.rowDates?.[row] ?? '',
          description: color ? 'Aplicar etiqueta' : 'Limpar etiqueta',
          error,
        })
        handleApiError(error, 'Falha ao salvar etiqueta')
      }
    }),
  ))
}

function handleCommentRequest(row: number, col: number) {
  if (!workbook || !currentWorkbookId || col !== RECIPIENT_COLUMN_INDEX) return
  const sheet = workbook.sheets[workbook.sheetOrder[0]]
  if (!sheet) return
  const key = `${row}:${col}`
  const current = sheet.cellStyles?.[key]?.comment ?? ''
  openTextareaDialog({
    title: 'Comentário do destinatário',
    label: 'Comentário',
    defaultValue: current,
    confirmLabel: 'Salvar',
    onConfirm: async (value) => {
      const next = value.trim()
      const stylePatch: OrderStyleDelta = next ? { col, comment: next } : { col, clearComment: true }
      sheet.cellStyles ||= {}
      if (next) {
        sheet.cellStyles[key] = { ...(sheet.cellStyles[key] ?? {}), comment: next }
      } else {
        const style = sheet.cellStyles[key]
        if (style) {
          delete style.comment
          if (Object.keys(style).length === 0) delete sheet.cellStyles[key]
        }
      }
      grid.render()
      await enqueueMutation(async () => {
        if (!workbook || !currentWorkbookId) return
        const orderKey = getOrderKey(row)
        const orderId = getOrderId(row) ?? orderKey
        if (!orderKey) return
        try {
          const result = await patchOrderDelta(currentWorkbookId, orderKey, { stylePatches: [stylePatch] })
          serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt)
          setStatusText('Comentário salvo')
        } catch (error) {
          addPendingMutation({
            kind: 'comment',
            orderId: orderId ?? '',
            rowIndex: row,
            col,
            sheetDate: sheet.rowDates?.[row] ?? '',
            description: next ? 'Salvar comentário' : 'Limpar comentário',
            error,
          })
          handleApiError(error, 'Falha ao salvar comentário')
        }
      })
    },
  })
}

function cellText(row: CellValue[], col: number): string {
  const v = row[col]
  return v == null ? '' : String(v).trim()
}

async function refreshLinkedBuyerChats() {
  if (!grid) return
  try {
    const usernames = await fetchLinkedBuyerUsernames()
    grid.setLinkedChatUsernames(usernames)
  } catch {
    grid.setLinkedChatUsernames([])
  }
}

function handleChatRequest(row: number, col: number) {
  if (!workbook || col !== RECIPIENT_COLUMN_INDEX) return
  const sheet = workbook.sheets[workbook.sheetOrder[0]]
  if (!sheet) return
  const cells = sheet.rows[row]
  if (!cells) return
  const buyerUsername = cellText(cells, BUYER_USERNAME_COL)
  if (!buyerUsername) {
    openAlertDialog({ title: 'Chat Shopee', body: 'Esta linha não tem username na coluna E.' })
    return
  }
  void openShopeeChatPanel({
    orderId: cellText(cells, ID_COL) || '—',
    product: cellText(cells, PRODUCT_COL),
    model: cellText(cells, MODEL_COLUMN_INDEX),
    quantity: cellText(cells, QTY_COL),
    status: cellText(cells, STATUS_COLUMN_INDEX),
    buyerUsername,
    recipient: cellText(cells, RECIPIENT_COLUMN_INDEX),
    sheetDate: sheet.rowDates?.[row] ?? '',
  })
}

function getCurrentSelectedRows(): number[] {
  const sel = grid.getSelection()
  if (!sel) return []
  const tds = document.querySelectorAll<HTMLElement>('td.is-selected')
  const rows = new Set<number>()
  tds.forEach((td) => {
    const r = Number(td.dataset.row)
    if (Number.isFinite(r)) rows.add(r)
  })
  if (rows.size === 0) rows.add(sel.row)
  return [...rows]
}

async function blobToJpeg(blob: Blob, quality = 0.85): Promise<Blob> {
  if (blob.type === 'image/jpeg') return blob
  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) return blob
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(bitmap, 0, 0)
  return new Promise((resolve) => {
    canvas.toBlob(
      (result) => resolve(result ?? blob),
      'image/jpeg',
      quality,
    )
  })
}

async function pickImageFile(row: number, col: number) {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.style.display = 'none'
  document.body.appendChild(input)
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    input.remove()
    if (!file || !file.type.startsWith('image/')) return
    await uploadAndSetImage(row, col, file, file.name)
  })
  input.click()
}

async function uploadAndSetImage(row: number, col: number, blob: Blob, fileName: string) {
  if (!currentWorkbookId) return
  const orderKey = getOrderKey(row)
  const orderId = getOrderId(row) ?? orderKey
  if (!orderKey) {
    setStatusText('Pedido sem ID — não pode ter foto')
    return
  }
  grid.setCellImage(row, col, blob, fileName)
  setStatusText('Convertendo e enviando foto...')
  try {
    const jpeg = await blobToJpeg(blob)
    const safeName = fileName.replace(/\.[^.]+$/, '') + '.jpg'
    await enqueueMutation(async () => {
      if (!currentWorkbookId) return
      try {
        const result = await uploadImage(currentWorkbookId, orderKey, col, jpeg, safeName)
        if (!workbook) return
        const sheet = workbook.sheets[workbook.sheetOrder[0]]
        if (!sheet) return
        sheet.images[`${row}:${col}`] = { url: result.url, fileName: safeName, updatedAt: result.updatedAt }
        grid.render()
        serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt)
        setStatusText(`Foto enviada (${Math.round(jpeg.size / 1024)} KB)`)
      } catch (error) {
        addPendingMutation({
          kind: 'image',
          orderId: orderId ?? '',
          rowIndex: row,
          col,
          sheetDate: workbook?.sheets[workbook.sheetOrder[0]]?.rowDates?.[row] ?? '',
          description: `Enviar foto ${grid.getPhotoColumnIndices().indexOf(col) + 1}`,
          error,
        })
        handleApiError(error, 'Falha ao enviar foto')
      }
    })
  } catch (error) {
    handleApiError(error, 'Falha ao enviar foto')
  }
}

async function deleteImageAt(row: number, col: number) {
  if (!currentWorkbookId) return
  const orderKey = getOrderKey(row)
  const orderId = getOrderId(row) ?? orderKey
  if (!orderKey) return
  const sheetDate = workbook?.sheets[workbook.sheetOrder[0]]?.rowDates?.[row] ?? ''
  grid.removeCellImage(row, col)
  await enqueueMutation(async () => {
    if (!currentWorkbookId) return
    try {
      const result = await deleteImage(currentWorkbookId, orderKey, col)
      serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt)
      setStatusText('Foto removida')
    } catch (error) {
      addPendingMutation({
        kind: 'image',
        orderId: orderId ?? '',
        rowIndex: row,
        col,
        sheetDate,
        description: `Remover foto ${grid.getPhotoColumnIndices().indexOf(col) + 1}`,
        error,
      })
      handleApiError(error, 'Falha ao remover foto')
    }
  })
}

function bindClipboardPaste() {
  document.addEventListener('paste', (event) => {
    const target = event.target as HTMLElement | null
    const tag = target?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (target?.isContentEditable ?? false)) return

    const items = event.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (!item.type.startsWith('image/')) continue
      const blob = item.getAsFile()
      if (!blob) continue
      event.preventDefault()
      const sel = grid.getSelection()
      if (!sel || !grid.getPhotoColumnIndices().includes(sel.col)) {
        setStatusText('Selecione uma célula de Foto 1 a Foto 10 para colar a imagem')
        return
      }
      const fileName = `clipboard-${Date.now()}.jpg`
      void uploadAndSetImage(sel.row, sel.col, blob, fileName)
      return
    }
  })
}

function bindEtiquetas() {
  document.querySelectorAll<HTMLButtonElement>('.etiqueta-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const color = button.dataset.bg || null
      void handleEtiqueta(color)
    })
  })
}

function closeSearchResults() {
  const panel = el<HTMLDivElement>('#search-results')
  panel.hidden = true
  panel.innerHTML = ''
  searchHighlightIndex = -1
}

function renderSearchResults(query: string) {
  const panel = el<HTMLDivElement>('#search-results')
  const counter = el<HTMLSpanElement>('#search-count')
  if (!workbook || !query) {
    closeSearchResults()
    counter.hidden = true
    return
  }
  const hits = searchWorkbook(workbook, query)
  lastSearchHits = hits
  if (hits.length === 0) {
    panel.hidden = false
    panel.innerHTML = '<div class="search-empty">Nenhum resultado</div>'
    counter.hidden = false
    counter.textContent = '0'
    return
  }
  counter.hidden = false
  counter.textContent = hits.length >= 80 ? '80+' : String(hits.length)
  panel.hidden = false
  panel.innerHTML = ''
  hits.forEach((hit, index) => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = 'search-result' + (index === 0 ? ' is-focused' : '')
    item.dataset.index = String(index)
    item.innerHTML = `
      <span class="search-result-tag">${escapeHtml(hit.sheetName)}</span>
      <span class="search-result-ref">${formatHitRef(hit)}</span>
      <span class="search-result-value">${highlightMatch(hit.value, query)}</span>
    `
    item.addEventListener('click', () => {
      // troca pra data do hit antes de navegar — search retorna hits de outros
      // dias e o navigateTo so funciona em rows visiveis no filtro atual.
      if (hit.sheetDate && grid.getDateFilter() !== hit.sheetDate) {
        grid.setDateFilter(hit.sheetDate)
        setUrlDate(hit.sheetDate)
        renderDateSelect()
      }
      grid.navigateTo(hit.sheetId, hit.rowIndex < 0 ? 0 : hit.rowIndex, hit.colIndex)
      closeSearchResults()
      el<HTMLInputElement>('#search-input').value = ''
      counter.hidden = true
    })
    panel.appendChild(item)
  })
  searchHighlightIndex = 0
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function moveSearchFocus(delta: number) {
  if (lastSearchHits.length === 0) return
  const items = el<HTMLDivElement>('#search-results').querySelectorAll<HTMLButtonElement>('.search-result')
  if (items.length === 0) return
  items[searchHighlightIndex]?.classList.remove('is-focused')
  searchHighlightIndex = (searchHighlightIndex + delta + items.length) % items.length
  const next = items[searchHighlightIndex]
  next?.classList.add('is-focused')
  next?.scrollIntoView({ block: 'nearest' })
}

function jumpToFocusedHit() {
  if (lastSearchHits.length === 0) return
  const hit = lastSearchHits[searchHighlightIndex] ?? lastSearchHits[0]
  if (!hit) return
  grid.navigateTo(hit.sheetId, hit.rowIndex < 0 ? 0 : hit.rowIndex, hit.colIndex)
  el<HTMLInputElement>('#search-input').value = ''
  el<HTMLSpanElement>('#search-count').hidden = true
  closeSearchResults()
}

function bindSearch() {
  const input = el<HTMLInputElement>('#search-input')
  input.addEventListener('input', () => {
    const query = input.value
    if (searchTimer) window.clearTimeout(searchTimer)
    searchTimer = window.setTimeout(() => renderSearchResults(query), 120)
  })
  input.addEventListener('focus', () => {
    if (input.value.trim()) renderSearchResults(input.value)
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      moveSearchFocus(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      moveSearchFocus(-1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      jumpToFocusedHit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      input.value = ''
      el<HTMLSpanElement>('#search-count').hidden = true
      closeSearchResults()
      input.blur()
    }
  })
  document.addEventListener('mousedown', (event) => {
    const target = event.target as HTMLElement
    if (!target.closest('.search-box')) closeSearchResults()
  })
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      input.focus()
      input.select()
      return
    }
    // Não processa atalhos da grid se o foco está em algum input/textarea/edit.
    const target = event.target as HTMLElement | null
    const tag = target?.tagName
    const inField = tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable === true
    if (inField) return
    if (!grid) return

    // Ctrl/Cmd+C: copia os valores das células selecionadas (1 col × N linhas).
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault()
      void grid.copySelectedToClipboard().then((n) => {
        if (n > 0) setStatusText(`${n} valor(es) copiado(s)`)
      })
      return
    }

    // Type-to-jump (Windows Explorer style) — só pra caracteres imprimíveis,
    // sem modificadores. Pula pra próxima célula da coluna selecionada que
    // comece com o que o user digitou.
    if (!event.ctrlKey && !event.metaKey && !event.altKey && event.key.length === 1) {
      if (grid.typeAheadJump(event.key)) {
        event.preventDefault()
      }
    }
  })
}

async function loadFile(file: File) {
  if (!currentWorkbookId) return
  setStatusText('Lendo arquivo...')
  try {
    const parsed = await parseXlsx(file, {
      existing: workbook,
      onProgress: (msg, current, total) => {
        if (current != null && total != null) {
          setStatusText(`${msg}: ${current} / ${total}`)
        } else {
          setStatusText(msg)
        }
      },
    })
    setStatusText('Enviando para o servidor...')
    const sheet = parsed.sheets[parsed.sheetOrder[0]]

    const blobImages: Array<{ row: number; col: number; blob: Blob; fileName: string }> = []
    for (const [key, img] of Object.entries(sheet.images)) {
      const [r, c] = key.split(':').map(Number)
      if (img.blob && !img.url) {
        blobImages.push({ row: r, col: c, blob: img.blob, fileName: img.fileName })
      }
    }

    const orders = sheet.rows.map((row, idx) => ({
      key: sheet.rowKeys?.[idx],
      id: String(row[ID_COL] ?? '').trim() || `order-${idx}-${Date.now()}`,
      row,
      styles: Object.fromEntries(
        Object.entries(sheet.cellStyles ?? {})
          .filter(([k]) => k.startsWith(`${idx}:`))
          .map(([k, v]) => [k.split(':')[1], v]),
      ),
      disappeared: !!sheet.rowFlags?.[idx]?.disappeared,
      sheetDate: sheet.rowDates?.[idx] ?? '',
    }))

    const result = await replaceWorkbook(currentWorkbookId, {
      orders,
      columnWidths: sheet.columnWidths,
    })
    serverUpdatedAt = result.updatedAt

    for (const item of blobImages) {
      const orderKey = orders[item.row]?.key ?? orders[item.row]?.id
      if (!orderKey) continue
      try {
        const jpeg = await blobToJpeg(item.blob)
        await uploadImage(
          currentWorkbookId,
          orderKey,
          item.col,
          jpeg,
          item.fileName.replace(/\.[^.]+$/, '') + '.jpg',
        )
      } catch (error) {
        console.warn('Falha ao enviar imagem do XLSX:', error)
      }
    }

    await refreshFromServer({ force: true })
    setStatusText(`Importado · ${result.count} pedidos`)
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      handleApiError(error)
      return
    }
    console.error(error)
    setStatusText('Falha ao importar')
    alert(`Não foi possível importar este arquivo: ${(error as Error).message}`)
  }
}

function bindFileInput() {
  const input = el<HTMLInputElement>('#file-input')
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) void loadFile(file)
    input.value = ''
  })
}

async function loadPhotos(file: File) {
  if (!currentWorkbookId || !workbook) return
  setStatusText('Lendo XLSX de fotos...')
  try {
    const parsed = await parseXlsx(file, {
      existing: workbook,
      onProgress: (msg, current, total) => {
        if (current != null && total != null) {
          setStatusText(`${msg}: ${current} / ${total}`)
        } else {
          setStatusText(msg)
        }
      },
    })
    const sheet = parsed.sheets[parsed.sheetOrder[0]]
    if (!sheet) {
      setStatusText('XLSX sem dados')
      return
    }

    const currentSheet = workbook.sheets[workbook.sheetOrder[0]]
    const existingIds = new Set<string>()
    for (const row of currentSheet?.rows ?? []) {
      const id = String(row[ID_COL] ?? '').trim()
      if (id) existingIds.add(id)
    }

    const uploads: Array<{ id: string; col: number; blob: Blob; fileName: string }> = []
    const skippedIds = new Set<string>()
    for (const [key, img] of Object.entries(sheet.images)) {
      if (!img.blob || img.url) continue
      const [r, c] = key.split(':').map(Number)
      const id = String(sheet.rows[r]?.[ID_COL] ?? '').trim()
      if (!id) continue
      if (!existingIds.has(id)) {
        skippedIds.add(id)
        continue
      }
      uploads.push({ id, col: c, blob: img.blob, fileName: img.fileName })
    }

    if (uploads.length === 0) {
      const skipMsg = skippedIds.size > 0 ? ` (${skippedIds.size} IDs sem match foram ignorados)` : ''
      setStatusText(`Nenhuma foto pra atualizar${skipMsg}`)
      return
    }

    let done = 0
    let failed = 0
    for (const u of uploads) {
      try {
        const jpeg = await blobToJpeg(u.blob)
        const safeName = u.fileName.replace(/\.[^.]+$/, '') + '.jpg'
        await uploadImage(currentWorkbookId, u.id, u.col, jpeg, safeName)
        done++
        setStatusText(`Enviando fotos: ${done} / ${uploads.length}`)
      } catch (error) {
        failed++
        console.warn('Falha ao enviar foto:', error)
      }
    }

    await refreshFromServer({ force: true })
    const skipMsg = skippedIds.size > 0 ? ` · ${skippedIds.size} IDs ignorados` : ''
    const failMsg = failed > 0 ? ` · ${failed} falhas` : ''
    setStatusText(`Fotos atualizadas: ${done}${skipMsg}${failMsg}`)
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      handleApiError(error)
      return
    }
    console.error(error)
    setStatusText('Falha ao atualizar fotos')
    alert(`Falha ao ler XLSX: ${(error as Error).message}`)
  }
}

function bindPhotosInput() {
  const input = el<HTMLInputElement>('#photos-input')
  input.addEventListener('change', () => {
    const file = input.files?.[0]
    if (file) void loadPhotos(file)
    input.value = ''
  })
}

function bindDropZone() {
  const sheetRoot = el<HTMLDivElement>('#sheet-root')
  sheetRoot.addEventListener('dragover', (event) => {
    event.preventDefault()
    const dropZone = sheetRoot.querySelector('.drop-zone')
    if (dropZone) dropZone.classList.add('is-dragging')
  })
  sheetRoot.addEventListener('dragleave', () => {
    const dropZone = sheetRoot.querySelector('.drop-zone')
    if (dropZone) dropZone.classList.remove('is-dragging')
  })
  sheetRoot.addEventListener('drop', (event) => {
    event.preventDefault()
    const file = event.dataTransfer?.files[0]
    if (file) void loadFile(file)
  })
  sheetRoot.addEventListener('click', (event) => {
    const target = event.target as HTMLElement
    if (target.closest('.drop-zone')) {
      el<HTMLInputElement>('#file-input').click()
    }
  })
}

function bindLogout() {
  el<HTMLButtonElement>('#logout-btn').addEventListener('click', async () => {
    try {
      await logout()
    } catch {
      // ignore
    }
    location.reload()
  })
}

function bindBackButton() {
  el<HTMLButtonElement>('#back-btn').addEventListener('click', () => {
    leaveWorkbook()
    setUrlWorkbookId(null)
    showHome()
  })
}

async function refreshFromServer(options: { force?: boolean } = {}): Promise<boolean> {
  if (!currentWorkbookId) return false
  try {
    const previousSelection = grid.getSelection()
    const response = await fetchWorkbook(
      currentWorkbookId,
      options.force ? undefined : serverUpdatedAt || undefined,
    )
    if (response.unchanged) {
      serverUpdatedAt = response.updatedAt
      return true
    }
    workbook = serverWorkbookToLocal(currentWorkbookId, response)
    grid.setWorkbook(workbook)
    applyUrlDateFilter()
    applyUrlGridViewState()
    if (previousSelection && previousSelection.sheetId === workbook.sheetOrder[0]) {
      grid.restoreSelection(previousSelection.row, previousSelection.col)
    }
    renderDateSelect()
    updateStatusCounts()
    setFilename(workbook.name)
    serverUpdatedAt = response.updatedAt
    return true
  } catch (error) {
    handleApiError(error, 'Falha ao sincronizar')
    return false
  }
}

function startPolling() {
  if (pollTimer) window.clearInterval(pollTimer)
  pollTimer = window.setInterval(() => void refreshFromServer(), POLL_INTERVAL_MS)
}

function stopPolling() {
  if (pollTimer) {
    window.clearInterval(pollTimer)
    pollTimer = null
  }
}

let inflightBatches = 0
async function withPollingPaused<T>(fn: () => Promise<T>): Promise<T> {
  inflightBatches++
  stopPolling()
  try {
    return await fn()
  } finally {
    inflightBatches--
    if (inflightBatches === 0 && currentWorkbookId) startPolling()
  }
}

let mutationQueue: Promise<void> = Promise.resolve()

function enqueueMutation(fn: () => Promise<void>): Promise<void> {
  mutationQueue = mutationQueue
    .catch(() => {
      // A próxima gravação da fila não deve ficar presa por falha anterior.
    })
    .then(() => withPollingPaused(async () => {
      setStatusText('Salvando...')
      await fn()
    }))
  return mutationQueue
}

function handleApiError(error: unknown, fallback?: string) {
  if (error instanceof AuthRequiredError) {
    stopPolling()
    showLoginScreen(() => {
      void init()
    })
    return
  }
  if (fallback) setStatusText(fallback)
  console.error(error)
}

function leaveWorkbook() {
  stopPolling()
  workbook = null
  currentWorkbookId = null
  serverUpdatedAt = 0
}

function fmtScanDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return iso.slice(0, 10)
}

function samplePageMetrics(
  metrics: Array<{
    page: number
    chatsOnPage: number
    indexedOnPage: number
    scannedTotal: number
    newestOnPage: string | null
    oldestOnPage: string | null
    nextTimestampNano: string | null
  }>,
): typeof metrics {
  if (metrics.length <= 30) return metrics
  const picked = new Map<number, (typeof metrics)[number]>()
  for (const m of metrics.slice(0, 8)) picked.set(m.page, m)
  for (const m of metrics) {
    if (m.page % 20 === 0) picked.set(m.page, m)
  }
  for (const m of metrics.slice(-12)) picked.set(m.page, m)
  return [...picked.values()].sort((a, b) => a.page - b.page)
}

function formatPageMetricsLines(
  metrics: Array<{
    page: number
    chatsOnPage: number
    indexedOnPage: number
    scannedTotal: number
    newestOnPage: string | null
    oldestOnPage: string | null
    nextTimestampNano: string | null
  }>,
): string[] {
  if (!metrics.length) return []
  const sample = samplePageMetrics(metrics)
  const lines: string[] = [
    '',
    `--- Paginação (${metrics.length} página(s); amostra abaixo) ---`,
  ]
  let prevPage = 0
  for (const m of sample) {
    if (prevPage && m.page > prevPage + 1) lines.push('…')
    lines.push(
      `Pág ${m.page}: ${m.chatsOnPage} chats (${m.indexedOnPage} indexados) | acum. ${m.scannedTotal} | ${fmtScanDate(m.oldestOnPage)} → ${fmtScanDate(m.newestOnPage)}`,
    )
    if (m.nextTimestampNano) {
      lines.push(`     próximo cursor: ${m.nextTimestampNano}`)
    }
    prevPage = m.page
  }
  return lines
}

function bindShopeeLinkConversations() {
  /** Igual server SHOPEE_LINK_START_PAGE — match só a partir desta página. */
  const SHOPEE_LINK_START_PAGE = 285
  const btn = document.querySelector<HTMLButtonElement>('#shopee-link-conversations-btn')
  if (!btn) return
  btn.addEventListener('click', async () => {
    if (!currentWorkbookId || isShopeeWorkbookId(currentWorkbookId)) return
    const workbookId = currentWorkbookId
    const prevLabel = btn.textContent ?? ''
    btn.disabled = true
    btn.textContent = 'Vinculando…'
    setShopeeActionBanner(
      'Consultando pedidos na Shopee e buscando conversas de cada comprador. Isso pode levar alguns minutos…',
      'loading',
    )
    renderSheetLoading()
    setStatusText('Vinculando conversas Shopee…')
    try {
      await withPollingPaused(async () => {
        let nextTimestampNano: string | undefined
        let pageNumber = 0
        let scannedBefore = 0
        let indexedBefore = 0
        let linked = 0
        let buyersFound = 0
        let ordersQueried = 0
        let done = false
        let doneReason: string | null = null
        const pageMetricsSample: Array<{
          page: number
          chatsOnPage: number
          indexedOnPage: number
          scannedTotal: number
          newestOnPage: string | null
          oldestOnPage: string | null
          nextTimestampNano: string | null
        }> = []
        const errors: string[] = []
        let resumeCursor: string | null = null
        let newestGlobal: string | null = null
        let oldestGlobal: string | null = null
        const maxPages = 10_000

        while (!done && pageNumber < maxPages) {
          const advanceOnly = pageNumber < SHOPEE_LINK_START_PAGE - 1
          const chunk = await linkShopeeConversationsScanChunk(workbookId, {
            nextTimestampNano,
            pageNumber,
            scannedBefore,
            indexedBefore,
            advanceOnly,
          })
          ordersQueried = chunk.ordersQueried
          buyersFound = chunk.buyersFound
          linked = chunk.linked
          pageNumber = chunk.conversationPages
          scannedBefore = chunk.conversationsScanned
          indexedBefore = chunk.conversationsIndexed
          if (chunk.errors.length) errors.push(...chunk.errors)
          if (chunk.pageMetric) {
            if (!advanceOnly) pageMetricsSample.push(chunk.pageMetric)
            const n = chunk.pageMetric.newestOnPage
            const o = chunk.pageMetric.oldestOnPage
            if (n && (!newestGlobal || n > newestGlobal)) newestGlobal = n
            if (o && (!oldestGlobal || o < oldestGlobal)) oldestGlobal = o
            const pm = chunk.pageMetric
            if (advanceOnly) {
              setStatusText(
                `Avançando até pág ${SHOPEE_LINK_START_PAGE}… ${pm.page}/${SHOPEE_LINK_START_PAGE - 1} | acum. ${pm.scannedTotal} | ${fmtScanDate(pm.oldestOnPage)} → ${fmtScanDate(pm.newestOnPage)}`,
              )
              setShopeeActionBanner(
                `Posicionando na página ${SHOPEE_LINK_START_PAGE}… (${pm.page}/${SHOPEE_LINK_START_PAGE - 1})`,
                'loading',
              )
            } else {
              setStatusText(
                `Pág ${pm.page}: ${pm.chatsOnPage} chats | acum. ${pm.scannedTotal} | ${fmtScanDate(pm.oldestOnPage)} → ${fmtScanDate(pm.newestOnPage)} | ${linked}/${buyersFound} vinculados`,
              )
              setShopeeActionBanner(
                `Varrendo conversas Shopee… página ${pm.page}, ${pm.scannedTotal} chats, ${linked} de ${buyersFound} vinculados`,
                'loading',
              )
            }
          }
          resumeCursor = chunk.nextTimestampNano
          done = chunk.done
          doneReason = chunk.doneReason
          if (chunk.errors.length) break
          if (done) break
          if (!chunk.hasMore || !chunk.nextTimestampNano) break
          nextTimestampNano = chunk.nextTimestampNano
        }

        const notFound = Math.max(buyersFound - linked, 0)
        const ok = errors.length === 0 && buyersFound > 0
        const short =
          buyersFound === 0
            ? 'Nenhum comprador encontrado nos pedidos desta planilha.'
            : `${linked} conversa(s) vinculada(s), ${notFound} sem chat (${buyersFound} compradores).`
        setShopeeActionBanner(short, ok ? 'success' : 'error')
        setStatusText(short)
        const detail = [
          `Varredura a partir da página ${SHOPEE_LINK_START_PAGE}`,
          `Pedidos únicos consultados: ${ordersQueried}`,
          `Compradores na planilha (col E): ${buyersFound}`,
          `Conversas vinculadas: ${linked}`,
          `Sem chat encontrado: ${notFound}`,
          `Chats listados na Shopee: ${scannedBefore} (${pageNumber} página(s))`,
          `Chats com ID reconhecido: ${indexedBefore}`,
        ]
        if (doneReason === 'all_found') detail.push('Parou: todos os compradores vinculados.')
        if (doneReason === 'no_more') detail.push('Parou: fim da lista de conversas na Shopee.')
        if (newestGlobal) detail.push(`Chat mais recente varrido: ${newestGlobal.slice(0, 10)}`)
        if (oldestGlobal) detail.push(`Chat mais antigo varrido: ${oldestGlobal.slice(0, 10)}`)
        detail.push(...formatPageMetricsLines(pageMetricsSample))
        if (resumeCursor && !done) {
          detail.push('', 'Para retomar (startTimestampNano):', resumeCursor)
        }
        if (errors.length) {
          detail.push('', 'Erros:', ...errors.slice(0, 8))
          if (errors.length > 8) detail.push(`… e mais ${errors.length - 8}`)
        }
        openAlertDialog({
          title: errors.length ? 'Vincular conversas — com avisos' : 'Vincular conversas — concluído',
          body: detail.join('\n'),
        })
        if (errors.length) console.warn('[shopee-link-conversations]', errors)
        if (pageMetricsSample.length) {
          console.info('[shopee-link-conversations] pageMetrics', pageMetricsSample)
        }
        await refreshLinkedBuyerChats()
      })
    } catch (error) {
      const msg = (error as Error).message
      setShopeeActionBanner(`Falha ao vincular conversas: ${msg}`, 'error')
      setStatusText(`Erro ao vincular conversas: ${msg}`)
      openAlertDialog({ title: 'Vincular conversas — erro', body: msg })
    } finally {
      btn.disabled = false
      btn.textContent = prevLabel
      stopSheetLoading()
    }
  })
}

function bindShopeeImport() {
  const btn = document.querySelector<HTMLButtonElement>('#shopee-import-btn')
  if (!btn) return
  btn.addEventListener('click', async () => {
    if (!currentWorkbookId || !isShopeeWorkbookId(currentWorkbookId)) return
    btn.disabled = true
    setStatusText('Importando pedidos Shopee…')
    try {
      const result = await syncShopeeWorkbookInitial(5, (done, total, parcel) => {
        setStatusText(`Importando dia ${done}/${total} — ${parcel.created} novos neste lote`)
      })
      await refreshFromServer({ force: true })
      setStatusText(`Importação concluída — ${result.created} novos, ${result.updated} atualizados`)
      if (result.errors.length) {
        alert(`${result.errors.length} erro(s) na importação — veja o console`)
        console.warn('[shopee-import]', result.errors)
      }
    } catch (error) {
      setStatusText(`Erro na importação: ${(error as Error).message}`)
    } finally {
      btn.disabled = false
    }
  })
}

function applyShopeeWorkbookToolbar(workbookId: string) {
  const isShopee = isShopeeWorkbookId(workbookId)
  setToolbarBtnVisible(document.querySelector('#shopee-import-btn'), isShopee)
  setToolbarBtnVisible(document.querySelector('#shopee-link-conversations-btn'), !isShopee)
  setToolbarBtnVisible(document.querySelector('#xlsx-update-label'), !isShopee)
  setToolbarBtnVisible(document.querySelector('#xlsx-photos-label'), !isShopee)
  setShopeeActionBanner('', 'hidden')
}

async function enterWorkbook(workbookId: string) {
  currentWorkbookId = workbookId
  setUrlWorkbookId(workbookId)
  serverUpdatedAt = 0
  workbook = null
  buildShell()
  grid = new GridView(el<HTMLDivElement>('#sheet-root'), {
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
    onViewStateChange: () => {
      setUrlGridViewState(grid.getViewState())
      updateStatusCounts()
    },
  })
  renderSheetLoading()
  bindFileInput()
  bindPhotosInput()
  bindDropZone()
  bindSearch()
  bindEtiquetas()
  bindClipboardPaste()
  bindLogout()
  bindBackButton()
  bindZoomControls()
  bindPendingMutationsButton()
  applyShopeeWorkbookToolbar(workbookId)
  bindShopeeImport()
  bindShopeeLinkConversations()
  try {
    await refreshFromServer({ force: true })
  } finally {
    stopSheetLoading()
  }
  await refreshLinkedBuyerChats()
  startPolling()
}

async function createWorkbookFromXlsx(file: File) {
  const name = file.name.replace(/\.[^.]+$/, '').trim() || 'Sem nome'
  const wb = await createWorkbook(name)
  await enterWorkbook(wb.id)
  await loadFile(file)
}

function showHome() {
  const app = el<HTMLDivElement>('#app')
  showWorkbooksList({
    root: app,
    onOpen: (id) => void enterWorkbook(id),
    onCreateFromXlsx: createWorkbookFromXlsx,
    onAuthLost: () => {
      showLoginScreen(() => {
        void init()
      })
    },
    onLogout: async () => {
      try {
        await logout()
      } catch {
        // ignore
      }
      location.reload()
    },
  })
}

async function init() {
  void FIXED_HEADERS
  loadZoom()
  const ok = await checkAuth()
  if (!ok) {
    showLoginScreen(() => {
      void init()
    })
    return
  }
  const workbookId = getUrlWorkbookId()
  if (workbookId) {
    await enterWorkbook(workbookId)
    return
  }
  showHome()
}

void init()
