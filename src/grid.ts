import { findStatusOption, STATUS_COLUMN_INDEX, STATUS_OPTIONS } from './status'
import { workbookLayout } from './shopee-workbook'
import type { CellValue, SheetData, WorkbookData } from './types'

const ID_COLUMN_INDEX = 0 // coluna A (ID do pedido — chave única)
export const MODEL_COLUMN_INDEX = 2 // coluna C (Modelo)
const USER_COLUMN_INDEX = 4 // coluna E (Nome de usuário)
export const RECIPIENT_COLUMN_INDEX = 6 // coluna G (Nome do destinatário)
export const PHOTO_COLUMN_INDEX = 7
export const PHOTO_COLUMN_INDICES = Array.from({ length: 10 }, (_, i) => PHOTO_COLUMN_INDEX + i)
const FILTERABLE_COLS = new Set<number>([MODEL_COLUMN_INDEX, STATUS_COLUMN_INDEX]) // C (Modelo) e F (Status)
const SORTABLE_COL = RECIPIENT_COLUMN_INDEX // coluna G (Nome do destinatário)
const MIN_COLUMN_COUNT = 17 // até coluna Q — Foto 1 até Foto 10
const DEFAULT_COL_WIDTH = 110
const PHOTO_COLUMN_WIDTH = 92
const ROW_NUMBER_WIDTH = 44
const DEFAULT_ROW_HEIGHT = 28
const DEFAULT_COLUMN_WIDTH_OVERRIDES: Record<number, number> = {
  ...Object.fromEntries(PHOTO_COLUMN_INDICES.map((col) => [col, PHOTO_COLUMN_WIDTH])),
  1: 220, // B — Nome do Produto
  3: 56, // D — Qnt.
  6: 220, // G — Nome do destinatário
  7: 120, // H — Status Shopee (planilha wb_shopee)
}
const DEFAULT_CENTERED_COLUMNS = new Set([3, ...PHOTO_COLUMN_INDICES])
const TYPEAHEAD_MS = 900 // ms — reset do buffer estilo Windows Explorer
void ID_COLUMN_INDEX

const COL_LETTER_CACHE = new Map<number, string>()

function colLetter(index: number): string {
  const cached = COL_LETTER_CACHE.get(index)
  if (cached) return cached
  let result = ''
  let i = index
  while (i >= 0) {
    result = String.fromCharCode(65 + (i % 26)) + result
    i = Math.floor(i / 26) - 1
  }
  COL_LETTER_CACHE.set(index, result)
  return result
}

function formatCellRef(row: number, col: number): string {
  return `${colLetter(col)}${row + 1}`
}

async function getClipboardImageBlob(img: { url?: string; blob?: Blob }): Promise<Blob> {
  let blob = img.blob
  if (!blob) {
    if (!img.url) throw new Error('Imagem sem origem para copiar')
    const response = await fetch(img.url, { credentials: 'include' })
    if (!response.ok) throw new Error(`Falha ao buscar imagem: HTTP ${response.status}`)
    blob = await response.blob()
  }
  if (blob.type === 'image/png') return blob

  const bitmap = await createImageBitmap(blob)
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas indisponivel para copiar imagem')
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (result) => result ? resolve(result) : reject(new Error('Falha ao converter imagem para copiar')),
      'image/png',
    )
  })
}

async function copyImageToClipboard(img: { url?: string; blob?: Blob }): Promise<void> {
  const clipboard = navigator.clipboard
  if (!clipboard?.write) throw new Error('Area de transferencia nao suporta imagens')
  // clipboard.write precisa ser chamado enquanto o gesto do clique ainda vale;
  // o blob pode ser resolvido depois via Promise no ClipboardItem.
  await clipboard.write([
    new ClipboardItem({
      'image/png': getClipboardImageBlob(img),
    }),
  ])
}

export interface CellChange {
  row: number
  col: number
  value: CellValue
}

export interface GridCallbacks {
  onSelectCell(ref: string, value: CellValue, selectedRows: number): void
  onCellChange(changes: CellChange[]): void
  onSheetChange?(sheetId: string): void
  onImageRequest?(rowIndex: number, colIndex: number): void
  onCellImageChange?(rowIndex: number, colIndex: number): void
  onImageDelete?(rowIndex: number, colIndex: number): void
  onCommentRequest?(rowIndex: number, colIndex: number): void
  onChatRequest?(rowIndex: number, colIndex: number): void
  onPreviewRequest?(rowIndex: number, colIndex: number): void
  onViewStateChange?(): void
}

interface SelectionState {
  col: number
  anchorRow: number
  activeRow: number
}

interface EditingState {
  row: number
  col: number
}

export interface GridSortState {
  col: number
  dir: 'asc' | 'desc'
}

export interface GridFilterState {
  col: number
  values: string[]
}

export interface GridViewState {
  filters: GridFilterState[]
  sort: GridSortState | null
}

export class GridView {
  private root: HTMLElement
  private callbacks: GridCallbacks
  private workbook: WorkbookData | null = null
  private activeSheetId: string | null = null
  private selection: SelectionState | null = null
  private editing: EditingState | null = null
  private imageUrlCache = new Map<Blob, string>()
  private filters = new Map<string, Map<number, Set<string>>>()
  private sorts = new Map<string, GridSortState>()
  private visibleOrder: number[] = []
  private dateFilter: string | null = null
  private loading = false
  // Rows extras selecionadas via Ctrl-click (não-contíguas). Sempre na mesma
  // coluna do `selection`. Limpa quando o user seleciona algo sem Ctrl/Shift.
  private extraRows = new Set<number>()
  // Buffer pra type-to-jump (estilo Windows Explorer). Reseta após TYPEAHEAD_MS
  // de inatividade. Concatena chars enquanto o user digita rápido.
  private typeBuffer = ''
  private typeBufferAt = 0
  private dragSelectionCol: number | null = null
  private photoColumnIndices: number[] = [...PHOTO_COLUMN_INDICES]
  private imageColumnIndices = new Set(PHOTO_COLUMN_INDICES)
  private minColumnCount = MIN_COLUMN_COUNT
  private columnWidthOverrides: Record<number, number> = { ...DEFAULT_COLUMN_WIDTH_OVERRIDES }
  private centeredColumns = new Set(DEFAULT_CENTERED_COLUMNS)
  private linkedChatUsernames = new Set<string>()

  constructor(root: HTMLElement, callbacks: GridCallbacks) {
    this.root = root
    this.callbacks = callbacks
  }

  setWorkbook(workbook: WorkbookData | null) {
    this.revokeImageUrls()
    this.filters.clear()
    this.sorts.clear()
    this.workbook = workbook
    if (workbook) this.applyWorkbookLayout(workbook.id)
    this.activeSheetId = workbook?.sheetOrder[0] ?? null
    this.selection = workbook ? { col: 0, anchorRow: 0, activeRow: 0 } : null
    this.editing = null
    // Se o filtro de data ativo nao existe mais nesta workbook, cai pra primeira data disponivel.
    const available = this.getAvailableDates()
    if (this.dateFilter && !available.includes(this.dateFilter)) {
      this.dateFilter = available[0] ?? null
    } else if (!this.dateFilter && available.length > 0) {
      this.dateFilter = available[0]
    }
    this.recomputeOrder()
    this.render()
  }

