import type { StatusOption, StatusValue } from './types'

export const STATUS_COLUMN_INDEX = 5 // coluna F (Status)

/** Status após envio de prévia no chat Shopee. */
export const PREVIEW_SENT_STATUS = 'Prévia'

export const STATUS_OPTIONS: StatusOption[] = [
  { label: '', color: '#ffffff' },
  { label: 'Pronto', color: '#34d399' },
  { label: 'Separado', color: '#93c5fd' },
  { label: 'Em produção 1', color: '#fde047' },
  { label: 'Em produção 2', color: '#fb923c' },
  { label: 'Em produção 3', color: '#7e22ce', textColor: '#ffffff' },
  { label: 'Manual', color: '#fdba74' },
  { label: 'Editar', color: '#fca5a5' },
  { label: 'Cancelado', color: '#dc2626', textColor: '#ffffff' },
  { label: 'Aprovado', color: '#86efac' },
  { label: 'Sem fotos', color: '#d1d5db' },
  { label: 'Prévia', color: '#c4b5fd' },
  { label: 'Concluído', color: '#4b5563', textColor: '#f9fafb' },
]

const STATUS_BY_LABEL = new Map<string, StatusOption>(
  STATUS_OPTIONS.map((option) => [option.label.toLowerCase(), option]),
)

export function findStatusOption(value: unknown): StatusOption {
  if (value == null) return STATUS_OPTIONS[0]
  const key = String(value).trim().toLowerCase()
  // Legado: "Em produção" (sem número) trata como Em produção 1 até a migration no DB acabar.
  if (key === 'em produção') return STATUS_BY_LABEL.get('em produção 1') ?? STATUS_OPTIONS[0]
  return STATUS_BY_LABEL.get(key) ?? STATUS_OPTIONS[0]
}

export function isValidStatus(value: unknown): value is StatusValue {
  if (value == null || value === '') return true
  const key = String(value).trim().toLowerCase()
  return STATUS_BY_LABEL.has(key)
}
