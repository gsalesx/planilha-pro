import './style.css'

import {
  AuthRequiredError,
  checkAuth,
  createWorkbook,
  deleteImage,
  deleteOrdersBySheetDate,
  fetchWorkbook,
  logout,
  patchOrder,
  replaceWorkbook,
  serverWorkbookToLocal,
  uploadImage,
} from './api'
import { openConfirmDialog } from './dialog'
import { GridView, PHOTO_COLUMN_INDICES } from './grid'
import { showLoginScreen } from './login'
import { formatHitRef, highlightMatch, searchWorkbook, type SearchHit } from './search'
import type { CellValue, WorkbookData } from './types'
import { showWorkbooksList } from './workbooks-list'
import { FIXED_HEADERS, parseXlsx } from './xlsx-parser'

const POLL_INTERVAL_MS = 8000
const ID_COL = 0

let workbook: WorkbookData | null = null
let grid: GridView
let serverUpdatedAt = 0
let pollTimer: number | null = null
let searchTimer: number | null = null
let lastSearchHits: SearchHit[] = []
let searchHighlightIndex = -1
let currentWorkbookId: string | null = null

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
          <label class="btn btn-primary" title="Carrega um novo XLSX preservando edições manuais por ID do pedido">
            <input type="file" id="file-input" accept=".xlsx,.xls" hidden />
            ⟳ Atualizar Planilha
          </label>
          <label class="btn" title="Atualiza só as fotos a partir de um XLSX, casando por ID do pedido. Pedidos sem match são ignorados.">
            <input type="file" id="photos-input" accept=".xlsx,.xls" hidden />
            🖼 Atualizar Fotos
          </label>
          <button class="btn" id="logout-btn" title="Sair">Sair</button>
        </div>
      </header>
      <div class="etiqueta-bar" role="toolbar" aria-label="Etiquetas">
        <span id="selection-count" style="margin-right:auto;font-size:12px;color:#475569;font-weight:600;">1 linha selecionada</span>
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

