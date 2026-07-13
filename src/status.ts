import type { StatusOption, StatusValue } from './types'

export const STATUS_COLUMN_INDEX = 5 // coluna F (Status)

/** Status após envio de prévia no chat Shopee. */
export const PREVIEW_SENT_STATUS = 'Prévia'

export const STATUS_OPTIONS: StatusOption[] = [
  { label: '', color: '#ffffff' },
  { label: 'Pronto', color: '#34d399' },
  { label: 'Separado', color: '#93c5fd' },
  { label: 'Em produção 1', color: '#5eead4' },
  { label: 'Em produção 2', color: '#2dd4bf' },
  { label: 'Em produção 3', color: '#0d9488', textColor: '#ffffff' },
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
  return STATUS_BY_LABEL.get(key) ?? STATUS_OPTIONS[0]
}

export function isValidStatus(value: unknown): value is StatusValue {
  if (value == null || value === '') return true
  const key = String(value).trim().toLowerCase()
  return STATUS_BY_LABEL.has(key)
}
