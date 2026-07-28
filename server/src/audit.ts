import { randomUUID } from 'node:crypto'

import { db } from './db.js'

/**
 * Trilha de auditoria das rotinas automáticas (poll, webhook, upsert, automação).
 * Ver comentário da tabela `audit_log` em db.ts pro porquê.
 *
 * Princípio: registrar é best-effort e NUNCA pode derrubar a operação que está sendo
 * auditada — todo caminho de escrita aqui engole exceção.
 */

export type AuditLevel = 'info' | 'warn' | 'error'

/** De onde veio a ação. `poll` = cron de 2h · `push` = webhook Shopee · `api` = chamada externa. */
export type AuditSource = 'poll' | 'push' | 'api' | 'boot' | 'manual'

export interface AuditEntry {
  source: AuditSource
  event: string
  level?: AuditLevel
  runId?: string | null
  workbookId?: string | null
  orderSn?: string | null
  orderKey?: string | null
  detail?: unknown
}

export interface AuditRow {
  id: number
  at: number
  level: AuditLevel
  source: AuditSource
  event: string
  run_id: string | null
  workbook_id: string | null
  order_sn: string | null
  order_key: string | null
  detail_json: string
}

/** Retenção em dias. Log é barato e o valor dele é justamente olhar semanas depois. */
const RETENTION_DAYS = Math.max(Number(process.env.AUDIT_RETENTION_DAYS ?? 365), 7)

/** Teto por evento — payload cru de webhook é útil, mas não a ponto de inchar o backup. */
const MAX_DETAIL_CHARS = 8000

const insertStmt = db.prepare(
  `INSERT INTO audit_log (at, level, source, event, run_id, workbook_id, order_sn, order_key, detail_json)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
)

function serializeDetail(detail: unknown): string {
  if (detail == null) return '{}'
  try {
    const json = JSON.stringify(detail, (_k, v) => (v instanceof Error ? { name: v.name, message: v.message, stack: v.stack } : v))
    if (json == null) return '{}'
    return json.length > MAX_DETAIL_CHARS
      ? JSON.stringify({ truncated: true, chars: json.length, head: json.slice(0, MAX_DETAIL_CHARS) })
      : json
  } catch (error) {
    return JSON.stringify({ serializeError: error instanceof Error ? error.message : String(error) })
  }
}

/** Grava um evento. Sempre chamar com o máximo de contexto disponível. */
export function recordAudit(entry: AuditEntry): void {
  try {
    insertStmt.run(
      Date.now(),
      entry.level ?? 'info',
      entry.source,
      entry.event,
      entry.runId ?? null,
      entry.workbookId ?? null,
      entry.orderSn ?? null,
      entry.orderKey ?? null,
      serializeDetail(entry.detail),
    )
  } catch (error) {
    console.warn('[audit] falha ao gravar evento', entry.event, error instanceof Error ? error.message : error)
  }
}

/** Id que amarra todos os eventos de uma mesma execução (um poll, um push). */
export function newRunId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`
}

export interface AuditQuery {
  since?: number
  until?: number
  source?: string
  event?: string
  level?: string
  orderSn?: string
  orderKey?: string
  runId?: string
  /** Casa em order_sn, order_key, event e detail_json. */
  search?: string
  limit?: number
  offset?: number
}

export function queryAudit(q: AuditQuery = {}): { total: number; rows: AuditRow[] } {
  const where: string[] = []
  const params: unknown[] = []
  if (q.since != null) { where.push('at >= ?'); params.push(q.since) }
  if (q.until != null) { where.push('at <= ?'); params.push(q.until) }
  if (q.source) { where.push('source = ?'); params.push(q.source) }
  if (q.event) { where.push('event LIKE ?'); params.push(`${q.event}%`) }
  if (q.level) { where.push('level = ?'); params.push(q.level) }
  if (q.orderSn) { where.push('order_sn = ?'); params.push(q.orderSn) }
  if (q.orderKey) { where.push('order_key = ?'); params.push(q.orderKey) }
  if (q.runId) { where.push('run_id = ?'); params.push(q.runId) }
  if (q.search) {
    where.push('(order_sn LIKE ? OR order_key LIKE ? OR event LIKE ? OR detail_json LIKE ?)')
    const like = `%${q.search}%`
    params.push(like, like, like, like)
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = (db.prepare(`SELECT COUNT(*) AS n FROM audit_log ${clause}`).get(...params) as { n: number }).n
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 5000)
  const rows = db
    .prepare(`SELECT * FROM audit_log ${clause} ORDER BY at DESC, id DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, Math.max(q.offset ?? 0, 0)) as AuditRow[]
  return { total, rows }
}

/** Resumo por evento numa janela — é o "relatório dos crons/webhooks" do dia. */
export function auditSummary(sinceMs: number): Array<{ source: string; event: string; level: string; n: number; last_at: number }> {
  return db
    .prepare(
      `SELECT source, event, level, COUNT(*) AS n, MAX(at) AS last_at
         FROM audit_log WHERE at >= ?
        GROUP BY source, event, level
        ORDER BY n DESC`,
    )
    .all(sinceMs) as Array<{ source: string; event: string; level: string; n: number; last_at: number }>
}

export function pruneAudit(): number {
  try {
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
    const r = db.prepare('DELETE FROM audit_log WHERE at < ?').run(cutoff)
    return r.changes
  } catch (error) {
    console.warn('[audit] falha ao limpar log antigo', error instanceof Error ? error.message : error)
    return 0
  }
}