  setLinkedChatUsernames(usernames: Iterable<string>) {
    this.linkedChatUsernames = new Set([...usernames].map((u) => u.trim().toLowerCase()).filter(Boolean))
    this.render()
  }

  getLinkedChatUsernames(): ReadonlySet<string> {
    return this.linkedChatUsernames
  }

  private applyWorkbookLayout(workbookId: string): void {
    const layout = workbookLayout(workbookId)
    this.photoColumnIndices = [...layout.photoColumnIndices]
    this.imageColumnIndices = new Set(layout.photoColumnIndices)
    this.minColumnCount = layout.minColumnCount
    this.columnWidthOverrides = {
      ...DEFAULT_COLUMN_WIDTH_OVERRIDES,
      ...Object.fromEntries(layout.photoColumnIndices.map((col) => [col, PHOTO_COLUMN_WIDTH])),
    }
    this.centeredColumns = new Set([3, ...layout.photoColumnIndices])
  }

  getPhotoColumnIndices(): readonly number[] {
    return this.photoColumnIndices
  }

  setDateFilter(date: string | null) {
    this.dateFilter = date
    this.recomputeOrder()
    this.render()
  }

  getDateFilter(): string | null {
    return this.dateFilter
  }

  /**
   * Filtro por coluna independente do mecanismo de header-click (FILTERABLE_COLS/setViewState) —
   * usado por botões dedicados (ex.: status Shopee) que não precisam de dropdown no cabeçalho
   * nem persistência na URL. Combina em AND com dateFilter e os demais filtros via recomputeOrder.
   */
  setColumnFilter(col: number, values: string[] | null): void {
    if (!this.activeSheetId) return
    const filters = this.getSheetFilters(this.activeSheetId)
    if (!values || values.length === 0) filters.delete(col)
    else filters.set(col, new Set(values))
    this.recomputeOrder()
    this.render()
  }

  getColumnFilter(col: number): string[] | null {
    const filters = this.activeSheetId ? this.filters.get(this.activeSheetId) : undefined
    const set = filters?.get(col)
    return set ? [...set] : null
  }

  getAvailableDates(): string[] {
    const sheet = this.getActiveSheet()
    if (!sheet) return []
    const dates = sheet.rowDates ?? []
    const set = new Set<string>()
    for (const d of dates) {
      if (d && d.length > 0) set.add(d)
    }
    return [...set]
  }

  /** Datas que têm pelo menos 1 linha com `col === value` — usado pelo quick-select de status Shopee. */
  getAvailableDatesForColumnValue(col: number, value: string): string[] {
    const sheet = this.getActiveSheet()
    if (!sheet) return []
    const dates = sheet.rowDates ?? []
    const set = new Set<string>()
    for (let i = 0; i < dates.length; i++) {
      const d = dates[i]
      if (!d) continue
      const cell = sheet.rows[i]?.[col]
      if (cell != null && String(cell) === value) set.add(d)
    }
    return [...set]
  }

  setActiveSheet(sheetId: string, initialSelection?: SelectionState) {
    if (!this.workbook?.sheets[sheetId]) return
    const changed = this.activeSheetId !== sheetId
    this.activeSheetId = sheetId
    this.selection = initialSelection ?? { col: 0, anchorRow: 0, activeRow: 0 }
    this.editing = null
    this.recomputeOrder()
    this.render()
    if (changed) this.callbacks.onSheetChange?.(sheetId)
    this.emitSelection()
  }

  navigateTo(sheetId: string, row: number, col: number) {
    if (!this.workbook?.sheets[sheetId]) return
    const safeRow = Math.max(0, row)
    const safeCol = Math.max(0, col)
    if (this.activeSheetId !== sheetId) {
      this.setActiveSheet(sheetId, { col: safeCol, anchorRow: safeRow, activeRow: safeRow })
    } else {
      this.selection = { col: safeCol, anchorRow: safeRow, activeRow: safeRow }
      this.editing = null
    }
    if (!this.visibleOrder.includes(safeRow)) {
      this.filters.get(sheetId)?.clear()
      this.recomputeOrder()
      this.emitViewStateChange()
    }
    this.render()
    this.emitSelection()
    requestAnimationFrame(() => {
      const cell = this.root.querySelector<HTMLElement>(
        `td[data-row="${safeRow}"][data-col="${safeCol}"]`,
      )
      if (!cell) return
      cell.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' })
      cell.classList.add('is-flash')
      setTimeout(() => cell.classList.remove('is-flash'), 1400)
    })
  }

  private getSheetFilters(sheetId: string): Map<number, Set<string>> {
    let map = this.filters.get(sheetId)
    if (!map) {
      map = new Map()
      this.filters.set(sheetId, map)
    }
    return map
  }

  getViewState(): GridViewState {
    const filters = this.activeSheetId ? this.filters.get(this.activeSheetId) : undefined
    const sort = this.activeSheetId ? this.sorts.get(this.activeSheetId) : undefined
    return {
      filters: filters
        ? [...filters.entries()].map(([col, values]) => ({ col, values: [...values] }))
        : [],
      sort: sort ? { ...sort } : null,
    }
  }

  setViewState(state: GridViewState): void {
    if (!this.activeSheetId) return
    const filters = this.getSheetFilters(this.activeSheetId)
    // Preserva filtros programáticos (ex.: status Shopee col H) — não vêm da URL.
    const preserved = new Map<number, Set<string>>()
    for (const [col, values] of filters) {
      if (!FILTERABLE_COLS.has(col)) preserved.set(col, values)
    }
    filters.clear()
    for (const [col, values] of preserved) filters.set(col, values)
    for (const filter of state.filters) {
      if (!FILTERABLE_COLS.has(filter.col)) continue
      const values = filter.values
      if (values.length > 0) filters.set(filter.col, new Set(values))
    }
    if (state.sort && state.sort.col === SORTABLE_COL) {
      this.sorts.set(this.activeSheetId, { col: state.sort.col, dir: state.sort.dir })
    } else {
      this.sorts.delete(this.activeSheetId)
    }
    this.recomputeOrder()
    this.render()
    this.emitSelection()
  }

  private recomputeOrder() {
    const sheet = this.getActiveSheet()
    if (!sheet) {
      this.visibleOrder = []
      return
    }
    let indices = sheet.rows.map((_, i) => i)
    const dates = sheet.rowDates ?? []
    if (this.dateFilter) {
      indices = indices.filter((i) => (dates[i] ?? '') === this.dateFilter)
    }
    const filters = this.activeSheetId ? this.filters.get(this.activeSheetId) : undefined
    if (filters && filters.size > 0) {
      indices = indices.filter((i) => {
        for (const [col, allowed] of filters) {
          const v = sheet.rows[i]?.[col]
          const key = v == null ? '' : String(v)
          if (!allowed.has(key)) return false
        }
        return true
      })
    }
    const sort = this.activeSheetId ? this.sorts.get(this.activeSheetId) : undefined
    if (sort) {
      indices.sort((a, b) => {
        const va = sheet.rows[a]?.[sort.col]
        const vb = sheet.rows[b]?.[sort.col]
        const sa = va == null ? '' : String(va)
        const sb = vb == null ? '' : String(vb)
        const cmp = sa.localeCompare(sb, 'pt-BR', { sensitivity: 'base', numeric: true })
        return sort.dir === 'asc' ? cmp : -cmp
      })
    }
    this.visibleOrder = indices
  }

