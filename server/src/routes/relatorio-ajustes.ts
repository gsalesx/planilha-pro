import { Router } from 'express'

import { requireAuth } from '../auth.js'
import { gravarRelatorioAjustes, paginaChats, paginaRelatorio, resumoRelatorio } from '../relatorio-ajustes.js'

const router = Router()

function numero(valor: unknown, padrao: number, max: number): number {
  const n = Number(valor)
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : padrao
}

/** GET /api/relatorio-ajustes/resumo — contagens e últimas leituras. */
router.get('/relatorio-ajustes/resumo', requireAuth, (_req, res) => {
  res.json({ ok: true, ...resumoRelatorio() })
})

/** GET /api/relatorio-ajustes?desde=<id>&limite=<n> — exportação paginada (treino). */
router.get('/relatorio-ajustes', requireAuth, (req, res) => {
  res.json({ ok: true, ...paginaRelatorio(numero(req.query.desde, 0, Number.MAX_SAFE_INTEGER), numero(req.query.limite, 1000, 5000) || 1000) })
})

/** GET /api/relatorio-ajustes/chats?desde=<id>&limite=<n> — texto dos chats dos pedidos. */
router.get('/relatorio-ajustes/chats', requireAuth, (req, res) => {
  res.json({ ok: true, ...paginaChats(numero(req.query.desde, 0, Number.MAX_SAFE_INTEGER), numero(req.query.limite, 200, 1000) || 200) })
})

/** POST /api/relatorio-ajustes/rodar — leitura fora de hora (conferência depois do deploy). */
router.post('/relatorio-ajustes/rodar', requireAuth, async (_req, res) => {
  res.json({ ok: true, resumo: await gravarRelatorioAjustes('manual') })
})

export default router
