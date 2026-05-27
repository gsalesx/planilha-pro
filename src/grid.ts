import { findStatusOption, STATUS_COLUMN_INDEX, STATUS_OPTIONS } from './status'
import type { CellValue, SheetData, WorkbookData } from './types'

const ID_COLUMN_INDEX = 0 // coluna A (ID do pedido — chave única)
const USER_COLUMN_INDEX = 4 // coluna E (Nome de usuário)
const IMAGE_COLUMN_INDICES = new Set([7, 8, 9]) // colunas H, I, J (Foto, Foto 2, + Fotos)
const FILTERABLE_COL = 2 // coluna C (Modelo)
const SORTABLE_COL = 6 // coluna G (Nome do destinatário)
const MIN_COLUMN_COUNT = 15 // até coluna O — espaço extra pra anotações
const DEFAULT_COL_WIDTH = 110
const ROW_NUMBER_WIDTH = 44
const DEFAULT_ROW_HEIGHT = 28
const COLUMN_WIDTH_OVERRIDES: Record<number, number> = {
  1: 220, // B — Nome do Produto
  3: 56, // D — Qnt.
  6: 220, // G — Nome do destinatário
}
const CENTERED_COLUMNS = new Set([3]) // D — Qnt.
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

export interface CellChange {
  row: number
  col: number
  value: CellValue
}

export interface GridCallbacks {
  onSelectCell(ref: string, value: CellValue): void
  onCellChange(changes: CellChange[]): void
  onSheetChange?(sheetId: string): void
  onImageRequest?(rowIndex: number, colIndex: number): void
  onCellImageChange?(rowIndex: number, colIndex: number): void
  onImageDelete?(rowIndex: number, colIndex: number): void
}

export const PHOTO_COLUMN_INDEX = 7
export const PHOTO_COLUMN_INDICES = [7, 8, 9]

interface SelectionState {
  col: number
  anchorRow: number
  activeRow: number
}

interface EditingState {
  row: number
  col: number
}

interface SortState {
  col: number
  dir: 'asc' | 'desc'
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
  private sorts = new Map<string, SortState>()
  private visibleOrder: number[] = []

  constructor(root: HTMLElement, callbacks: GridCallbacks) {
    this.root = root
    this.callbacks = callbacks
  }

