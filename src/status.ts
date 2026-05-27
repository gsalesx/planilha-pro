import type { StatusOption, StatusValue } from './types'

export const STATUS_COLUMN_INDEX = 5 // coluna F (Status)

export const STATUS_OPTIONS: StatusOption[] = [
  { label: '', color: '#ffffff' },
  { label: 'Pronto', color: '#c084fc' },
  { label: 'Separado', color: '#93c5fd' },
  { label: 'Em produção', color: '#5eead4' },
  { label: 'Manual', color: '#fdba74' },
  { label: 'Editar', color: '#fca5a5' },
  { label: 'Cancelado', color: '#dc2626', textColor: '#ffffff' },
  { label: 'Aprovado', color: '#86efac' },
  { label: 'Sem fotos', color: '#d1d5db' },
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