  getVisibleRowCount(): number {
    return this.visibleOrder.length
  }

  getTotalRowCount(): number {
    return this.getActiveSheet()?.rows.length ?? 0
  }

  private getImageUrl(blob: Blob): string {
    let url = this.imageUrlCache.get(blob)
    if (!url) {
      url = URL.createObjectURL(blob)
      this.imageUrlCache.set(blob, url)
    }
    return url
  }

  private resolveImageSrc(
    img: { url?: string; blob?: Blob; updatedAt?: number },
    thumb?: number,
  ): string {
    if (img.url) {
      const params: string[] = []
      if (thumb != null) params.push(`thumb=${thumb}`)
      // cache-buster: troca de foto → updatedAt muda → browser baixa de novo
      if (img.updatedAt != null) params.push(`v=${img.updatedAt}`)
      if (params.length === 0) return img.url
      const sep = img.url.includes('?') ? '&' : '?'
      return `${img.url}${sep}${params.join('&')}`
    }
    if (img.blob) return this.getImageUrl(img.blob)
    return ''
  }

  private revokeImageUrls() {
    for (const url of this.imageUrlCache.values()) URL.revokeObjectURL(url)
    this.imageUrlCache.clear()
  }

  getActiveSheetId(): string | null {
    return this.activeSheetId
  }

  getActiveSheet(): SheetData | null {
    if (!this.workbook || !this.activeSheetId) return null
    return this.workbook.sheets[this.activeSheetId] ?? null
  }

  getSelection(): { sheetId: string; row: number; col: number } | null {
    if (!this.activeSheetId || !this.selection) return null
    return { sheetId: this.activeSheetId, row: this.selection.activeRow, col: this.selection.col }
  }

  restoreSelection(row: number, col: number) {
    const sheet = this.getActiveSheet()
    if (!sheet?.rows[row]) return
    const safeCol = Math.max(0, col)
    this.selection = { col: safeCol, anchorRow: row, activeRow: row }
    this.extraRows.clear()
    this.editing = null
    this.refreshSelectionClasses()
    this.emitSelection()
  }

  /** Seleciona a linha E rola ela pra dentro da área visível — usado depois de fechar
   * o chat/picker de peças, pra voltar o olho na linha do cliente que acabou de mexer. */
  selectAndReveal(row: number, col: number) {
    this.restoreSelection(row, col)
    requestAnimationFrame(() => {
      const cell = this.root.querySelector<HTMLElement>(`td[data-row="${row}"][data-col="${Math.max(0, col)}"]`)
      cell?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    })
  }

  setCellImage(row: number, col: number, blob: Blob, fileName: string) {
    const sheet = this.getActiveSheet()
    if (!sheet) return
    const key = `${row}:${col}`
    const previous = sheet.images[key]
    if (previous?.blob) {
      const url = this.imageUrlCache.get(previous.blob)
      if (url) {
        URL.revokeObjectURL(url)
        this.imageUrlCache.delete(previous.blob)
      }
    }
    sheet.images[key] = { blob, fileName }
    this.render()
    this.callbacks.onCellImageChange?.(row, col)
  }

  removeCellImage(row: number, col: number) {
    const sheet = this.getActiveSheet()
    if (!sheet) return
    const key = `${row}:${col}`
    const previous = sheet.images[key]
    if (!previous) return
    if (previous.blob) {
      const url = this.imageUrlCache.get(previous.blob)
      if (url) {
        URL.revokeObjectURL(url)
        this.imageUrlCache.delete(previous.blob)
      }
    }
    delete sheet.images[key]
    this.render()
    this.callbacks.onCellImageChange?.(row, col)
  }

  applyCellBackground(color: string | null) {
    const sheet = this.getActiveSheet()
    if (!sheet || !this.selection) return
    const col = this.selection.col
    const rows = this.getSelectedRows()
    sheet.cellStyles ||= {}
    for (const r of rows) {
      const key = `${r}:${col}`
      if (color) {
        sheet.cellStyles[key] = { ...(sheet.cellStyles[key] ?? {}), bg: color }
      } else {
        const current = sheet.cellStyles[key]
        if (current) {
          delete current.bg
          if (Object.keys(current).length === 0) delete sheet.cellStyles[key]
        }
      }
    }
    this.render()
  }

  applyStatusToSelection(value: CellValue): CellChange[] {
    const sheet = this.getActiveSheet()
    if (!sheet || !this.selection) return []
    const col = this.selection.col
    const rows = this.getSelectedRows()
    const changes: CellChange[] = []
    for (const r of rows) {
      if (!sheet.rows[r]) sheet.rows[r] = []
      sheet.rows[r][col] = value
      changes.push({ row: r, col, value })
    }
    this.render()
    return changes
  }

  setLoading(loading: boolean) {
    if (this.loading === loading) return
    this.loading = loading
    this.render()
  }

  /** Copia os valores das celulas selecionadas (1 coluna, N linhas) pra
   *  clipboard. Junta por `\n`. Retorna nº de valores copiados (0 = nada
   *  selecionado ou clipboard falhou). */
  async copySelectedToClipboard(): Promise<number> {
    if (!this.selection) return 0
    const sheet = this.getActiveSheet()
    if (!sheet) return 0
    const rows = this.getSelectedRows()
    if (rows.length === 0) return 0
    const col = this.selection.col
    const values = rows.map((r) => {
      const v = sheet.rows[r]?.[col]
      return v == null ? '' : String(v)
    })
    try {
      await navigator.clipboard.writeText(values.join('\n'))
      return values.length
    } catch {
      return 0
    }
  }

  /** Type-to-jump estilo Windows Explorer. Buffer acumula chars enquanto
   *  o user digita rápido (<900ms entre teclas); busca a 1ª linha visível
   *  cuja célula da coluna selecionada `startsWith(buffer)`. Retorna true
   *  se achou e moveu a seleção. */
  typeAheadJump(char: string): boolean {
    if (!this.selection || this.editing) return false
    if (char.length !== 1) return false
    const sheet = this.getActiveSheet()
    if (!sheet) return false
    const now = Date.now()
    if (now - this.typeBufferAt > TYPEAHEAD_MS) this.typeBuffer = ''
    this.typeBuffer += char.toLowerCase()
    this.typeBufferAt = now
    const col = this.selection.col
    for (const r of this.visibleOrder) {
      const v = sheet.rows[r]?.[col]
      if (v == null) continue
      const s = String(v).toLowerCase().trim()
      if (s.startsWith(this.typeBuffer)) {
        this.select(r, col)
        requestAnimationFrame(() => {
          const cell = this.root.querySelector<HTMLElement>(
            `td[data-row="${r}"][data-col="${col}"]`,
          )
          cell?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
        })
        return true
      }
    }
    return false
  }

