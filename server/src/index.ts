import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'
import sharp from 'sharp'

import { newRunId, pruneAudit, recordAudit } from './audit.js'
import { cleanupExpiredSessions, requireAuth } from './auth.js'
import { env, isProd } from './env.js'
import { ASSETS_DIR, ensureEmojiCatalogSeeded } from './emoji-catalog.js'
import {
  resyncPendingDateOrders,
  resyncProcessedOrders,
  resyncReadyToShipDates,
  syncRecentShopeeOrders,
  syncRecentlyUpdatedShopeeOrders,
  SHOPEE_POLL_LOOKBACK_HOURS,
} from './shopee-order-sync.js'
import { loadShopeeAuth } from './shopee-store.js'
import {
  linkConversationsScanChunk,
  loadLinkStartCursor,
  saveLinkStartCursor,
} from './shopee-link-conversations.js'
import { ensureShopeeWorkbook, SHOPEE_WORKBOOK_ID } from './shopee-workbook.js'
import auditRouter from './routes/audit.js'
import backupRouter from './routes/backup.js'
import emojiCatalogRouter from './routes/emoji-catalog.js'
import imagesRouter from './routes/images.js'
import loginRouter from './routes/login.js'
import parseIssuesRouter from './routes/parse-issues.js'
import pickerRouter from './routes/picker.js'
import piecesRouter from './routes/pieces.js'
import shopeePushRouter, { handleShopeePushPost } from './routes/shopee-push.js'
import shopeeProductsRouter from './routes/shopee-products.js'
import shopeeTestRouter from './routes/shopee-test.js'
import workbookRouter from './routes/workbook.js'
import workbooksRouter from './routes/workbooks.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * Node/libvips detectam a CPU do HOST, não a fração real alocada ao container (cgroup
 * não é lido por padrão) — num VPS pequeno, isso faz o sharp abrir mais threads do que
 * núcleo de verdade disponível, e as threads competem entre si em vez de acelerar (é
 * por isso que renderizar a arte fica bem mais lento no servidor do que no PC local,
 * mesmo fazendo o mesmo trabalho). `SHARP_CONCURRENCY` no ambiente do Dokploy deixa
 * fixar o número real de vCPUs alocadas; sem ela, usa um teto conservador de 2.
 */
sharp.concurrency(Number(process.env.SHARP_CONCURRENCY) || Math.min(2, os.cpus().length))

const app = express()

app.set('trust proxy', isProd ? 1 : 0)

app.use(
  cors({
    origin: env.corsOrigin,
    credentials: true,
  }),
)
app.use(cookieParser())

// Shopee push: body bruto para HMAC (antes do express.json)
app.post(
  '/api/shopee/push',
  express.raw({ type: () => true, limit: '1mb' }),
  handleShopeePushPost,
)

app.use(express.json({ limit: '10mb' }))

app.use('/api', loginRouter)
app.use('/api', workbooksRouter)
app.use('/api', workbookRouter)
app.use('/api', imagesRouter)
app.use('/api', backupRouter)
app.use('/api', shopeePushRouter)
app.use('/api', shopeeTestRouter)
app.use('/api', shopeeProductsRouter)
app.use('/api', parseIssuesRouter)
app.use('/api', piecesRouter)
app.use('/api', pickerRouter)
app.use('/api', emojiCatalogRouter)
app.use('/api', auditRouter)

// imagens builtin do catálogo de emoji (server/assets/emojis, servido em build-time) —
// cache longo no navegador: são bytes fixos (baked na imagem Docker), só a LISTA de
// nomes/atalhos é que precisa vir sempre fresca (ver loadEmojiCatalog no client).
app.use('/emoji-assets', requireAuth, express.static(ASSETS_DIR, { maxAge: '7d', immutable: true }))

