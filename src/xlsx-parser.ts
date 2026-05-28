import JSZip from 'jszip'
import * as XLSX from 'xlsx'

import type { CellImage, CellStyle, CellValue, RowFlags, SheetData, WorkbookData } from './types'

const ID_COL = 0
const STATUS_COL = 5
export const FIXED_HEADERS = [
  'ID do pedido',
  'Nome do Produto',
  'Modelo',
  'Qnt.',
  'Nome de usuário',
  'Status',
  'Nome do destinatário',
  'Foto',
  'Foto 2',
  '+ Fotos',
]
const COLUMN_COUNT = FIXED_HEADERS.length

interface RawImage {
  row: number
  column: number
  blob: Blob
  fileName: string
}

const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function getElementsByLocalName(element: ParentNode, name: string): Element[] {
  return Array.from(element.querySelectorAll('*')).filter((node) => node.localName === name)
}

function firstChildText(element: Element, name: string): string {
  return getElementsByLocalName(element, name)[0]?.textContent || ''
}

function getRelationshipId(element: Element): string {
  return (
    element.getAttribute('r:id') ||
    element.getAttribute('r:embed') ||
    element.getAttributeNS(NS_R, 'id') ||
    element.getAttributeNS(NS_R, 'embed') ||
    ''
  )
}

function resolveZipPath(fromPart: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const stack = fromPart.split('/').slice(0, -1)
  for (const part of target.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') stack.pop()
    else stack.push(part)
  }
  return stack.join('/')
}

function relsPathFor(partPath: string): string {
  const parts = partPath.split('/')
  const file = parts.pop()
  return `${parts.join('/')}/_rels/${file}.rels`
}

async function readRelationships(zip: JSZip, partPath: string): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const file = zip.file(relsPathFor(partPath))
  if (!file) return out
  const doc = new DOMParser().parseFromString(await file.async('string'), 'application/xml')
  for (const rel of getElementsByLocalName(doc, 'Relationship')) {
    const id = rel.getAttribute('Id')
    const target = rel.getAttribute('Target')
    if (id && target) out.set(id, resolveZipPath(partPath, target))
  }
  return out
}

function mimeTypeFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase()
  if (ext === 'png') return 'image/png'
  if (ext === 'gif') return 'image/gif'
  if (ext === 'webp') return 'image/webp'
  return 'image/jpeg'
}

async function getWorksheetPaths(zip: JSZip): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const workbookFile = zip.file('xl/workbook.xml')
  if (!workbookFile) return out
  const rels = await readRelationships(zip, 'xl/workbook.xml')
  const doc = new DOMParser().parseFromString(await workbookFile.async('string'), 'application/xml')
  for (const sheet of getElementsByLocalName(doc, 'sheet')) {
    const name = sheet.getAttribute('name')
    const rid = getRelationshipId(sheet)
    const part = rels.get(rid)
    if (name && part) out.set(name, part)
  }
  return out
}

async function extractImagesBySheet(buffer: ArrayBuffer): Promise<Map<string, RawImage[]>> {
  const zip = await JSZip.loadAsync(buffer)
  const sheetPaths = await getWorksheetPaths(zip)
  const result = new Map<string, RawImage[]>()

  for (const [sheetName, worksheetPart] of sheetPaths) {
    const worksheetFile = zip.file(worksheetPart)
    if (!worksheetFile) continue

    const worksheetRels = await readRelationships(zip, worksheetPart)
    const worksheetDoc = new DOMParser().parseFromString(
      await worksheetFile.async('string'),
      'application/xml',
    )

    for (const drawing of getElementsByLocalName(worksheetDoc, 'drawing')) {
      const drawingPart = worksheetRels.get(getRelationshipId(drawing))
      const drawingFile = drawingPart ? zip.file(drawingPart) : null
      if (!drawingPart || !drawingFile) continue

      const drawingRels = await readRelationships(zip, drawingPart)
      const drawingDoc = new DOMParser().parseFromString(
        await drawingFile.async('string'),
        'application/xml',
      )

      const anchors = [
        ...getElementsByLocalName(drawingDoc, 'twoCellAnchor'),
        ...getElementsByLocalName(drawingDoc, 'oneCellAnchor'),
      ]

      for (const anchor of anchors) {
        const blip = getElementsByLocalName(anchor, 'blip')[0]
        const mediaPath = blip ? drawingRels.get(getRelationshipId(blip)) : null
        const mediaFile = mediaPath ? zip.file(mediaPath) : null
        if (!mediaPath || !mediaFile) continue

        const marker = getElementsByLocalName(anchor, 'from')[0]
        if (!marker) continue
        const row = Number(firstChildText(marker, 'row'))
        const column = Number(firstChildText(marker, 'col'))
        if (!Number.isFinite(row) || !Number.isFinite(column)) continue

        const blob = await mediaFile.async('blob')
        const list = result.get(sheetName) || []
        list.push({
          row,
          column,
          blob: new Blob([blob], { type: mimeTypeFromPath(mediaPath) }),
          fileName: mediaPath.split('/').pop() || 'image.jpg',
        })
        result.set(sheetName, list)
      }
    }
  }

  return result
}

