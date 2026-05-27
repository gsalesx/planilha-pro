import type { CellStyle, CellValue, WorkbookData } from './types'

const API_BASE = '/api'

export interface ServerOrder {
  id: string
  row: CellValue[]
  styles: Record<string, CellStyle>
  disappeared: boolean
  position: number
  updatedAt: number
  images: Array<{ col: number; url: string; fileName: string; mime: string }>
}

export interface ServerWorkbook {
  unchanged: false
  updatedAt: number
  name: string
  columnWidths: Record<string, number>
  orders: ServerOrder[]
}

export interface ServerUnchanged {
  unchanged: true
  updatedAt: number
}

export type ServerWorkbookResponse = ServerWorkbook | ServerUnchanged

export class AuthRequiredError extends Error {
  constructor() {
    super('Login necessário')
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (response.status === 401) throw new AuthRequiredError()
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(detail.error ?? `HTTP ${response.status}`)
  }
  return (await response.json()) as T
}

export async function checkAuth(): Promise<boolean> {
  try {
    await request('/me')
    return true
  } catch (error) {
    if (error instanceof AuthRequiredError) return false
    throw error
  }
}

export async function login(username: string, password: string): Promise<void> {
  await request('/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
}

export async function logout(): Promise<void> {
  await request('/logout', { method: 'POST' })
}

export async function fetchWorkbook(since?: number): Promise<ServerWorkbookResponse> {
  const query = since != null ? `?since=${since}` : ''
  return request<ServerWorkbookResponse>(`/workbook${query}`)
}

export async function replaceWorkbook(payload: {
  orders: Array<{
    id: string
    row: CellValue[]
    styles?: Record<string, CellStyle>
    disappeared?: boolean
  }>
  columnWidths?: Record<number, number>
}): Promise<{ updatedAt: number; count: number }> {
  return request('/workbook/replace', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function patchOrder(
  orderId: string,
  patch: { row?: CellValue[]; styles?: Record<string, CellStyle>; disappeared?: boolean },
): Promise<{ updatedAt: number }> {
  return request(`/orders/${encodeURIComponent(orderId)}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  })
}

export async function uploadImage(
  orderId: string,
  col: number,
  blob: Blob,
  fileName: string,
): Promise<{ url: string; updatedAt: number }> {
  const body = new FormData()
  body.append('image', blob, fileName)
  const response = await fetch(`${API_BASE}/images/${encodeURIComponent(orderId)}/${col}`, {
    method: 'POST',
    credentials: 'include',
    body,
  })
  if (response.status === 401) throw new AuthRequiredError()
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(detail.error ?? `HTTP ${response.status}`)
  }
  return (await response.json()) as { url: string; updatedAt: number }
}

export async function deleteImage(orderId: string, col: number): Promise<{ updatedAt: number }> {
  return request(`/images/${encodeURIComponent(orderId)}/${col}`, { method: 'DELETE' })
}

/** Converte payload do servidor pra WorkbookData (formato que a grid usa) */
export function serverWorkbookToLocal(server: ServerWorkbook): WorkbookData {
  const rows: CellValue[][] = []
  const images: Record<string, { url: string; fileName: string }> = {}
  const cellStyles: Record<string, CellStyle> = {}
  const rowFlags: Record<number, { disappeared?: boolean }> = {}

  server.orders.forEach((order, idx) => {
    rows.push(order.row)
    for (const [colKey, style] of Object.entries(order.styles ?? {})) {
      cellStyles[`${idx}:${colKey}`] = style
    }
    if (order.disappeared) rowFlags[idx] = { disappeared: true }
    for (const img of order.images) {
      images[`${idx}:${img.col}`] = { url: img.url, fileName: img.fileName }
    }
  })

  const columnWidths: Record<number, number> = {}
  for (const [colKey, width] of Object.entries(server.columnWidths ?? {})) {
    columnWidths[Number(colKey)] = width
  }

  const sheetId = 'sheet-relatorios'
  return {
    id: 'workbook-relatorios',
    name: server.name,
    importedAt: new Date(server.updatedAt).toISOString(),
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: server.name,
        headers: FIXED_HEADERS,
        rows,
        images,
        cellStyles,
        rowFlags,
        columnWidths,
      },
    },
  }
}

const FIXED_HEADERS = [
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