// Molde PSD de emoji — público de propósito: o Photopea (domínio externo) precisa
// baixar o arquivo via CORS. Não tem dado sensível, é só o template de artes.
const emojiMoldDir = path.resolve(__dirname, '../assets/emoji-mold')
app.use(
  '/emoji-mold',
  (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
    next()
  },
  express.static(emojiMoldDir, { maxAge: '1d' }),
)

// healthcheck público
app.get('/healthz', (_req, res) => res.json({ ok: true }))

// servir client em produção (Vite build em /app/public)
const publicDir = path.resolve(__dirname, '../public')
if (existsSync(publicDir)) {
  app.use(express.static(publicDir, { index: false }))
  app.get('*', (_req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'))
  })
  console.log(`Servindo client estático de ${publicDir}`)
}

// limpar sessões expiradas a cada hora
setInterval(cleanupExpiredSessions, 60 * 60 * 1000)
cleanupExpiredSessions()
ensureShopeeWorkbook()
ensureEmojiCatalogSeeded()

// Reinício do servidor é o evento que explica buraco no log — registrar sempre.
recordAudit({
  source: 'boot',
  event: 'servidor.iniciado',
  detail: { nodeEnv: env.nodeEnv, dataDir: env.dataDir, pid: process.pid },
})
setInterval(() => {
  const removidos = pruneAudit()
  if (removidos > 0) console.log(`[audit] ${removidos} evento(s) fora da retenção removidos`)
}, 24 * 60 * 60 * 1000)
pruneAudit()

/**
 * Poll pedidos recentes — roda em cima de wb_shopee (única planilha), junto com o webhook
 * (PUSH_PROCESSING_ENABLED em shopee-push-process.ts, reativado 2026-07-15): o webhook cobre
 * tempo real, este poll cobre o que ele não alcança (pedido antigo que muda de status fora do
 * radar do push, falha de entrega do push, etc). Duas janelas por create_time E update_time
 * (syncRecentShopeeOrders / syncRecentlyUpdatedShopeeOrders): só create_time perdia pedido
 * ANTIGO que muda de status (ex.: pago dias depois de criado) — ver memória
 * `bug-shopee-unpaid-nunca-resincroniza-2026-07-15`. Além disso, reconsulta os pedidos presos na
 * aba "Sem data de envio" (resyncPendingDateOrders), reconfere a data de todo pedido em
 * READY_TO_SHIP (resyncReadyToShipDates) — cobre data errada antiga e o caso da Shopee empurrar o
 * ship_by_date +1 dia depois da 1ª importação — e reconfere TODO pedido armazenado como PROCESSED
 * (resyncProcessedOrders), sem depender de janela de tempo — ver memória
 * `bug-shopee-processed-nunca-resincroniza-2026-07-15`.
 */
const SHOPEE_POLL_MS = 2 * 60 * 60 * 1000
let shopeePollBusy = false

