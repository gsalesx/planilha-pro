import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'

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
import { ensureShopeeWorkbook } from './shopee-workbook.js'
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
  if (shopeePollBusy || !env.shopeePartnerKey || !loadShopeeAuth()) return
  shopeePollBusy = true
  try {
    const result = await syncRecentShopeeOrders({ hours: SHOPEE_POLL_LOOKBACK_HOURS })
    const updated = await syncRecentlyUpdatedShopeeOrders({ hours: SHOPEE_POLL_LOOKBACK_HOURS })
    const pending = await resyncPendingDateOrders()
    const readyToShip = await resyncReadyToShipDates()
    const processed = await resyncProcessedOrders()
    const errors =
      result.errors.length +
      updated.errors.length +
      pending.errors.length +
      readyToShip.errors.length +
      processed.errors.length
    if (
      result.created > 0 ||
      updated.updated > 0 ||
      pending.updated > 0 ||
      readyToShip.updated > 0 ||
      processed.updated > 0 ||
      errors > 0
    ) {
      console.log('[shopee-poll] concluído', {
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
        errors,
      })
    }
  } catch (error) {
    console.warn('[shopee-poll]', error instanceof Error ? error.message : error)
  } finally {
    shopeePollBusy = false
  }
}

setTimeout(() => void runShopeeRecentPoll(), 60_000)
setInterval(() => void runShopeeRecentPoll(), SHOPEE_POLL_MS)

app.listen(env.port, () => {
  console.log(`Planilha Pro server on http://localhost:${env.port}`)
  console.log(`Data dir: ${env.dataDir}`)
})
