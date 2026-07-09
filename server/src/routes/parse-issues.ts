import { Router } from 'express'

import { requireAuth } from '../auth.js'
import { db, nowMs } from '../db.js'
import { scanOrdersForParseIssues } from '../sku-rules.js'
import { SHOPEE_WORKBOOK_ID } from '../shopee-workbook.js'

const router = Router()

interface ParseIssueRow {
  id: number
  workbook_id: string
  order_key: string
  order_id: string
  sku: string
  model_name: string
  reason: string
  resolved: number
  created_at: number
  resolved_at: number | null
}

/** GET /api/parse-issues?resolved=0&workbookId= — lista pendências do parser SKU→peça. */
router.get('/parse-issues', requireAuth, (req, res) => {
  const workbookId =
    typeof req.query.workbookId === 'string' && req.query.workbookId.trim()
      ? req.query.workbookId.trim()
      : SHOPEE_WORKBOOK_ID
  const resolvedRaw = typeof req.query.resolved === 'string' ? req.query.resolved.trim() : '0'
  const rows = db
    .prepare(
      resolvedRaw === 'all'
        ? 'SELECT * FROM parse_issues WHERE workbook_id = ? ORDER BY created_at DESC'
        : 'SELECT * FROM parse_issues WHERE workbook_id = ? AND resolved = ? ORDER BY created_at DESC',
    )
    .all(...(resolvedRaw === 'all' ? [workbookId] : [workbookId, resolvedRaw === '1' ? 1 : 0])) as ParseIssueRow[]
  res.json({ ok: true, workbookId, issues: rows })
})

/** POST /api/parse-issues/scan — varre as orders do workbook e registra pendências novas. */
router.post('/parse-issues/scan', requireAuth, (req, res) => {
  const workbookId =
    typeof req.body?.workbookId === 'string' && req.body.workbookId.trim()
      ? req.body.workbookId.trim()
      : SHOPEE_WORKBOOK_ID
  try {
    const issuesCreated = scanOrdersForParseIssues(workbookId)
    res.json({ ok: true, workbookId, issuesCreated })
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Erro ao varrer pedidos',
    })
  }
})

/** POST /api/parse-issues/:id/resolve — marca 1 pendência como resolvida. */
router.post('/parse-issues/:id/resolve', requireAuth, (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isFinite(id) || id <= 0) {
    res.status(400).json({ error: 'id inválido' })
    return
  }
  const now = nowMs()
  const result = db
    .prepare('UPDATE parse_issues SET resolved = 1, resolved_at = ? WHERE id = ? AND resolved = 0')
    .run(now, id)
  if (result.changes === 0) {
    res.status(404).json({ error: 'Pendência não encontrada ou já resolvida' })
    return
  }
  res.json({ ok: true, id, resolvedAt: now })
})

export default router