async function runShopeeRecentPoll(): Promise<void> {
  if (shopeePollBusy || !env.shopeePartnerKey || !loadShopeeAuth()) {
    if (shopeePollBusy) {
      recordAudit({ source: 'poll', event: 'poll.pulado', level: 'warn', detail: { motivo: 'execução anterior ainda rodando' } })
    }
    return
  }
  shopeePollBusy = true
  // Toda escrita das 5 rotinas abaixo carrega este runId no audit_log — dá pra reconstruir
  // exatamente o que uma rodada do cron fez, mesmo semanas depois.
  const runId = newRunId('poll')
  const ctx = { source: 'poll' as const, runId }
  const t0 = Date.now()
  recordAudit({ source: 'poll', runId, event: 'poll.inicio', detail: { lookbackHours: SHOPEE_POLL_LOOKBACK_HOURS } })
  try {
    const result = await syncRecentShopeeOrders({ hours: SHOPEE_POLL_LOOKBACK_HOURS, ctx })
    const updated = await syncRecentlyUpdatedShopeeOrders({ hours: SHOPEE_POLL_LOOKBACK_HOURS, ctx })
    const pending = await resyncPendingDateOrders(SHOPEE_WORKBOOK_ID, ctx)
    const readyToShip = await resyncReadyToShipDates(SHOPEE_WORKBOOK_ID, ctx)
    const processed = await resyncProcessedOrders(SHOPEE_WORKBOOK_ID, ctx)
    const todosErros = [
      ...result.errors,
      ...updated.errors,
      ...pending.errors,
      ...readyToShip.errors,
      ...processed.errors,
    ]
    const resumo = {
      listed: result.listed,
      created: result.created,
      updated: result.updated,
      byUpdateTimeListed: updated.listed,
      byUpdateTimeUpdated: updated.updated,
      pendingRechecked: pending.listed,
      pendingResolved: pending.updated,
      readyToShipRechecked: readyToShip.listed,
      readyToShipFixed: readyToShip.updated,
      processedRechecked: processed.listed,
      processedFixed: processed.updated,
      errors: todosErros.length,
    }
    if (
      result.created > 0 ||
      updated.updated > 0 ||
      pending.updated > 0 ||
      readyToShip.updated > 0 ||
      processed.updated > 0 ||
      todosErros.length > 0
    ) {
      console.log('[shopee-poll] concluído', resumo)
    }
    // Sempre registra, inclusive rodada sem novidade: silêncio no log não pode ser
    // ambíguo entre "nada mudou" e "o cron parou de rodar".
    recordAudit({
      source: 'poll',
      runId,
      event: 'poll.fim',
      level: todosErros.length > 0 ? 'warn' : 'info',
      detail: { ...resumo, duracaoMs: Date.now() - t0, erros: todosErros },
    })
    await vincularConversasAuto(runId)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[shopee-poll]', msg)
    recordAudit({
      source: 'poll',
      runId,
      event: 'poll.falhou',
      level: 'error',
      detail: { erro: msg, duracaoMs: Date.now() - t0 },
    })
  } finally {
    shopeePollBusy = false
  }
}

/**
 * Vincula conversas do chat aos pedidos — o que antes era o botão "Vincular
 * conversas Shopee" na barra. O botão saiu da tela (pedido do user), então
 * roda aqui junto do poll: sem isso, comprador novo nunca vincularia e o
 * disparo automático de prévias o pularia como "sem chat vinculado".
 *
 * Best-effort e um chunk por poll: é uma varredura paginada e cara, e o
 * cursor persiste entre execuções, então cada rodada avança um pedaço.
 */
async function vincularConversasAuto(runId?: string): Promise<void> {
  try {
    const r = await linkConversationsScanChunk(SHOPEE_WORKBOOK_ID, {
      nextTimestampNano: loadLinkStartCursor() ?? undefined,
    })
    if (r.nextTimestampNano) saveLinkStartCursor(r.nextTimestampNano)
    if (r.linkedThisChunk > 0) {
      console.log('[shopee-link-auto] vinculados', {
        novos: r.linkedThisChunk,
        total: r.linked,
        conversasVarridas: r.conversationsScanned,
      })
    }
    recordAudit({
      source: 'poll',
      runId,
      event: 'link_conversas.chunk',
      detail: {
        novos: r.linkedThisChunk,
        total: r.linked,
        conversasVarridas: r.conversationsScanned,
        cursor: r.nextTimestampNano ?? null,
      },
    })
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    console.warn('[shopee-link-auto]', msg)
    recordAudit({ source: 'poll', runId, event: 'link_conversas.falhou', level: 'error', detail: { erro: msg } })
  }
}

setTimeout(() => void runShopeeRecentPoll(), 60_000)
setInterval(() => void runShopeeRecentPoll(), SHOPEE_POLL_MS)

app.listen(env.port, () => {
  console.log(`Planilha Pro server on http://localhost:${env.port}`)
  console.log(`Data dir: ${env.dataDir}`)
})
