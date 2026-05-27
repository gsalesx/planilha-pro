export type StatusValue =
  | ''
  | 'Pronto'
  | 'Separado'
  | 'Em produção'
  | 'Manual'
  | 'Editar'
  | 'Cancelado'
  | 'Aprovado'
  | 'Sem fotos'

export interface StatusOption {
  label: StatusValue
  color: string
  textColor?: string
}

export interface CellImage {
  /** url servida pelo backend (após upload) */
  url?: string
  /** blob local enquanto sobe (otimista) */
  blob?: Blob
  fileName: string
}

export interface CellStyle {
  bg?: string
}

export type CellValue = string | number | null

export interface RowFlags {
  /** pedido desapareceu do XLSX mais recente — manter linha mas sinalizar */
  disappeared?: boolean
}

export interface SheetData {
  id: string
  name: string
  headers: string[]
  rows: CellValue[][]
  /** sheet name (date) of origin, indexed by row */
  rowDates?: string[]
  /** keyed by `${rowIndex}:${colIndex}` */
  images: Record<string, CellImage>
  /** keyed by `${rowIndex}:${colIndex}` */
  cellStyles?: Record<string, CellStyle>
  /** keyed by `${rowIndex}` */
  rowFlags?: Record<number, RowFlags>
  /** column widths in px keyed by column index */
  columnWidths: Record<number, number>
}

export interface WorkbookData {
  id: string
  name: string
  importedAt: string
  sheetOrder: string[]
  sheets: Record<string, SheetData>
}
