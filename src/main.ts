import './style.css'

import {
  AuthRequiredError,
  checkAuth,
  deleteImage,
  fetchWorkbook,
  logout,
  patchOrder,
  replaceWorkbook,
  serverWorkbookToLocal,
  uploadImage,
} from './api'
import { GridView, PHOTO_COLUMN_INDICES } from './grid'
import { showLoginScreen } from './login'
import { formatHitRef, highlightMatch, searchWorkbook, type SearchHit } from './search'
import type { CellValue, WorkbookData } from './types'
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
          <button class="btn" id="reset-btn" title="Apagar todos os pedidos">🗑 Zerar Planilha</button>
          <button class="btn" id="logout-btn" title="Sair">Sair</button>
        </div>
      </header>
      <div class="etiqueta-bar" role="toolbar" aria-label="Etiquetas">
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

function updateStatusCounts() {
  const sheet = grid.getActiveSheet()
  const target = el<HTMLSpanElement>('#status-counts')
  if (!sheet) {
    target.textContent = ''
    return
  }
  target.textContent = `${sheet.rows.length} pedidos`
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
  if (!workbook || changes.length === 0) return
  const sheetId = grid.getActiveSheetId()
  if (!sheetId) return
  const sheet = workbook.sheets[sheetId]
  if (!sheet) return

  // group by rowIndex
  const byRow = new Map<number, { row: number; cols: number[] }>()
  for (const { row, col, value } of changes) {
    if (!sheet.rows[row]) sheet.rows[row] = []
    sheet.rows[row][col] = value
    if (!byRow.has(row)) byRow.set(row, { row, cols: [] })
    byRow.get(row)!.cols.push(col)
  }
  grid.render()

  // PATCH each affected order
  for (const { row } of byRow.values()) {
    const id = getOrderId(row)
    if (!id) continue
    try {
      const result = await patchOrder(id, { row: sheet.rows[row] })
      serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt)
    } catch (error) {
      handleApiError(error, 'Falha ao salvar alteração')
    }
  }
}

function handleSelect(_ref: string, _value: CellValue) {
  // no-op (sem formula bar)
}

async function handleEtiqueta(color: string | null) {
  if (!workbook) return
  const sel = grid.getSelection()
  if (!sel) return
  grid.applyCellBackground(color)
  // identify affected rows
  const sheet = workbook.sheets[workbook.sheetOrder[0]]
  if (!sheet) return
  // After applyCellBackground the styles map is updated. Build per-row styles and patch each.
  // grid.applyCellBackground touches all selected rows on selection.col
  const rowsTouched = new Set<number>()
  for (const key of Object.keys(sheet.cellStyles ?? {})) {
    const [r] = key.split(':').map(Number)
    rowsTouched.add(r)
  }
  // simplification: re-send styles for all currently-selected rows
  for (const row of getCurrentSelectedRows()) {
    const id = getOrderId(row)
    if (!id) continue
    try {
      const result = await patchOrder(id, { styles: getRowStylesAsRecord(row) })
      serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt)
    } catch (error) {
      handleApiError(error, 'Falha ao salvar etiqueta')
    }
  }
}

function getCurrentSelectedRows(): number[] {
  const sel = grid.getSelection()
  if (!sel) return []
  // GridView doesn't expose internal range; reconstruct via DOM
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
  const id = getOrderId(row)
  if (!id) {
    setStatusText('Pedido sem ID — não pode ter foto')
    return
  }
  // optimistic: mostra o blob localmente
  grid.setCellImage(row, col, blob, fileName)
  setStatusText('Convertendo e enviando foto...')
  try {
    const jpeg = await blobToJpeg(blob)
    const safeName = fileName.replace(/\.[^.]+$/, '') + '.jpg'
    const result = await uploadImage(id, col, jpeg, safeName)
    // Replace local blob with server URL — re-render with url
    if (!workbook) return
    const sheet = workbook.sheets[workbook.sheetOrder[0]]
    if (!sheet) return
    sheet.images[`${row}:${col}`] = { url: result.url, fileName: safeName }
    grid.render()
    serverUpdatedAt = Math.max(serverUpdatedAt, result.updatedAt)
    setStatusText(`Foto enviada (${Math.round(jpeg.size / 1024)} KB)`)
  } catch (error) {
    handleApiError(error, 'Falha ao enviar foto')
  }
}

async function deleteImageAt(row: number, col: number) {
  const id = getOrderId(row)
  if (!id) return
  grid.removeCellImage(row, col)
  try {
    await deleteImage(id, col)
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
    }
  })
}

