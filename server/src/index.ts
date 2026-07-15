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
import { ensureShopeeWorkbook, SHOPEE_WEBHOOK_WORKBOOK_ID } from './shopee-workbook.js'
import backupRouter from './routes/backup.js'
import emojiCatalogRouter from './routes/emoji-catalog.js'
import imagesRouter from './routes/images.js'
import loginRouter from './routes/login.js'
import parseIssuesRouter from './routes/parse-issues.js'
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
 * Poll pedidos recentes — via oficial de importação pra wb_shopee (a planilha que o time usa).
 * Duas janelas por create_time E update_time (syncRecentShopeeOrders / syncRecentlyUpdatedShopeeOrders):
 * só create_time perdia pedido ANTIGO que muda de status (ex.: pago dias depois de criado) —
 * nunca era "recente" pra criação, não caía em "Sem data" nem em READY_TO_SHIP
 * (resyncReadyToShipDates só reconfere quem JÁ está READY_TO_SHIP no nosso banco), então ficava
 * com status velho pra sempre — ver memória `bug-shopee-unpaid-nunca-resincroniza-2026-07-15`.
 * Além disso, reconsulta os pedidos presos na aba "Sem data de envio" (resyncPendingDateOrders),
 * reconfere a data de todo pedido em READY_TO_SHIP (resyncReadyToShipDates) — cobre data errada
 * antiga e o caso da Shopee empurrar o ship_by_date +1 dia depois da 1ª importação — e reconfere
 * TODO pedido armazenado como PROCESSED (resyncProcessedOrders), sem depender de janela de tempo:
 * pedido pode ficar dias em PROCESSED antes de virar SHIPPED/COMPLETED, fora do alcance das duas
 * janelas de tempo acima — achado 2026-07-15, 22 "PROCESSED" no banco vs 1 real na Shopee, ver
 * memória `bug-shopee-processed-nunca-resincroniza-2026-07-15`.
 * Todas as chamadas abaixo são só pra wb_shopee (default de todos os parâmetros workbookId) —
 * a planilha experimental do webhook (SHOPEE_WEBHOOK_WORKBOOK_ID) tem seu próprio poll leve logo
 * abaixo, já que ela recebe pedido novo/mudança de status via push, não via este poll.
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

/**
 * Resync leve só da aba "Sem data de envio" da planilha experimental do webhook
 * (SHOPEE_WEBHOOK_WORKBOOK_ID) — pedido novo/mudança de status já chega em tempo real via push
 * (ver PUSH_PROCESSING_ENABLED em shopee-push-process.ts); só falta reconferir quem ficou sem
 * ship_by_date na hora do push (strictShipDate=true em handleOrderStatusPush/handlePlaceOrderPush
 * evita usar create_time como fallback ali, pra não misturar data de compra com data de envio).
 * Guard de busy próprio — não compete com runShopeeRecentPoll (que é só de wb_shopee).
 */
const SHOPEE_WEBHOOK_PENDING_POLL_MS = 2 * 60 * 60 * 1000
let shopeeWebhookPendingBusy = false

async function runShopeeWebhookPendingResync(): Promise<void> {
  if (shopeeWebhookPendingBusy || !env.shopeePartnerKey || !loadShopeeAuth()) return
  shopeeWebhookPendingBusy = true
  try {
    const pending = await resyncPendingDateOrders(SHOPEE_WEBHOOK_WORKBOOK_ID, true)
    if (pending.updated > 0 || pending.errors.length > 0) {
      console.log('[shopee-webhook-poll] concluído', {
        pendingRechecked: pending.listed,
        pendingResolved: pending.updated,
        errors: pending.errors.length,
      })
    }
  } catch (error) {
    console.warn('[shopee-webhook-poll]', error instanceof Error ? error.message : error)
  } finally {
    shopeeWebhookPendingBusy = false
  }
}

setTimeout(() => void runShopeeWebhookPendingResync(), 90_000)
setInterval(() => void runShopeeWebhookPendingResync(), SHOPEE_WEBHOOK_PENDING_POLL_MS)

app.listen(env.port, () => {
  console.log(`Planilha Pro server on http://localhost:${env.port}`)
  console.log(`Data dir: ${env.dataDir}`)
})
