import type { SessionRole } from './auth.js'

/** Planilha que o login de avaliação vê no lugar da principal. Mesmo app, outro workbook. */
export const REVIEW_WORKBOOK_ID = 'wb_avaliacao'

/** Coluna G — nome do destinatário. */
const RECIPIENT_COL = 6

/**
 * Setembro/2026 e qualquer data anterior. Outubro/2026 em diante fica com o nome inteiro.
 * Datas que não estão em DD-MM-YYYY não são mascaradas.
 */
export function isRecipientMaskDate(sheetDate: string): boolean {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(sheetDate.trim())
  if (!match) return false
  const month = Number(match[2])
  const year = Number(match[3])
  if (month < 1 || month > 12) return false
  if (year < 2026) return true
  if (year > 2026) return false
  return month <= 9
}

/** "Kleberio" → "K******o". Cada palavra: primeira letra, asteriscos, última letra. */
export function maskPersonName(name: string): string {
  return name.split(/(\s+)/).map((part) => {
    if (!part || /^\s+$/.test(part)) return part
    const chars = Array.from(part)
    if (chars.length <= 1) return part
    const stars = '*'.repeat(Math.max(1, chars.length - 2))
    return `${chars[0]}${stars}${chars[chars.length - 1]}`
  }).join('')
}

export function maskRecipientInRow(row: unknown, sheetDate: string): unknown {
  if (!isRecipientMaskDate(sheetDate)) return row
  if (!Array.isArray(row) || row.length <= RECIPIENT_COL) return row
  const name = row[RECIPIENT_COL]
  if (typeof name !== 'string' || name.trim() === '') return row
  const copy = row.slice()
  copy[RECIPIENT_COL] = maskPersonName(name)
  return copy
}

function isChatPath(path: string): boolean {
  return /\/(?:conversations|buyer-chats|chat-history|messages|auto-greet|link-conversations|webchat-push|attachments)(?:\/|$)/.test(path)
}

function isLabelPath(path: string): boolean {
  return /\/(?:shipping-label|shipping-parameter)(?:\/|$)/.test(path)
}

/**
 * O login de avaliação só alcança a planilha de outubro.
 * O login da loja não vê essa planilha.
 */
export function workbookAccessBlock(
  path: string,
  role: SessionRole | null,
  workbookIdQuery?: string,
): string | null {
  if (!role) return null
  const ids = new Set<string>()
  const match = /\/workbooks\/([^/?]+)/.exec(path)
  if (match?.[1]) ids.add(decodeURIComponent(match[1]))
  if (workbookIdQuery) ids.add(workbookIdQuery)
  for (const id of ids) {
    const reviewSheet = id === REVIEW_WORKBOOK_ID
    if (role === 'review' && !reviewSheet) return 'Planilha não encontrada'
    if (role !== 'review' && reviewSheet) return 'Planilha não encontrada'
  }
  return null
}

/** Mensagem de bloqueio do login de avaliação, ou null se a rota pode seguir. */
export function reviewAccessBlock(method: string, path: string, role: SessionRole | null): string | null {
  if (role !== 'review') return null
  if (path === '/logout' || path === '/login') return null
  if (isChatPath(path)) return 'Este acesso não inclui chat.'
  if (isLabelPath(path)) return 'Este acesso não inclui etiquetas.'
  if (method !== 'GET' && method !== 'HEAD') return 'Este acesso é somente leitura.'
  return null
}