async function loadFile(file: File) {
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

    // For each row that has an image as Blob (new from xlsx), we need to upload to server.
    // For rows that re-use existing images (from previous workbook), they're already on server.
    // To distinguish: server-fetched images have `url`. New ones have `blob` (or both).
    const blobImages: Array<{ row: number; col: number; blob: Blob; fileName: string }> = []
    for (const [key, img] of Object.entries(sheet.images)) {
      const [r, c] = key.split(':').map(Number)
      if (img.blob && !img.url) {
        blobImages.push({ row: r, col: c, blob: img.blob, fileName: img.fileName })
      }
    }

    // Build server-friendly payload: orders array
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

    const result = await replaceWorkbook({ orders, columnWidths: sheet.columnWidths })
    serverUpdatedAt = result.updatedAt

    // Upload images extracted from XLSX
    for (const item of blobImages) {
      const orderId = orders[item.row]?.id
      if (!orderId) continue
      try {
        const jpeg = await blobToJpeg(item.blob)
        await uploadImage(orderId, item.col, jpeg, item.fileName.replace(/\.[^.]+$/, '') + '.jpg')
      } catch (error) {
        console.warn('Falha ao enviar imagem do XLSX:', error)
      }
    }

    // Now refetch from server to get URLs for images
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

function openConfirmDialog(opts: {
  title: string
  body: string
  confirmLabel: string
  onConfirm: () => Promise<void> | void
}) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">${opts.title}</div>
      <div class="modal-body">${opts.body}</div>
      <div class="modal-actions">
        <button type="button" class="btn modal-cancel">Cancelar</button>
        <button type="button" class="btn btn-danger modal-confirm">${opts.confirmLabel}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  overlay.querySelector('.modal-cancel')!.addEventListener('click', close)
  const confirmBtn = overlay.querySelector<HTMLButtonElement>('.modal-confirm')!
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true
    try {
      await opts.onConfirm()
    } finally {
      close()
    }
  })
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close()
      document.removeEventListener('keydown', onKey)
    }
  }
  document.addEventListener('keydown', onKey)
  confirmBtn.focus()
}

function bindResetButton() {
  el<HTMLButtonElement>('#reset-btn').addEventListener('click', () => {
    openConfirmDialog({
      title: 'Zerar planilha?',
      body:
        'Isso vai apagar <strong>todos os pedidos</strong>, incluindo etiquetas, fotos e edições manuais. Esta ação não pode ser desfeita.',
      confirmLabel: 'Zerar',
      onConfirm: async () => {
        setStatusText('Zerando planilha...')
        try {
          const result = await replaceWorkbook({ orders: [], columnWidths: {} })
          serverUpdatedAt = result.updatedAt
          await refreshFromServer({ force: true })
          setStatusText('Planilha zerada')
        } catch (error) {
          handleApiError(error, 'Falha ao zerar planilha')
        }
      },
    })
  })
}

async function refreshFromServer(options: { force?: boolean } = {}): Promise<void> {
  try {
    const response = await fetchWorkbook(options.force ? undefined : serverUpdatedAt || undefined)
    if (response.unchanged) {
      serverUpdatedAt = response.updatedAt
      return
    }
    workbook = serverWorkbookToLocal(response)
    grid.setWorkbook(workbook)
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

function handleApiError(error: unknown, fallback?: string) {
  if (error instanceof AuthRequiredError) {
    if (pollTimer) window.clearInterval(pollTimer)
    showLoginScreen(() => {
      void bootstrap()
    })
    return
  }
  if (fallback) setStatusText(fallback)
  console.error(error)
}

async function bootstrap() {
  buildShell()
  grid = new GridView(el<HTMLDivElement>('#sheet-root'), {
    onSelectCell: handleSelect,
    onCellChange: handleCellChange,
    onImageRequest: (row, col) => pickImageFile(row, col),
    onCellImageChange: () => {
      // not used here; image ops go through uploadAndSetImage/deleteImageAt
    },
    onImageDelete: (row, col) => void deleteImageAt(row, col),
  })
  grid.setWorkbook(null)
  bindFileInput()
  bindDropZone()
  bindSearch()
  bindEtiquetas()
  bindClipboardPaste()
  bindLogout()
  bindResetButton()
  await refreshFromServer({ force: true })
  startPolling()
}

async function init() {
  // ensure FIXED_HEADERS imported (referenced for forwards-compat)
  void FIXED_HEADERS
  const ok = await checkAuth()
  if (!ok) {
    showLoginScreen(() => {
      void bootstrap()
    })
    return
  }
  await bootstrap()
}

void init()