  setWorkbook(workbook: WorkbookData | null) {
    this.revokeImageUrls()
    this.filters.clear()
    this.sorts.clear()
    this.workbook = workbook
    this.activeSheetId = workbook?.sheetOrder[0] ?? null
    this.selection = workbook ? { col: 0, anchorRow: 0, activeRow: 0 } : null
    this.editing = null
    this.recomputeOrder()
    this.render()
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

  private recomputeOrder() {
    const sheet = this.getActiveSheet()
    if (!sheet) {
      this.visibleOrder = []
      return
    }
    let indices = sheet.rows.map((_, i) => i)
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

  private resolveImageSrc(img: { url?: string; blob?: Blob }): string {
    if (img.url) return img.url
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

  render() {
    this.root.innerHTML = ''

    if (!this.workbook) {
      this.renderEmpty()
      return
    }

    const sheet = this.getActiveSheet()
    if (!sheet) {
      this.renderEmpty()
      return
    }

    const columnCount = Math.max(MIN_COLUMN_COUNT, sheet.headers.length, STATUS_COLUMN_INDEX + 1, ...IMAGE_COLUMN_INDICES)
    const rowCount = sheet.rows.length

    const table = document.createElement('table')
    table.className = 'sheet'

    const colgroup = document.createElement('colgroup')
    const rowNumberCol = document.createElement('col')
    rowNumberCol.style.width = `${ROW_NUMBER_WIDTH}px`
    colgroup.appendChild(rowNumberCol)
    for (let c = 0; c < columnCount; c++) {
      const col = document.createElement('col')
      const width = COLUMN_WIDTH_OVERRIDES[c] ?? sheet.columnWidths[c] ?? DEFAULT_COL_WIDTH
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
      if (CENTERED_COLUMNS.has(c)) th.classList.add('cell-center')
      const headerText = sheet.headers[c] || ''
      const span = document.createElement('span')
      span.className = 'header-text'
      span.textContent = headerText
      th.appendChild(span)
      if (headerText && (c === FILTERABLE_COL || c === SORTABLE_COL)) {
        const btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'col-filter-btn'
        btn.title = c === FILTERABLE_COL ? 'Filtrar valores' : 'Ordenar A → Z / Z → A'
        const hasFilter = c === FILTERABLE_COL && !!filters?.has(c)
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

    for (const r of this.visibleOrder) {
      const tr = document.createElement('tr')
      tr.style.height = `${DEFAULT_ROW_HEIGHT}px`
      if (sheet.rowFlags?.[r]?.disappeared) tr.classList.add('row-disappeared')

      const rowNum = document.createElement('th')
      rowNum.className = 'row-num'
      rowNum.textContent = String(r + 1)
      if (selectedRows.has(r)) rowNum.classList.add('is-active')
      tr.appendChild(rowNum)

      for (let c = 0; c < columnCount; c++) {
        tr.appendChild(this.buildCell(sheet, r, c))
      }
      tbody.appendChild(tr)
    }

    return tbody
  }

  private buildCell(sheet: SheetData, row: number, col: number): HTMLTableCellElement {
    const td = document.createElement('td')
    td.dataset.row = String(row)
    td.dataset.col = String(col)
    if (CENTERED_COLUMNS.has(col)) td.classList.add('cell-center')
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
    } else if (IMAGE_COLUMN_INDICES.has(col)) {
      td.classList.add('cell-image')
      const meta = sheet.images[`${row}:${col}`]
      if (meta) {
        const wrap = document.createElement('div')
        wrap.className = 'image-cell-wrap'
        const url = this.resolveImageSrc(meta)
        const img = document.createElement('img')
        img.src = url
        img.alt = meta.fileName
        img.loading = 'lazy'
        img.addEventListener('click', (event) => {
          event.stopPropagation()
          this.openLightbox(url, meta.fileName)
        })
        const replaceBtn = document.createElement('button')
        replaceBtn.type = 'button'
        replaceBtn.className = 'image-cell-action image-cell-replace'
        replaceBtn.title = 'Trocar foto'
        replaceBtn.textContent = '↻'
        replaceBtn.addEventListener('click', (event) => {
          event.stopPropagation()
          this.selection = { col, anchorRow: row, activeRow: row }
          this.editing = null
          this.refreshSelectionClasses()
          this.emitSelection()
          this.callbacks.onImageRequest?.(row, col)
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
        wrap.appendChild(replaceBtn)
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
          const isSingleSelected =
            !!this.selection &&
            this.selection.col === col &&
            this.selection.anchorRow === row &&
            this.selection.activeRow === row
          if (!isSingleSelected) {
            this.selection = { col, anchorRow: row, activeRow: row }
            this.editing = null
            this.refreshSelectionClasses()
            this.emitSelection()
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

    td.addEventListener('click', (event) => {
      if (col === STATUS_COLUMN_INDEX) return
      event.stopPropagation()
      if (event.shiftKey && this.selection && this.selection.col === col) {
        this.extendSelection(row)
      } else {
        this.select(row, col)
      }
    })

    td.addEventListener('dblclick', (event) => {
      if (col === STATUS_COLUMN_INDEX || IMAGE_COLUMN_INDICES.has(col)) return
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
      const inRange = !!this.selection
        && this.selection.col === col
        && this.isRowInSelection(row)
      if (!inRange) {
        this.selection = { col, anchorRow: row, activeRow: row }
        this.refreshSelectionClasses()
        this.emitSelection()
      }
      this.editing = null
      this.openStatusPopover(row, col)
    })
    return pill
  }

  private refreshSelectionClasses() {
    this.root.querySelectorAll('td.is-selected, th.row-num.is-active, th.col-letter.is-active').forEach((node) => {
      node.classList.remove('is-selected', 'is-active')
    })
    if (!this.selection) return

    const tbody = this.root.querySelector('tbody')
    if (!tbody) return

    const anchorPos = this.visibleOrder.indexOf(this.selection.anchorRow)
    const activePos = this.visibleOrder.indexOf(this.selection.activeRow)
    if (anchorPos < 0 || activePos < 0) return

    const lo = Math.min(anchorPos, activePos)
    const hi = Math.max(anchorPos, activePos)
    const col = this.selection.col

    for (let pos = lo; pos <= hi; pos++) {
      const tr = tbody.children[pos] as HTMLElement | undefined
      if (!tr) continue
      tr.children[0]?.classList.add('is-active') // row-num
      tr.children[col + 1]?.classList.add('is-selected') // +1 = skip row-num
    }

    const firstHeaderRow = this.root.querySelector('thead tr:first-child')
    firstHeaderRow?.children[col + 1]?.classList.add('is-active') // +1 = skip corner
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
          popover.remove()
        })
      }

      sortAsc.addEventListener('click', () => {
        this.sorts.set(this.activeSheetId!, { col, dir: 'asc' })
        this.recomputeOrder()
        this.render()
        popover.remove()
      })
      sortDesc.addEventListener('click', () => {
        this.sorts.set(this.activeSheetId!, { col, dir: 'desc' })
        this.recomputeOrder()
        this.render()
        popover.remove()
      })
    } else {
      const valueCounts = new Map<string, number>()
      for (let r = 0; r < sheet.rows.length; r++) {
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
    const MAX_SCALE = 12
    let scale = 1
    let tx = 0
    let ty = 0
    let dragging = false
    let lastX = 0
    let lastY = 0

    const applyTransform = () => {
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
      if (event.target === overlay || event.target === closeBtn) close()
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
    this.callbacks.onSelectCell(ref, value)
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
    if (anchorPos < 0 || activePos < 0) {
      return [this.selection.activeRow]
    }
    const lo = Math.min(anchorPos, activePos)
    const hi = Math.max(anchorPos, activePos)
    return this.visibleOrder.slice(lo, hi + 1)
  }

  private isRowInSelection(row: number): boolean {
    if (!this.selection) return false
    const anchorPos = this.visibleOrder.indexOf(this.selection.anchorRow)
    const activePos = this.visibleOrder.indexOf(this.selection.activeRow)
    const rowPos = this.visibleOrder.indexOf(row)
    if (rowPos < 0) return false
    const lo = Math.min(anchorPos, activePos)
    const hi = Math.max(anchorPos, activePos)
    return rowPos >= lo && rowPos <= hi
  }

  private renderEmpty() {
    const empty = document.createElement('div')
    empty.className = 'sheet-empty'
    empty.innerHTML = `
      <div class="drop-zone" id="initial-drop-zone">
        <strong>Atualize a planilha para começar</strong>
        <span>Clique em <b>⟳ Atualizar Planilha</b> no topo · ou solte um .xlsx aqui</span>
      </div>
    `
    this.root.appendChild(empty)
  }
}