function normalizeCell(value: unknown): CellValue {
  if (value == null) return null
  if (typeof value === 'number' || typeof value === 'string') return value
  return String(value)
}

function isDateSheet(name: string): boolean {
  // Aceita DD-MM-YYYY (formato novo do Zoho Sheets) ou YYYY_MM_DD (legado).
  return /^\d{2}-\d{2}-\d{4}$/.test(name) || /^\d{4}_\d{2}_\d{2}/.test(name)
}

function buildHeaderColumnMap(sheetHeaders: string[]): number[] {
  const norm = (s: string) =>
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .trim()

  const target = FIXED_HEADERS.map(norm)
  const map: number[] = new Array(COLUMN_COUNT).fill(-1)

  for (let t = 0; t < target.length; t++) {
    for (let s = 0; s < sheetHeaders.length; s++) {
      if (norm(sheetHeaders[s]) === target[t]) {
        map[t] = s
        break
      }
    }
  }
  // fallback: positional mapping if header matching missed slots
  for (let t = 0; t < COLUMN_COUNT; t++) {
    if (map[t] === -1) map[t] = t
  }
  return map
}

interface NewPedido {
  id: string
  row: CellValue[]
  sheetDate: string
  images: Map<number, CellImage>
}

export interface ParseOptions {
  onProgress?: (msg: string, current?: number, total?: number) => void
  existing?: WorkbookData | null
}