function renderDateSelect() {
  const wrap = el<HTMLDivElement>('#date-select-wrap')
  const select = el<HTMLSelectElement>('#date-select')
  const deleteBtn = el<HTMLButtonElement>('#date-delete-btn')
  const dates = grid.getAvailableDates()
  if (dates.length === 0) {
    wrap.hidden = true
    select.innerHTML = ''
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

function getRowStylesAsRecord(rowIndex: number): Record<string, { bg?: string }> {
  if (!workbook) return {}
  const sheet = workbook.sheets[workbook.sheetOrder[0]]
  const out: Record<string, { bg?: string }> = {}
  for (const [key, val] of Object.entries(sheet?.cellStyles ?? {})) {
    const [r, c] = key.split(':').map(Number)
    if (r === rowIndex && val?.bg) out[c] = val
  }
  return out
}

type ChangeBatch = ReadonlyArray<{ row: number; col: number; value: CellValue }>

async function handleCellChange(changes: ChangeBatch) {
  if (!workbook || !currentWorkbookId || changes.length === 0) return
  const sheetId = grid.getActiveSheetId()
  if (!sheetId) return
  const sheet = workbook.sheets[sheetId]
  if (!sheet) return

  const byRow = new Map<number, { row: number; cols: number[] }>()
  for (const { row, col, value } of changes) {
    if (!sheet.rows[row]) sheet.rows[row] = []
    sheet.rows[row][col] = value
    if (!byRow.has(row)) byRow.set(row, { row, cols: [] })
    byRow.get(row)!.cols.push(col)
  }
  grid.render()

  await withPollingPaused(async () => {
    for (const { row } of byRow.values()) {
      const id = getOrderId(row)
      if (!id) continue
      try {
        const result = await patchOrder(currentWorkbookId!, id, { row: sheet.rows[row] })
        serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt)
      } catch (error) {
        handleApiError(error, 'Falha ao salvar alteração')
      }
    }
  })
}

function selectedLineCountFromRef(ref: string): number {
  const match = /^[A-Z]+(\d+)(?::[A-Z]+(\d+))?$/.exec(ref)
  if (!match) return 1
  const start = Number(match[1])
  const end = Number(match[2] ?? match[1])
  return Math.max(1, Math.abs(end - start) + 1)
}

function handleSelect(ref: string, _value: CellValue) {
  const count = selectedLineCountFromRef(ref)
  el<HTMLSpanElement>('#selection-count').textContent =
    `${count} linha${count === 1 ? '' : 's'} selecionada${count === 1 ? '' : 's'}`
}

async function handleEtiqueta(color: string | null) {
  if (!workbook || !currentWorkbookId) return
  const sel = grid.getSelection()
  if (!sel) return
  // Captura linhas ANTES do applyCellBackground/render — evita perder
  // a selecao se algo (re-render, polling tardio) mexer no DOM no meio.
  const rows = getCurrentSelectedRows()
  grid.applyCellBackground(color)
  const sheet = workbook.sheets[workbook.sheetOrder[0]]
  if (!sheet) return
  await withPollingPaused(async () => {
    for (const row of rows) {
      const id = getOrderId(row)
      if (!id) continue
      try {
        const result = await patchOrder(currentWorkbookId!, id, { styles: getRowStylesAsRecord(row) })
        serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt)
      } catch (error) {
        handleApiError(error, 'Falha ao salvar etiqueta')
      }
    }
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
  const id = getOrderId(row)
  if (!id) {
    setStatusText('Pedido sem ID — não pode ter foto')
    return
  }
  grid.setCellImage(row, col, blob, fileName)
  setStatusText('Convertendo e enviando foto...')
  try {
    const jpeg = await blobToJpeg(blob)
    const safeName = fileName.replace(/\.[^.]+$/, '') + '.jpg'
    const result = await uploadImage(currentWorkbookId, id, col, jpeg, safeName)
    if (!workbook) return
    const sheet = workbook.sheets[workbook.sheetOrder[0]]
    if (!sheet) return
    sheet.images[`${row}:${col}`] = { url: result.url, fileName: safeName, updatedAt: result.updatedAt }
    grid.render()
    serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt)
    setStatusText(`Foto enviada (${Math.round(jpeg.size / 1024)} KB)`)
  } catch (error) {
    handleApiError(error, 'Falha ao enviar foto')
  }
}

async function deleteImageAt(row: number, col: number) {
  if (!currentWorkbookId) return
  const id = getOrderId(row)
  if (!id) return
  grid.removeCellImage(row, col)
  try {
    await deleteImage(currentWorkbookId, id, col)
  } catch (error) {
    handleApiError(error, 'Falha ao remover foto')
  }
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
      if (!sel || !PHOTO_COLUMN_INDICES.includes(sel.col)) {
        setStatusText('Selecione uma célula de Foto (H, I ou J) para colar a imagem')
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
      const orderId = orders[item.row]?.id
      if (!orderId) continue
      try {
        const jpeg = await blobToJpeg(item.blob)
        await uploadImage(
          currentWorkbookId,
          orderId,
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
    showHome()
  })
}

async function refreshFromServer(options: { force?: boolean } = {}): Promise<void> {
  if (!currentWorkbookId) return
  try {
    const response = await fetchWorkbook(
      currentWorkbookId,
      options.force ? undefined : serverUpdatedAt || undefined,
    )
    if (response.unchanged) {
      serverUpdatedAt = response.updatedAt
      return
    }
    workbook = serverWorkbookToLocal(currentWorkbookId, response)
    grid.setWorkbook(workbook)
    renderDateSelect()
    updateStatusCounts()
    setFilename(workbook.name)
    serverUpdatedAt = response.updatedAt
  } catch (error) {
    handleApiError(error, 'Falha ao sincronizar')
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

async function enterWorkbook(workbookId: string) {
  currentWorkbookId = workbookId
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
  try {
    await refreshFromServer({ force: true })
  } finally {
    stopSheetLoading()
  }
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
  showHome()
}

void init()