  render() {
    this.root.innerHTML = ''

    if (this.loading) {
      this.renderLoading()
      return
    }

    if (!this.workbook) {
      this.renderEmpty()
      return
    }

    const sheet = this.getActiveSheet()
    if (!sheet) {
      this.renderEmpty()
      return
    }

    const columnCount = Math.max(this.minColumnCount, sheet.headers.length, STATUS_COLUMN_INDEX + 1, ...this.photoColumnIndices)
    const rowCount = sheet.rows.length

    const table = document.createElement('table')
    table.className = 'sheet'

    const colgroup = document.createElement('colgroup')
    const rowNumberCol = document.createElement('col')
    rowNumberCol.style.width = `${ROW_NUMBER_WIDTH}px`
    colgroup.appendChild(rowNumberCol)
    for (let c = 0; c < columnCount; c++) {
      const col = document.createElement('col')
      const width = this.columnWidthOverrides[c] ?? sheet.columnWidths[c] ?? DEFAULT_COL_WIDTH
      col.style.width = `${width}px`
      colgroup.appendChild(col)
    }
    table.appendChild(colgroup)

    table.appendChild(this.buildHeader(sheet, columnCount))
    table.appendChild(this.buildBody(sheet, columnCount, rowCount))

    this.root.appendChild(table)

    if (this.selection) {
      this.focusSelection()
    }
  }

  private buildHeader(sheet: SheetData, columnCount: number): HTMLTableSectionElement {
    const thead = document.createElement('thead')

    const letterRow = document.createElement('tr')
    const corner = document.createElement('th')
    corner.className = 'corner'
    letterRow.appendChild(corner)
    for (let c = 0; c < columnCount; c++) {
      const th = document.createElement('th')
      th.className = 'col-letter'
      if (this.imageColumnIndices.has(c)) th.classList.add('cell-image-header')
      th.textContent = colLetter(c)
      if (this.selection?.col === c) th.classList.add('is-active')
      letterRow.appendChild(th)
    }
    thead.appendChild(letterRow)

    const nameRow = document.createElement('tr')
    nameRow.className = 'header-row-2'
    const nameCorner = document.createElement('th')
    nameCorner.className = 'corner'
    nameRow.appendChild(nameCorner)
    const filters = this.activeSheetId ? this.filters.get(this.activeSheetId) : undefined
    const sort = this.activeSheetId ? this.sorts.get(this.activeSheetId) : undefined
    for (let c = 0; c < columnCount; c++) {
      const th = document.createElement('th')
      if (this.centeredColumns.has(c)) th.classList.add('cell-center')
      if (this.imageColumnIndices.has(c)) th.classList.add('cell-image-header')
      const headerText = sheet.headers[c] || ''
      const span = document.createElement('span')
      span.className = 'header-text'
      span.textContent = headerText
      th.appendChild(span)
      if (headerText && (FILTERABLE_COLS.has(c) || c === SORTABLE_COL)) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'col-filter-btn'
        btn.title = FILTERABLE_COLS.has(c) ? 'Filtrar valores' : 'Ordenar A → Z / Z → A'
        const hasFilter = FILTERABLE_COLS.has(c) && !!filters?.has(c)
        const isSorted = c === SORTABLE_COL && sort?.col === c
        if (hasFilter) btn.classList.add('is-filtered')
        if (isSorted) {
          btn.classList.add('is-sorted')
          btn.textContent = sort!.dir === 'asc' ? '↑' : '↓'
        } else {
          btn.textContent = '▾'
        }
        btn.addEventListener('click', (event) => {
          event.stopPropagation()
          this.openFilterPopover(btn, c)
        })
        th.appendChild(btn)
      }
      nameRow.appendChild(th)
    }
    thead.appendChild(nameRow)

