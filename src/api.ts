import type { CellStyle, CellValue, WorkbookData } from './types'

const API_BASE = '/api'

export interface WorkbookSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  count: number
  columnWidths: Record<string, number>
}

export interface ServerOrder {
  id: string
  row: CellValue[]
  styles: Record<string, CellStyle>
  disappeared: boolean
  sheetDate?: string
  position: number
  updatedAt: number
  images: Array<{ col: number; url: string; fileName: string; mime: string; size?: number; updatedAt?: number }>
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

/* ===========================================================
   Workbook CRUD
   =========================================================== */

export async function listWorkbooks(): Promise<WorkbookSummary[]> {
  return request<WorkbookSummary[]>('/workbooks')
}

export async function createWorkbook(name: string): Promise<WorkbookSummary> {
  return request<WorkbookSummary>('/workbooks', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function renameWorkbook(id: string, name: string): Promise<{ ok: true; updatedAt: number }> {
  return request(`/workbooks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ name }),
  })
}

export async function deleteWorkbook(id: string): Promise<{ ok: true }> {
  return request(`/workbooks/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  })
}

export async function duplicateWorkbook(id: string, name?: string): Promise<WorkbookSummary> {
  return request<WorkbookSummary>(`/workbooks/${encodeURIComponent(id)}/duplicate`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

/* ===========================================================
   Workbook data (orders/images) — scoped por workbookId
   =========================================================== */

export async function fetchWorkbook(
  workbookId: string,
  since?: number,
): Promise<ServerWorkbookResponse> {
  const query = since != null ? `?since=${since}` : ''
  return request<ServerWorkbookResponse>(
    `/workbooks/${encodeURIComponent(workbookId)}/data${query}`,
  )
}

export async function replaceWorkbook(
  workbookId: string,
  payload: {
    orders: Array<{
      id: string
      row: CellValue[]
      styles?: Record<string, CellStyle>
      disappeared?: boolean
      sheetDate?: string
    }>
    columnWidths?: Record<number, number>
  },
): Promise<{ updatedAt: number; count: number }> {
  return request(`/workbooks/${encodeURIComponent(workbookId)}/replace`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export async function patchOrder(
  workbookId: string,
  orderId: string,
  patch: { row?: CellValue[]; styles?: Record<string, CellStyle>; disappeared?: boolean },
): Promise<{ updatedAt: number }> {
  return request(
    `/workbooks/${encodeURIComponent(workbookId)}/orders/${encodeURIComponent(orderId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    },
  )
}

export async function uploadImage(
  workbookId: string,
  orderId: string,
  col: number,
  blob: Blob,
  fileName: string,
): Promise<{ url: string; updatedAt: number }> {
  const body = new FormData()
  body.append('image', blob, fileName)
  const response = await fetch(
    `${API_BASE}/workbooks/${encodeURIComponent(workbookId)}/images/${encodeURIComponent(orderId)}/${col}`,
    {
      method: 'POST',
      credentials: 'include',
      body,
    },
  )
  if (response.status === 401) throw new AuthRequiredError()
  if (!response.ok) {
    const detail = await response.json().catch(() => ({ error: response.statusText }))
    throw new Error(detail.error ?? `HTTP ${response.status}`)
  }
  return (await response.json()) as { url: string; updatedAt: number }
}

export async function deleteImage(
  workbookId: string,
  orderId: string,
  col: number,
): Promise<{ updatedAt: number }> {
  return request(
    `/workbooks/${encodeURIComponent(workbookId)}/images/${encodeURIComponent(orderId)}/${col}`,
    { method: 'DELETE' },
  )
}

export async function deleteOrdersBySheetDate(
  workbookId: string,
  sheetDate: string,
): Promise<{ ok: true; deleted: number; sheetDate: string; updatedAt: number }> {
  return request(
    `/workbooks/${encodeURIComponent(workbookId)}/orders?sheetDate=${encodeURIComponent(sheetDate)}`,
    { method: 'DELETE' },
  )
}

/** Converte payload do servidor pra WorkbookData (formato que a grid usa) */
export function serverWorkbookToLocal(workbookId: string, server: ServerWorkbook): WorkbookData {
  const rows: CellValue[][] = []
  const rowDates: string[] = []
  const images: Record<string, { url: string; fileName: string; updatedAt?: number }> = {}
  const cellStyles: Record<string, CellStyle> = {}
  const rowFlags: Record<number, { disappeared?: boolean }> = {}

  server.orders.forEach((order, idx) => {
    rows.push(order.row)
    rowDates.push(order.sheetDate ?? '')
    for (const [colKey, style] of Object.entries(order.styles ?? {})) {
      cellStyles[`${idx}:${colKey}`] = style
    }
    if (order.disappeared) rowFlags[idx] = { disappeared: true }
    for (const img of order.images) {
      images[`${idx}:${img.col}`] = { url: img.url, fileName: img.fileName, updatedAt: img.updatedAt }
    }
  })

  const columnWidths: Record<number, number> = {}
  for (const [colKey, width] of Object.entries(server.columnWidths ?? {})) {
    columnWidths[Number(colKey)] = width
  }

  const sheetId = `sheet-${workbookId}`
  return {
    id: workbookId,
    name: server.name,
    importedAt: new Date(server.updatedAt).toISOString(),
    sheetOrder: [sheetId],
    sheets: {
      [sheetId]: {
        id: sheetId,
        name: server.name,
        headers: FIXED_HEADERS,
        rows,
        rowDates,
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
