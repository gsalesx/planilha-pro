import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import cookieParser from 'cookie-parser'
import cors from 'cors'
import express from 'express'

import { cleanupExpiredSessions } from './auth.js'
import { env, isProd } from './env.js'
import { syncRecentShopeeOrders, SHOPEE_POLL_LOOKBACK_HOURS } from './shopee-order-sync.js'
import { loadShopeeAuth } from './shopee-store.js'
import { ensureShopeeWorkbook } from './shopee-workbook.js'
import backupRouter from './routes/backup.js'
import imagesRouter from './routes/images.js'
import loginRouter from './routes/login.js'
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

/** Poll pedidos recentes — pedidos já READY_TO_SHIP não geram push até mudarem de status. */
const SHOPEE_POLL_MS = 8 * 60 * 60 * 1000
let shopeePollBusy = false

async function runShopeeRecentPoll(): Promise<void> {
  if (shopeePollBusy || !env.shopeePartnerKey || !loadShopeeAuth()) return
  shopeePollBusy = true
  try {
    const result = await syncRecentShopeeOrders({ hours: SHOPEE_POLL_LOOKBACK_HOURS })
    if (result.created > 0 || result.errors.length > 0) {
      console.log('[shopee-poll] concluído', {
        listed: result.listed,
        created: result.created,
        updated: result.updated,
        errors: result.errors.length,
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