    return thead
  }

  private buildBody(sheet: SheetData, columnCount: number, _rowCount: number): HTMLTableSectionElement {
    const tbody = document.createElement('tbody')
    const selectedRows = this.selection ? new Set(this.getSelectedRows()) : new Set<number>()
    this.visibleOrder.forEach((r, visibleIndex) => {
      tbody.appendChild(this.buildDataRow(sheet, r, visibleIndex, columnCount, selectedRows))
    })
    return tbody
  }

  private buildDataRow(
    sheet: SheetData,
    r: number,
    visibleIndex: number,
    columnCount: number,
    selectedRows: Set<number>,
  ): HTMLTableRowElement {
    const tr = document.createElement('tr')
    tr.dataset.row = String(r)
    tr.style.height = `${DEFAULT_ROW_HEIGHT}px`
    if (sheet.rowFlags?.[r]?.disappeared) tr.classList.add('row-disappeared')
    if (selectedRows.has(r)) tr.classList.add('row-selected')

    const rowNum = document.createElement('th')
    rowNum.className = 'row-num'
    rowNum.textContent = String(visibleIndex + 1)
    if (selectedRows.has(r)) rowNum.classList.add('is-active')
    tr.appendChild(rowNum)

    for (let c = 0; c < columnCount; c++) {
      tr.appendChild(this.buildCell(sheet, r, c))
    }
    return tr
  }

  private buildCell(sheet: SheetData, row: number, col: number): HTMLTableCellElement {
    const td = document.createElement('td')
    td.dataset.row = String(row)
    td.dataset.col = String(col)
    if (this.centeredColumns.has(col)) td.classList.add('cell-center')
    const value = sheet.rows[row]?.[col] ?? null
    const isSelected = !!this.selection
      && this.selection.col === col
      && this.isRowInSelection(row)
    const isEditing = this.editing?.row === row && this.editing?.col === col
    const style = sheet.cellStyles?.[`${row}:${col}`]
    if (style?.bg && col !== STATUS_COLUMN_INDEX) {
      td.style.backgroundColor = style.bg
      td.classList.add('has-bg')
    }

    if (col === STATUS_COLUMN_INDEX) {
      td.classList.add('status-cell')
      td.appendChild(this.buildStatusPill(value, row, col))
    } else if (col === USER_COLUMN_INDEX && value != null && String(value).trim() !== '' && !isEditing) {
      td.classList.add('cell-user')
      const wrap = document.createElement('div')
      wrap.className = 'user-cell-wrap'
      const text = document.createElement('span')
      text.className = 'user-cell-text'
      text.textContent = String(value)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'user-cell-copy'
      btn.title = 'Copiar para a área de transferência'
      btn.textContent = '⎘'
      btn.addEventListener('click', async (event) => {
        event.stopPropagation()
        // Seleciona a linha clicada antes de copiar (visual feedback).
        this.select(row, col)
        try {
          await navigator.clipboard.writeText(String(value))
          btn.classList.add('is-copied')
          btn.textContent = '✓'
          window.setTimeout(() => {
            btn.classList.remove('is-copied')
            btn.textContent = '⎘'
          }, 1100)
        } catch (error) {
          console.error('Falha ao copiar', error)
        }
      })
      wrap.appendChild(text)
      wrap.appendChild(btn)
      td.appendChild(wrap)
    } else if (col === RECIPIENT_COLUMN_INDEX && !isEditing) {
      td.classList.add('cell-user', 'cell-recipient')
      const comment = style?.comment?.trim() ?? ''
      const wrap = document.createElement('div')
      wrap.className = 'user-cell-wrap'
      const text = document.createElement('span')
      text.className = 'user-cell-text'
      text.textContent = value == null ? '' : String(value)
      const menuBtn = document.createElement('button')
      menuBtn.type = 'button'
      menuBtn.className = 'user-cell-copy recipient-menu-btn' + (comment ? ' has-comment' : '')
      menuBtn.title = 'Ações do destinatário'
      menuBtn.innerHTML = `
        <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
          <path d="M4 5.5h12M4 10h12M4 14.5h12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none" />
        </svg>
      `
      menuBtn.addEventListener('click', (event) => {
        event.stopPropagation()
        this.select(row, col)
        this.openRecipientActionMenu(row, col, menuBtn, sheet, comment)
      })
      wrap.appendChild(text)
      wrap.appendChild(menuBtn)
      td.appendChild(wrap)
    } else if (this.imageColumnIndices.has(col)) {
      td.classList.add('cell-image')
      const meta = sheet.images[`${row}:${col}`]
      if (meta) {
        const wrap = document.createElement('div')
        wrap.className = 'image-cell-wrap'
        const thumbUrl = this.resolveImageSrc(meta, 200)
        const fullUrl = this.resolveImageSrc(meta)
        const img = document.createElement('img')
        img.src = thumbUrl
        img.alt = meta.fileName
        img.loading = 'eager'
        img.decoding = 'async'
        img.addEventListener('click', (event) => {
          event.stopPropagation()
          this.select(row, col)
          this.openLightbox(fullUrl, meta.fileName)
        })
        const copyBtn = document.createElement('button')
        copyBtn.type = 'button'
        copyBtn.className = 'image-cell-action image-cell-copy'
        copyBtn.title = 'Copiar foto'
        copyBtn.textContent = '⎘'
        copyBtn.addEventListener('click', async (event) => {
          event.stopPropagation()
          copyBtn.disabled = true
          try {
            await copyImageToClipboard(meta)
            copyBtn.classList.add('is-copied')
            copyBtn.textContent = '✓'
            window.setTimeout(() => {
              copyBtn.classList.remove('is-copied')
              copyBtn.textContent = '⎘'
            }, 1100)
          } catch (error) {
            console.error('Falha ao copiar imagem', error)
            copyBtn.textContent = '!'
            window.setTimeout(() => {
              copyBtn.textContent = '⎘'
            }, 1100)
          } finally {
            copyBtn.disabled = false
          }
        })
        const delBtn = document.createElement('button')
        delBtn.type = 'button'
        delBtn.className = 'image-cell-action image-cell-delete'
        delBtn.title = 'Remover foto'
        delBtn.textContent = '×'
        delBtn.addEventListener('click', (event) => {
          event.stopPropagation()
          if (this.callbacks.onImageDelete) {
            this.callbacks.onImageDelete(row, col)
          } else {
            this.removeCellImage(row, col)
          }
        })
        wrap.appendChild(img)
        wrap.appendChild(copyBtn)
        wrap.appendChild(delBtn)
        td.appendChild(wrap)
      } else {
        const empty = document.createElement('button')
        empty.type = 'button'
        empty.className = 'image-cell-empty'
        empty.title = 'Selecione e cole (Ctrl+V) · ou clique 2x pra enviar arquivo'
        empty.textContent = '+'
        empty.addEventListener('click', (event) => {
          event.stopPropagation()
          if (event.shiftKey && this.selection && this.selection.col === col) {
            this.extendSelection(row)
            return
          }
          if (event.ctrlKey || event.metaKey) {
            this.toggleExtraRow(row, col)
            return
          }
          const isSingleSelected =
            !!this.selection &&
            this.selection.col === col &&
            this.selection.anchorRow === row &&
            this.selection.activeRow === row &&
            this.extraRows.size === 0
          if (!isSingleSelected) {
            this.select(row, col)
            return
          }
          this.callbacks.onImageRequest?.(row, col)
        })
        td.appendChild(empty)
      }
    } else {
      if (isEditing) {
        td.classList.add('is-editing')
        const input = document.createElement('input')
        input.type = 'text'
        input.value = value == null ? '' : String(value)
        input.autofocus = true
        input.addEventListener('blur', () => this.commitEdit(row, col, input.value))
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            this.commitEdit(row, col, input.value)
          } else if (event.key === 'Escape') {
            event.preventDefault()
            this.cancelEdit()
          }
        })
        td.appendChild(input)
      } else {
        td.textContent = value == null ? '' : String(value)
        if (typeof value === 'string' && value.includes('\n')) {
          td.classList.add('cell-multiline')
        }
      }
    }

    if (isSelected) td.classList.add('is-selected')

    td.addEventListener('mousedown', (event) => {
      if (!this.canStartDragSelection(event)) return
      event.preventDefault()
      this.select(row, col)
      this.dragSelectionCol = col
      window.addEventListener('mouseup', this.stopDragSelection, { once: true })
    })
    td.addEventListener('mouseenter', () => {
      if (this.dragSelectionCol !== col) return
      this.extendSelection(row)
    })

    td.addEventListener('click', (event) => {
      if (col === STATUS_COLUMN_INDEX) return
      event.stopPropagation()
      if (event.shiftKey && this.selection && this.selection.col === col) {
        this.extendSelection(row)
      } else if (event.ctrlKey || event.metaKey) {
        this.toggleExtraRow(row, col)
      } else {
        this.select(row, col)
      }
    })

    td.addEventListener('dblclick', (event) => {
      if (col === STATUS_COLUMN_INDEX || this.imageColumnIndices.has(col)) return
      event.stopPropagation()
      this.startEdit(row, col)
    })

    return td
  }

  private buildStatusPill(value: CellValue, row: number, col: number): HTMLElement {
    const option = findStatusOption(value)
    const pill = document.createElement('div')
    pill.className = 'status-pill'
    pill.style.backgroundColor = option.color
    if (option.textColor) pill.style.color = option.textColor
    pill.textContent = option.label || '—'
    pill.addEventListener('click', (event) => {
      event.stopPropagation()
      if (event.shiftKey && this.selection && this.selection.col === col) {
        this.extendSelection(row)
        return
      }
      if (event.ctrlKey || event.metaKey) {
        this.toggleExtraRow(row, col)
        return
      }
      // 1o click so seleciona, 2o click (na celula ja dentro do range
      // selecionado) abre o popover. Preserva multi-selecao via shift+click.
      const inRange =
        !!this.selection &&
        this.selection.col === col &&
        this.isRowInSelection(row)
      if (!inRange) {
        this.select(row, col)
        return
      }
      this.editing = null
      this.openStatusPopover(row, col)
    })
    return pill
  }

  private refreshSelectionClasses() {
    this.root
      .querySelectorAll('td.is-selected, th.row-num.is-active, th.col-letter.is-active, tr.row-selected')
      .forEach((node) => {
        node.classList.remove('is-selected', 'is-active', 'row-selected')
      })
    if (!this.selection) return

    const col = this.selection.col
    const markRow = (r: number) => {
      const cell = this.root.querySelector<HTMLElement>(`td[data-row="${r}"][data-col="${col}"]`)
      if (!cell) return
      cell.classList.add('is-selected')
      const tr = cell.parentElement as HTMLElement | null
      tr?.classList.add('row-selected')
      tr?.querySelector<HTMLElement>('th.row-num')?.classList.add('is-active')
    }

    // Range principal
    const anchorPos = this.visibleOrder.indexOf(this.selection.anchorRow)
    const activePos = this.visibleOrder.indexOf(this.selection.activeRow)
    if (anchorPos >= 0 && activePos >= 0) {
      const lo = Math.min(anchorPos, activePos)
      const hi = Math.max(anchorPos, activePos)
      for (let pos = lo; pos <= hi; pos++) markRow(this.visibleOrder[pos])
    }
    // Linhas extras do Ctrl-click
    for (const r of this.extraRows) markRow(r)

    const firstHeaderRow = this.root.querySelector('thead tr:first-child')
    firstHeaderRow?.children[col + 1]?.classList.add('is-active')
  }

  private openRecipientActionMenu(
    row: number,
    col: number,
    anchor: HTMLElement,
    sheet: SheetData,
    comment: string,
  ) {
    document.querySelector('.recipient-menu-popover')?.remove()

    const buyerUsername = String(sheet.rows[row]?.[USER_COLUMN_INDEX] ?? '').trim()
    const linked =
      Boolean(buyerUsername) && this.linkedChatUsernames.has(buyerUsername.toLowerCase())
    const hasPreview = this.photoColumnIndices.some((photoCol) =>
      Boolean(sheet.images[`${row}:${photoCol}`]),
    )

    const popover = document.createElement('div')
    popover.className = 'recipient-menu-popover status-popover'

    const addItem = (label: string, action: () => void) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = label
      btn.addEventListener('click', (event) => {
        event.stopPropagation()
        popover.remove()
        action()
      })
      popover.appendChild(btn)
    }

    if (buyerUsername) {
      addItem('Abrir chat', () => this.callbacks.onChatRequest?.(row, col))
    }
    if (linked && hasPreview) {
      addItem('Enviar prévia', () => this.callbacks.onPreviewRequest?.(row, col))
    }
    addItem(comment ? 'Editar comentário' : 'Comentário', () =>
      this.callbacks.onCommentRequest?.(row, col),
    )

    document.body.appendChild(popover)
    const rect = anchor.getBoundingClientRect()
    const popHeight = popover.offsetHeight
    const popWidth = popover.offsetWidth
    let top = rect.bottom + 4
    let left = rect.right - popWidth
    if (top + popHeight > window.innerHeight - 8) top = rect.top - popHeight - 4
    if (left < 8) left = 8
    popover.style.top = `${top}px`
    popover.style.left = `${left}px`

    const close = (event: MouseEvent) => {
      if (!popover.contains(event.target as Node) && event.target !== anchor) {
        popover.remove()
        document.removeEventListener('mousedown', close)
      }
    }
    window.setTimeout(() => document.addEventListener('mousedown', close), 0)
  }

  private openStatusPopover(row: number, col: number) {
    const existing = document.querySelector('.status-popover')
    if (existing) existing.remove()

    const cell = this.root.querySelector<HTMLElement>(
      `td[data-row="${row}"][data-col="${col}"]`,
    )
    if (!cell) return

    const popover = document.createElement('div')
    popover.className = 'status-popover'

    for (const option of STATUS_OPTIONS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      const swatch = document.createElement('span')
      swatch.className = 'swatch'
      swatch.style.background = option.color
      btn.appendChild(swatch)
      const label = document.createElement('span')
      label.textContent = option.label || '(vazio)'
      btn.appendChild(label)
      btn.addEventListener('click', (event) => {
        event.stopPropagation()
        const rows = this.getSelectedRows()
        if (rows.length > 1 && this.selection?.col === col && rows.includes(row)) {
          const changes = rows.map((r) => ({ row: r, col, value: option.label as CellValue }))
          this.callbacks.onCellChange(changes)
        } else {
          this.callbacks.onCellChange([{ row, col, value: option.label }])
        }
        popover.remove()
      })
      popover.appendChild(btn)
    }

    document.body.appendChild(popover)
    const rect = cell.getBoundingClientRect()
    const popHeight = popover.offsetHeight
    const popWidth = popover.offsetWidth
    const wantTop = rect.bottom + 4
    const wantLeft = rect.left
    const top = wantTop + popHeight > window.innerHeight ? Math.max(8, rect.top - popHeight - 4) : wantTop
    const left = wantLeft + popWidth > window.innerWidth ? Math.max(8, window.innerWidth - popWidth - 8) : wantLeft
    popover.style.top = `${top}px`
    popover.style.left = `${left}px`

    const close = (event: MouseEvent) => {
      if (!popover.contains(event.target as Node)) {
        popover.remove()
        document.removeEventListener('mousedown', close)
      }
    }
    setTimeout(() => document.addEventListener('mousedown', close))
  }

  private openFilterPopover(anchor: HTMLElement, col: number) {
    if (!this.activeSheetId) return
    const sheet = this.getActiveSheet()
    if (!sheet) return
    const mode: 'filter' | 'sort' = col === SORTABLE_COL ? 'sort' : 'filter'

    const existing = document.querySelector('.filter-popover')
    if (existing) existing.remove()

    const filtersMap = this.getSheetFilters(this.activeSheetId)
    const currentFilter = filtersMap.get(col)
    const currentSort = this.sorts.get(this.activeSheetId)

    const popover = document.createElement('div')
    popover.className = 'filter-popover'
    popover.addEventListener('click', (event) => event.stopPropagation())

    if (mode === 'sort') {
      const sortRow = document.createElement('div')
      sortRow.className = 'filter-sort-row'
      const sortAsc = document.createElement('button')
      sortAsc.type = 'button'
      sortAsc.className = 'filter-sort-btn' + (currentSort?.col === col && currentSort.dir === 'asc' ? ' is-active' : '')
      sortAsc.innerHTML = '<span class="sort-icon">↑</span> Ordenar A → Z'
      const sortDesc = document.createElement('button')
      sortDesc.type = 'button'
      sortDesc.className = 'filter-sort-btn' + (currentSort?.col === col && currentSort.dir === 'desc' ? ' is-active' : '')
      sortDesc.innerHTML = '<span class="sort-icon">↓</span> Ordenar Z → A'
      sortRow.appendChild(sortAsc)
      sortRow.appendChild(sortDesc)
      popover.appendChild(sortRow)

      if (currentSort?.col === col) {
        const sortClear = document.createElement('button')
        sortClear.type = 'button'
        sortClear.className = 'filter-sort-clear'
        sortClear.textContent = 'Tirar ordenação'
        popover.appendChild(sortClear)
        sortClear.addEventListener('click', () => {
          this.sorts.delete(this.activeSheetId!)
          this.recomputeOrder()
          this.render()
          this.emitViewStateChange()
          popover.remove()
        })
      }

      sortAsc.addEventListener('click', () => {
        this.sorts.set(this.activeSheetId!, { col, dir: 'asc' })
        this.recomputeOrder()
        this.render()
        this.emitViewStateChange()
        popover.remove()
      })
      sortDesc.addEventListener('click', () => {
        this.sorts.set(this.activeSheetId!, { col, dir: 'desc' })
        this.recomputeOrder()
        this.render()
        this.emitViewStateChange()
        popover.remove()
      })
    } else {
      const valueCounts = new Map<string, number>()
      const rowDates = sheet.rowDates ?? []
      for (let r = 0; r < sheet.rows.length; r++) {
        if (this.dateFilter && (rowDates[r] ?? '') !== this.dateFilter) continue
        const v = sheet.rows[r]?.[col]
        const key = v == null ? '' : String(v)
        valueCounts.set(key, (valueCounts.get(key) ?? 0) + 1)
      }
      const sortedValues = [...valueCounts.keys()].sort((a, b) =>
        a.localeCompare(b, 'pt-BR', { sensitivity: 'base', numeric: true }),
      )
      const checkedSet = currentFilter ?? new Set<string>()

      const searchInput = document.createElement('input')
      searchInput.type = 'search'
      searchInput.className = 'filter-search'
      searchInput.placeholder = 'Buscar valores...'
      popover.appendChild(searchInput)

      const selectAllLabel = document.createElement('label')
      selectAllLabel.className = 'filter-select-all-label'
      const selectAll = document.createElement('input')
      selectAll.type = 'checkbox'
      selectAll.checked = !!currentFilter && currentFilter.size === sortedValues.length
      selectAll.indeterminate = !!currentFilter && currentFilter.size > 0 && currentFilter.size < sortedValues.length
      selectAllLabel.appendChild(selectAll)
      const selectAllText = document.createElement('span')
      selectAllText.textContent = '(Selecionar tudo)'
      selectAllLabel.appendChild(selectAllText)
      popover.appendChild(selectAllLabel)

      const valuesWrap = document.createElement('div')
      valuesWrap.className = 'filter-values'
      popover.appendChild(valuesWrap)

      for (const value of sortedValues) {
        const label = document.createElement('label')
        label.className = 'filter-value'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.value = value
        cb.checked = checkedSet.has(value)
        label.appendChild(cb)
        const text = document.createElement('span')
        text.className = 'filter-value-text'
        text.textContent = value === '' ? '(vazio)' : value
        label.appendChild(text)
        const count = document.createElement('span')
        count.className = 'filter-value-count'
        count.textContent = String(valueCounts.get(value) ?? 0)
        label.appendChild(count)
        valuesWrap.appendChild(label)
      }

      selectAll.addEventListener('change', () => {
        valuesWrap.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((cb) => {
          if (cb.closest<HTMLElement>('.filter-value')?.style.display !== 'none') cb.checked = selectAll.checked
        })
      })

      searchInput.addEventListener('input', () => {
        const q = searchInput.value.toLowerCase()
        valuesWrap.querySelectorAll<HTMLLabelElement>('.filter-value').forEach((row) => {
          const text = row.querySelector('.filter-value-text')?.textContent ?? ''
          row.style.display = !q || text.toLowerCase().includes(q) ? '' : 'none'
        })
      })

      const footer = document.createElement('div')
      footer.className = 'filter-footer'
      const clearBtn = document.createElement('button')
      clearBtn.type = 'button'
      clearBtn.className = 'filter-clear'
      clearBtn.textContent = 'Limpar filtro'
      const applyBtn = document.createElement('button')
      applyBtn.type = 'button'
      applyBtn.className = 'filter-apply'
      applyBtn.textContent = 'Aplicar'
      footer.appendChild(clearBtn)
      footer.appendChild(applyBtn)
      popover.appendChild(footer)

      clearBtn.addEventListener('click', () => {
        filtersMap.delete(col)
        this.recomputeOrder()
        this.render()
        this.emitViewStateChange()
        popover.remove()
      })
      applyBtn.addEventListener('click', () => {
        const allowed = new Set<string>()
        valuesWrap.querySelectorAll<HTMLInputElement>('input[type=checkbox]').forEach((cb) => {
          if (cb.checked) allowed.add(cb.value)
        })
        if (allowed.size === 0 || allowed.size === sortedValues.length) {
          filtersMap.delete(col)
        } else {
          filtersMap.set(col, allowed)
        }
        this.recomputeOrder()
        this.render()
        this.emitViewStateChange()
        popover.remove()
      })
    }

    document.body.appendChild(popover)
    const rect = anchor.getBoundingClientRect()
    const popHeight = popover.offsetHeight
    const popWidth = popover.offsetWidth
    const top = rect.bottom + 4 + popHeight > window.innerHeight
      ? Math.max(8, rect.top - popHeight - 4)
      : rect.bottom + 4
    const left = Math.min(window.innerWidth - popWidth - 8, Math.max(8, rect.left - 4))
    popover.style.top = `${top}px`
    popover.style.left = `${left}px`

    const close = (event: MouseEvent) => {
      if (!popover.contains(event.target as Node) && event.target !== anchor) {
        popover.remove()
        document.removeEventListener('mousedown', close)
      }
    }
    setTimeout(() => document.addEventListener('mousedown', close))
  }

  private openLightbox(url: string, fileName: string) {
    const overlay = document.createElement('div')
    overlay.className = 'lightbox-overlay'

    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'lightbox-close'
    closeBtn.textContent = '×'

    const zoomBadge = document.createElement('span')
    zoomBadge.className = 'lightbox-zoom'
    zoomBadge.textContent = '100%'

    const hint = document.createElement('span')
    hint.className = 'lightbox-hint'
    hint.textContent = 'scroll: zoom · arraste: mover · duplo clique: reset · esc: fechar'

    const figure = document.createElement('figure')
    figure.className = 'lightbox-figure'

    const imgWrap = document.createElement('div')
    imgWrap.className = 'lightbox-img-wrap'

    const img = document.createElement('img')
    img.src = url
    img.alt = fileName
    img.draggable = false
    imgWrap.appendChild(img)

    const caption = document.createElement('figcaption')
    caption.textContent = fileName

    figure.appendChild(imgWrap)
    figure.appendChild(caption)

    overlay.appendChild(closeBtn)
    overlay.appendChild(zoomBadge)
    overlay.appendChild(hint)
    overlay.appendChild(figure)

    const MIN_SCALE = 0.4
    const MAX_SCALE = 2
    let scale = MAX_SCALE
    let tx = 0
    let ty = 0
    let dragging = false
    let lastX = 0
    let lastY = 0

    const clampPan = () => {
      // Mantem a imagem dentro do wrap: |tx|<=overflowX/2 e |ty|<=overflowY/2.
      // Antes do load, clientWidth=0 → pula clamp (sem efeito).
      const baseW = img.clientWidth
      const baseH = img.clientHeight
      const wrapW = imgWrap.clientWidth
      const wrapH = imgWrap.clientHeight
      if (baseW === 0 || baseH === 0) return
      const overflowX = Math.max(0, (scale * baseW - wrapW) / 2)
      const overflowY = Math.max(0, (scale * baseH - wrapH) / 2)
      tx = Math.max(-overflowX, Math.min(overflowX, tx))
      ty = Math.max(-overflowY, Math.min(overflowY, ty))
    }

    const applyTransform = () => {
      clampPan()
      img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
      zoomBadge.textContent = `${Math.round(scale * 100)}%`
      imgWrap.style.cursor = scale > 1.001 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in'
    }

    const zoomAtPoint = (clientX: number, clientY: number, factor: number) => {
      const rect = img.getBoundingClientRect()
      const cx = clientX - (rect.left + rect.width / 2)
      const cy = clientY - (rect.top + rect.height / 2)
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor))
      if (next === scale) return
      const ratio = next / scale
      tx = cx - (cx - tx) * ratio
      ty = cy - (cy - ty) * ratio
      scale = next
      if (scale <= 1.001) {
        scale = 1
        tx = 0
        ty = 0
      }
      applyTransform()
    }

    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18
      zoomAtPoint(event.clientX, event.clientY, factor)
    }

    const onMouseDown = (event: MouseEvent) => {
      if (scale <= 1.001) return
      event.preventDefault()
      dragging = true
      lastX = event.clientX
      lastY = event.clientY
      imgWrap.style.cursor = 'grabbing'
    }
    const onMouseMove = (event: MouseEvent) => {
      if (!dragging) return
      tx += event.clientX - lastX
      ty += event.clientY - lastY
      lastX = event.clientX
      lastY = event.clientY
      applyTransform()
    }
    const onMouseUp = () => {
      if (!dragging) return
      dragging = false
      applyTransform()
    }

    const onDblClick = (event: MouseEvent) => {
      event.preventDefault()
      if (scale > 1.01) {
        scale = 1
        tx = 0
        ty = 0
        applyTransform()
      } else {
        zoomAtPoint(event.clientX, event.clientY, 2.4)
      }
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
      else if (event.key === '0') {
        scale = 1
        tx = 0
        ty = 0
        applyTransform()
      } else if (event.key === '+' || event.key === '=') {
        const rect = imgWrap.getBoundingClientRect()
        zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.25)
      } else if (event.key === '-' || event.key === '_') {
        const rect = imgWrap.getBoundingClientRect()
        zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.25)
      }
    }

    const close = () => {
      overlay.remove()
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
    }

    overlay.addEventListener('click', (event) => {
      if (event.target !== img) close()
    })
    imgWrap.addEventListener('wheel', onWheel, { passive: false })
    imgWrap.addEventListener('mousedown', onMouseDown)
    imgWrap.addEventListener('dblclick', onDblClick)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    document.addEventListener('keydown', onKey)

    document.body.appendChild(overlay)
    applyTransform()
  }

  private select(row: number, col: number) {
    const wasEditing = this.editing !== null
    this.selection = { col, anchorRow: row, activeRow: row }
    this.extraRows.clear()
    this.editing = null
    if (wasEditing) {
      this.render()
    } else {
      this.refreshSelectionClasses()
    }
    this.emitSelection()
  }

  private extendSelection(row: number) {
    if (!this.selection) return
    const wasEditing = this.editing !== null
    this.selection = { ...this.selection, activeRow: row }
    this.editing = null
    if (wasEditing) {
      this.render()
    } else {
      this.refreshSelectionClasses()
    }
    this.emitSelection()
  }

  private startEdit(row: number, col: number) {
    this.selection = { col, anchorRow: row, activeRow: row }
    this.editing = { row, col }
    this.render()
  }

  private commitEdit(row: number, col: number, value: string) {
    this.editing = null
    this.render()
    this.callbacks.onCellChange([{ row, col, value: value === '' ? null : value }])
  }

  private cancelEdit() {
    this.editing = null
    this.render()
  }

  private emitSelection() {
    if (!this.selection) return
    const sheet = this.getActiveSheet()
    if (!sheet) return
    const { activeRow, col } = this.selection
    const value = sheet.rows[activeRow]?.[col] ?? null
    const rows = this.getSelectedRows()
    const ref = rows.length > 1
      ? `${formatCellRef(rows[0], col)}:${formatCellRef(rows[rows.length - 1], col)}`
      : formatCellRef(activeRow, col)
    this.callbacks.onSelectCell(ref, value, rows.length)
  }

  private emitViewStateChange() {
    this.callbacks.onViewStateChange?.()
  }

  private focusSelection() {
    if (!this.selection) return
    const { activeRow, col } = this.selection
    const sel = this.root.querySelector<HTMLElement>(
      `td[data-row="${activeRow}"][data-col="${col}"]`,
    )
    if (sel && this.editing) {
      sel.querySelector('input')?.focus()
    }
  }

  private getSelectedRows(): number[] {
    if (!this.selection) return []
    const anchorPos = this.visibleOrder.indexOf(this.selection.anchorRow)
    const activePos = this.visibleOrder.indexOf(this.selection.activeRow)
    let rangeRows: number[]
    if (anchorPos < 0 || activePos < 0) {
      rangeRows = [this.selection.activeRow]
    } else {
      const lo = Math.min(anchorPos, activePos)
      const hi = Math.max(anchorPos, activePos)
      rangeRows = this.visibleOrder.slice(lo, hi + 1)
    }
    if (this.extraRows.size === 0) return rangeRows
    // Combina range + extras; dedup; mantém ordem do visibleOrder.
    const set = new Set<number>(rangeRows)
    for (const r of this.extraRows) set.add(r)
    return this.visibleOrder.filter((r) => set.has(r))
  }

  private isRowInSelection(row: number): boolean {
    if (!this.selection) return false
    if (this.extraRows.has(row)) return true
    const anchorPos = this.visibleOrder.indexOf(this.selection.anchorRow)
    const activePos = this.visibleOrder.indexOf(this.selection.activeRow)
    const rowPos = this.visibleOrder.indexOf(row)
    if (rowPos < 0) return false
    const lo = Math.min(anchorPos, activePos)
    const hi = Math.max(anchorPos, activePos)
    return rowPos >= lo && rowPos <= hi
  }

  private canStartDragSelection(event: MouseEvent): boolean {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return false
    const target = event.target as HTMLElement | null
    return !target?.closest('button, input, textarea, select, img, .status-pill')
  }

  private stopDragSelection = () => {
    this.dragSelectionCol = null
  }

  // Ctrl-click: toggle row na seleção extra (não-contígua). Garante mesma
  // coluna da seleção atual; se col diferente, reinicia a seleção nessa col.
  private toggleExtraRow(row: number, col: number) {
    if (!this.selection || this.selection.col !== col) {
      this.extraRows.clear()
      this.selection = { col, anchorRow: row, activeRow: row }
    } else if (this.extraRows.has(row)) {
      this.extraRows.delete(row)
    } else {
      this.extraRows.add(row)
    }
    this.editing = null
    this.refreshSelectionClasses()
    this.emitSelection()
  }

  private renderEmpty() {
    const empty = document.createElement('div')
    empty.className = 'sheet-empty'
    empty.innerHTML = `
      <div class="sheet-empty-box">
        <strong>Nenhuma planilha aberta</strong>
      </div>
    `
    this.root.appendChild(empty)
  }

  private renderLoading() {
    const wrap = document.createElement('div')
    wrap.className = 'sheet-loading'
    wrap.innerHTML = `
      <div class="sheet-loading-box">
        <div class="sheet-loading-spinner"></div>
        <strong>Carregando planilha…</strong>
      </div>
    `
    this.root.appendChild(wrap)
  }
}