export async function parseXlsx(file: File, options: ParseOptions = {}): Promise<WorkbookData> {
  const { onProgress, existing } = options
  onProgress?.('Lendo arquivo...')
  const buffer = await file.arrayBuffer()

  onProgress?.('Lendo abas...')
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })

  onProgress?.('Extraindo imagens...')
  const imagesBySheet = await extractImagesBySheet(buffer)

  const sheetNames = workbook.SheetNames.filter((name) => isDateSheet(name))
  const allSheetNames = sheetNames.length > 0 ? sheetNames : workbook.SheetNames

  const newPedidos: NewPedido[] = []
  for (const sheetName of allSheetNames) {
    const worksheet = workbook.Sheets[sheetName]
    if (!worksheet || !worksheet['!ref']) continue
    const range = XLSX.utils.decode_range(worksheet['!ref'])

    const sheetHeaders: string[] = []
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = worksheet[XLSX.utils.encode_cell({ r: range.s.r, c })]
      sheetHeaders.push(cell ? String(cell.w ?? cell.v ?? '') : '')
    }
    const columnMap = buildHeaderColumnMap(sheetHeaders)

    const sheetImages = imagesBySheet.get(sheetName) ?? []
    const imagesByBodyRow = new Map<number, RawImage[]>()
    for (const img of sheetImages) {
      const bodyRow = img.row - 1
      if (bodyRow < 0) continue
      const list = imagesByBodyRow.get(bodyRow) ?? []
      list.push(img)
      imagesByBodyRow.set(bodyRow, list)
    }

    let bodyRowIndex = 0
    for (let r = range.s.r + 1; r <= range.e.r; r++) {
      const row: CellValue[] = new Array(COLUMN_COUNT).fill(null)
      let hasValue = false
      for (let target = 0; target < COLUMN_COUNT; target++) {
        const source = columnMap[target]
        if (source < 0) continue
        const cell = worksheet[XLSX.utils.encode_cell({ r, c: range.s.c + source })]
        const value = cell ? normalizeCell(cell.w ?? cell.v) : null
        if (value != null && value !== '') hasValue = true
        row[target] = value
      }
      const id = String(row[ID_COL] ?? '').trim()

      const images = new Map<number, CellImage>()
      const rawImages = imagesByBodyRow.get(bodyRowIndex) ?? []
      for (const img of rawImages) {
        const targetCol = columnMap.indexOf(img.column)
        const finalCol = targetCol >= 0 ? targetCol : img.column
        images.set(finalCol, { blob: img.blob, fileName: img.fileName })
      }

      if (hasValue && id) {
        newPedidos.push({ id, row, sheetDate: sheetName, images })
      }
      bodyRowIndex++
    }
  }

  // dedupe new pedidos by ID — last in wins
  const newById = new Map<string, NewPedido>()
  for (const pedido of newPedidos) {
    newById.set(pedido.id, pedido)
  }

  // build existing index by ID
  const existingById = new Map<string, {
    row: CellValue[]
    sheetDate: string
    styles: Map<number, CellStyle>
    images: Map<number, CellImage>
  }>()
  if (existing && existing.sheetOrder.length > 0) {
    const sheet = existing.sheets[existing.sheetOrder[0]]
    if (sheet) {
      for (let r = 0; r < sheet.rows.length; r++) {
        const id = String(sheet.rows[r]?.[ID_COL] ?? '').trim()
        if (!id) continue
        const styles = new Map<number, CellStyle>()
        for (const [key, val] of Object.entries(sheet.cellStyles ?? {})) {
          const [rr, cc] = key.split(':').map(Number)
          if (rr === r && val?.bg) styles.set(cc, val)
        }
        const images = new Map<number, CellImage>()
        for (const [key, val] of Object.entries(sheet.images)) {
          const [rr, cc] = key.split(':').map(Number)
          if (rr === r) images.set(cc, val)
        }
        existingById.set(id, {
          row: sheet.rows[r],
          sheetDate: sheet.rowDates?.[r] ?? '',
          styles,
          images,
        })
      }
    }
  }

  // merge
  const finalRows: CellValue[][] = []
  const finalRowDates: string[] = []
  const finalImages: Record<string, CellImage> = {}
  const finalStyles: Record<string, CellStyle> = {}
  const finalFlags: Record<number, RowFlags> = {}

  for (const [id, pedido] of newById) {
    const idx = finalRows.length
    const row = [...pedido.row]
    const prior = existingById.get(id)
    if (prior) {
      const priorStatus = prior.row[STATUS_COL]
      if (priorStatus != null && priorStatus !== '') {
        row[STATUS_COL] = priorStatus
      }
      finalRows.push(row)
      finalRowDates.push(pedido.sheetDate) // data nova vence
      for (const [col, style] of prior.styles) {
        finalStyles[`${idx}:${col}`] = style
      }
      for (const [col, img] of prior.images) {
        finalImages[`${idx}:${col}`] = img
      }
    } else {
      finalRows.push(row)
      finalRowDates.push(pedido.sheetDate)
      for (const [col, img] of pedido.images) {
        finalImages[`${idx}:${col}`] = img
      }
    }
  }

  for (const [id, prior] of existingById) {
    if (newById.has(id)) continue
    const idx = finalRows.length
    finalRows.push([...prior.row])
    finalRowDates.push(prior.sheetDate)
    finalFlags[idx] = { disappeared: true }
    for (const [col, style] of prior.styles) {
      finalStyles[`${idx}:${col}`] = style
    }
    for (const [col, img] of prior.images) {
      finalImages[`${idx}:${col}`] = img
    }
  }

  // compute column widths
  const columnWidths: Record<number, number> = {}
  for (let c = 0; c < COLUMN_COUNT; c++) {
    let maxLen = FIXED_HEADERS[c].length
    for (const row of finalRows) {
      const text = row[c] == null ? '' : String(row[c])
      const longestLine = text.split(/\r?\n/).reduce((m, l) => Math.max(m, l.length), 0)
      if (longestLine > maxLen) maxLen = longestLine
    }
    columnWidths[c] = Math.min(Math.max(maxLen * 7 + 24, 80), 320)
  }

  const sheetId = 'sheet-relatorios'
  const sheet: SheetData = {
    id: sheetId,
    name: 'Relatórios',
    headers: FIXED_HEADERS,
    rows: finalRows,
    rowDates: finalRowDates,
    images: finalImages,
    cellStyles: finalStyles,
    rowFlags: finalFlags,
    columnWidths,
  }

  return {
    id: existing?.id ?? 'workbook-relatorios',
    name: 'Relatórios',
    importedAt: new Date().toISOString(),
    sheetOrder: [sheetId],
    sheets: { [sheetId]: sheet },
  }
}
