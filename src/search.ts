import type { WorkbookData } from './types'

export interface SearchHit {
  sheetId: string
  sheetName: string
  rowIndex: number
  colIndex: number
  value: string
  type: 'cell' | 'header'
  /** YYYY_MM_DD ou DD-MM-YYYY etc — vazio = sem data */
  sheetDate: string
  /** posição 1-based DENTRO do filtro de data (não global). 0 = sem data */
  displayRow: number
}

const DEFAULT_MAX = 80

export function searchWorkbook(
  workbook: WorkbookData,
  query: string,
  maxResults = DEFAULT_MAX,
): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []

  const hits: SearchHit[] = []

  for (const sheetId of workbook.sheetOrder) {
    const sheet = workbook.sheets[sheetId]
    if (!sheet) continue

    for (let c = 0; c < sheet.headers.length; c++) {
      const value = sheet.headers[c]
      if (!value) continue
      if (value.toLowerCase().includes(q)) {
        hits.push({
          sheetId,
          sheetName: sheet.name,
          rowIndex: -1,
          colIndex: c,
          value,
          type: 'header',
          sheetDate: '',
          displayRow: 0,
        })
        if (hits.length >= maxResults) return hits
      }
    }

    // Posição 1-based dentro do dia de cada row — pra search exibir
    // "linha N do dia DD-MM-YYYY" em vez do índice global.
    const dates = sheet.rowDates ?? []
    const positionByGlobal = new Array<number>(sheet.rows.length).fill(0)
    const counterByDate = new Map<string, number>()
    for (let r = 0; r < sheet.rows.length; r++) {
      const d = dates[r] ?? ''
      const n = (counterByDate.get(d) ?? 0) + 1
      counterByDate.set(d, n)
      positionByGlobal[r] = n
    }

    for (let r = 0; r < sheet.rows.length; r++) {
      const row = sheet.rows[r]
      if (!row) continue
      for (let c = 0; c < row.length; c++) {
        const cell = row[c]
        if (cell == null || cell === '') continue
        const text = String(cell)
        if (text.toLowerCase().includes(q)) {
          hits.push({
            sheetId,
            sheetName: sheet.name,
            rowIndex: r,
            colIndex: c,
            value: text,
            type: 'cell',
            sheetDate: dates[r] ?? '',
            displayRow: positionByGlobal[r],
          })
          if (hits.length >= maxResults) return hits
        }
      }
    }
  }

  return hits
}

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

export function formatHitRef(hit: SearchHit): string {
  if (hit.type === 'header') return `${colLetter(hit.colIndex)}1 · cabeçalho`
  // Mostra "linha N · DD-MM-YYYY" — N é a posição DENTRO do dia (1-based),
  // não a posição global no workbook. Cada dia é independente.
  const n = hit.displayRow || hit.rowIndex + 2
  return hit.sheetDate ? `linha ${n} · ${hit.sheetDate}` : `linha ${n}`
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

export function highlightMatch(value: string, query: string, maxLength = 80): string {
  const escaped = escapeHtml(value)
  const q = query.trim()
  if (!q) return escaped

  const lower = value.toLowerCase()
  const idx = lower.indexOf(q.toLowerCase())
  if (idx < 0) return escaped

  const start = Math.max(0, idx - 18)
  const end = Math.min(value.length, idx + q.length + 40)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < value.length ? '…' : ''
  const slice = value.slice(start, end)
  const matchStart = idx - start
  const matchEnd = matchStart + q.length

  const before = escapeHtml(slice.slice(0, matchStart))
  const match = escapeHtml(slice.slice(matchStart, matchEnd))
  const after = escapeHtml(slice.slice(matchEnd))

  let html = `${prefix}${before}<mark>${match}</mark>${after}${suffix}`
  if (html.length > maxLength * 6) html = html.slice(0, maxLength * 6) + '…'
  return html
}
