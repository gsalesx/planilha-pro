import { type AuditSource, recordAudit } from './audit.js'
import { db, nowMs } from './db.js'
import {
  assertShopeeOk,
  fetchOrderListPage,
  getOrderDetail,
  type ShopeeApiResponse,
} from './shopee-api.js'
import {
  emptyShopeeRow,
  SHOPEE_COL_MODEL,
  SHOPEE_COL_INTERNAL_STATUS,
  SHOPEE_COL_ORDER_ID,
  SHOPEE_COL_PRODUCT,
  SHOPEE_COL_QTY,
  SHOPEE_COL_RECIPIENT,
  SHOPEE_COL_SHOPEE_STATUS,
  SHOPEE_COL_USERNAME,
  SHOPEE_ROW_COLS,
  SHOPEE_INTERNAL_STATUS_CANCELLED,
  SHOPEE_INTERNAL_STATUS_SHIPPED,
} from './shopee-columns.js'
import { ensureShopeeWorkbook, SHOPEE_WORKBOOK_ID } from './shopee-workbook.js'

export interface ShopeeItemRow {
  item_name?: string
  item_sku?: string
  model_name?: string
  model_sku?: string
  model_quantity_purchased?: number
  /** Foto do anúncio/produto — vem de graça no get_order_detail (não precisa
   * de response_optional_fields extra). Usada só pra referência visual do
   * operador ("o que o cliente comprou de fato"), nunca pra montar a arte. */
  image_info?: { image_url?: string }
}

export interface ShopeeOrderDetail {
  order_sn?: string
  order_status?: string
  buyer_username?: string
  create_time?: number
  /** Prazo para despachar — data prevista de envio no painel Shopee. */
  ship_by_date?: number
  recipient_address?: { name?: string }
  item_list?: ShopeeItemRow[]
}

export interface ShopeeSyncResult {
  listed: number
  created: number
  updated: number
  errors: string[]
}

/**
 * Quem disparou a escrita — vai pro audit_log pra dar pra responder "que rotina criou
 * esta linha, e quando". `rotina` é o nome da função de sync (resyncPendingDateOrders etc).
 */
export interface SyncContext {
  source?: AuditSource
  runId?: string | null
  rotina?: string
}

/**
 * O container roda em UTC (sem TZ setada). Um ship_by_date perto da virada do dia em BRT
 * (ex.: 23h de sexta em SP = 02h de sábado em UTC) formatado com Date.getDate() local vira
 * sábado no nosso banco enquanto o painel Shopee (BRT) ainda mostra sexta. Formatar explicitamente
 * em America/Sao_Paulo em vez de depender do TZ do processo evita esse desvio de 1 dia.
 */
const BRAZIL_TZ = 'America/Sao_Paulo'

function formatSheetDate(unixSec: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BRAZIL_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(unixSec * 1000))
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return `${get('day')}-${get('month')}-${get('year')}`
}

/**
 * Aba própria pra pedidos sem ship_by_date resolvido ainda — fica visível no seletor de data
 * (em vez de sumir com sheet_date vazio) e é reconsultada a cada poll de 2h (resyncPendingDateOrders).
 */
export const SHOPEE_PENDING_DATE_LABEL = 'Sem data de envio'

/**
 * Data do `<select>` no header — prevista de envio (ship_by_date), NUNCA data da compra
 * (create_time). A Shopee manda ship_by_date=0 (não null/undefined) quando ainda não calculou
 * o prazo — nesse caso o pedido fica em SHOPEE_PENDING_DATE_LABEL ("Sem data de envio") até a
 * Shopee calcular de verdade. Nunca usar create_time como data provisória (decisão do usuário
 * 2026-07-15) — o pedido fica no limbo sendo reconferido a cada poll de 2h
 * (resyncPendingDateOrders) até ter a data real, não uma data "chutada" da compra.
 */
function resolveSheetDate(order: ShopeeOrderDetail): string {
  const ts = order.ship_by_date
  return ts ? formatSheetDate(ts) : SHOPEE_PENDING_DATE_LABEL
}

function joinField(values: string[]): string {
  return values.filter(Boolean).join('; ')
}

/** Nome mascarado pela Shopee ("H******a", "****") ou ausente — nunca deve sobrescrever um nome real já salvo. */
export function isMaskedOrEmptyRecipient(name: string | undefined): boolean {
  const v = (name ?? '').trim()
  return !v || v.includes('*')
}

function itemSku(item: ShopeeItemRow): string {
  return (item.model_sku ?? item.item_sku ?? '').trim()
}

function itemImageUrl(item: ShopeeItemRow | undefined): string {
  return (item?.image_info?.image_url ?? '').trim()
}

/**
 * Col F — espelha status terminal da Shopee no fluxo interno. PROCESSED NÃO vira "Concluído"
 * automático (decisão do usuário 2026-07-14) — o pedido fica PROCESSED (pago, aguardando
 * envio) por dias antes de ser postado de verdade, sobrescrever o fluxo de produção nesse
 * momento é cedo demais. Reativado 2026-07-15 disparando em SHIPPED (postado de verdade) em
 * vez de PROCESSED.
 */
function applyInternalStatusFromShopee(row: string[], shopeeStatus: string): void {
  const status = shopeeStatus.trim().toUpperCase()
  if (status === 'CANCELLED') {
    row[SHOPEE_COL_INTERNAL_STATUS] = SHOPEE_INTERNAL_STATUS_CANCELLED
  } else if (status === 'SHIPPED') {
    row[SHOPEE_COL_INTERNAL_STATUS] = SHOPEE_INTERNAL_STATUS_SHIPPED
  }
}

export function mapShopeeOrderToRow(order: ShopeeOrderDetail): string[] {
  const row = emptyShopeeRow()
  const items = order.item_list ?? []
  row[SHOPEE_COL_ORDER_ID] = order.order_sn ?? ''
  row[SHOPEE_COL_PRODUCT] = joinField(items.map(itemSku))
  row[SHOPEE_COL_MODEL] = joinField(items.map((i) => i.model_name ?? ''))
  row[SHOPEE_COL_QTY] = String(
    items.reduce((sum, i) => sum + (i.model_quantity_purchased ?? 0), 0) || '',
  )
  row[SHOPEE_COL_USERNAME] = order.buyer_username ?? ''
  row[SHOPEE_COL_RECIPIENT] = order.recipient_address?.name ?? ''
  row[SHOPEE_COL_SHOPEE_STATUS] = order.order_status ?? ''
  return row
}

/**
 * 1 linha por UNIDADE comprada — quantidade explodida (2026-07-28).
 *
 * "5× M MASCULINO" era uma linha com Qnt=5, mas são 5 artes pra imprimir: a planilha
 * contava 1 e a produção precisava de 5. Agora cada unidade é uma linha com Qnt=1, e
 * cada uma tem sua própria arte e prévia. A 1ª unidade é a linha do pedido; as demais
 * entram como filhas (ver `parent_key`).
 *
 * Devolve também, por linha, o índice do item de origem — a foto do anúncio tem que vir
 * do item que a unidade realmente representa, nunca de outro item do mesmo carrinho.
 */
export function mapShopeeOrderToUnitRows(
  order: ShopeeOrderDetail,
): Array<{ row: string[]; itemIndex: number }> {
  const items = order.item_list ?? []
  if (items.length === 0) return [{ row: mapShopeeOrderToRow(order), itemIndex: 0 }]

  const saida: Array<{ row: string[]; itemIndex: number }> = []
  items.forEach((item, itemIndex) => {
    // Quantidade ausente/zero ainda gera 1 linha: pedido sem unidade nenhuma não existe,
    // e sumir com a linha seria pior que mostrar uma a mais.
    const qtd = Math.max(1, Number(item.model_quantity_purchased ?? 1) || 1)
    for (let u = 0; u < qtd; u++) {
      const row = emptyShopeeRow()
      row[SHOPEE_COL_ORDER_ID] = order.order_sn ?? ''
      row[SHOPEE_COL_PRODUCT] = itemSku(item)
      row[SHOPEE_COL_MODEL] = item.model_name ?? ''
      row[SHOPEE_COL_QTY] = '1'
      row[SHOPEE_COL_USERNAME] = order.buyer_username ?? ''
      row[SHOPEE_COL_RECIPIENT] = order.recipient_address?.name ?? ''
      row[SHOPEE_COL_SHOPEE_STATUS] = order.order_status ?? ''
      saida.push({ row, itemIndex })
    }
  })
  return saida
}

/** 1 linha por item (export Shopee / planilha manual). */
export function mapShopeeOrderToItemRows(order: ShopeeOrderDetail): string[][] {
  const items = order.item_list ?? []
  if (items.length === 0) return [mapShopeeOrderToRow(order)]
  return items.map((item) => {
    const row = emptyShopeeRow()
    row[SHOPEE_COL_ORDER_ID] = order.order_sn ?? ''
    row[SHOPEE_COL_PRODUCT] = itemSku(item)
    row[SHOPEE_COL_MODEL] = item.model_name ?? ''
    row[SHOPEE_COL_QTY] = String(item.model_quantity_purchased ?? '')
    row[SHOPEE_COL_USERNAME] = order.buyer_username ?? ''
    row[SHOPEE_COL_RECIPIENT] = order.recipient_address?.name ?? ''
    row[SHOPEE_COL_SHOPEE_STATUS] = order.order_status ?? ''
    return row
  })
}

export function parseShopeeOrderDetail(data: ShopeeApiResponse): ShopeeOrderDetail[] {
  return parseOrderList(data)
}

function parseOrderList(data: ShopeeApiResponse): ShopeeOrderDetail[] {
  const body = assertShopeeOk(data as ShopeeApiResponse<Record<string, unknown>>, 'get_order_detail') as {
    order_list?: ShopeeOrderDetail[]
  }
  return body.order_list ?? []
}

/**
 * Identidade da linha: 1ª unidade = o próprio pedido; demais = `pedido#N`.
 *
 * ⚠️ NADA MUTÁVEL PODE ENTRAR AQUI. O formato antigo era `{data}__{pedido}__{N}`, herdado do
 * import de XLSX — e como o `ship_by_date` muda (o pedido nasce em "Sem data de envio" e
 * ganha prazo horas depois), a key recalculada deixava de bater com a persistida: o lookup
 * falhava e o upsert inseria uma linha nova pra uma peça que já existia. Foi o que duplicou
 * a 2ª peça em 2026-07-28 (24lehsilva, livea.maria123, taty1lima, dudaahcotta, karolinetayra).
 *
 * Keys no formato antigo continuam sendo reconhecidas por `findOrderBySnOccurrence` (linhas
 * que já existiam), mas nenhuma nova é gerada assim.
 */
function shopeeOrderKey(orderSn: string, occurrence: number): string {
  if (occurrence === 1) return orderSn
  return `${orderSn}#${occurrence}`
}

interface ExistingOrderRow {
  order_key: string
  row_json: string
  sheet_date: string
  product_image_url: string
}

function findOrderByKey(orderKey: string, workbookId: string = SHOPEE_WORKBOOK_ID): ExistingOrderRow | undefined {
  return db
    .prepare(
      'SELECT order_key, row_json, sheet_date, product_image_url FROM orders WHERE workbook_id = ? AND order_key = ?',
    )
    .get(workbookId, orderKey) as ExistingOrderRow | undefined
}

function findOrdersBySn(orderSn: string, workbookId: string = SHOPEE_WORKBOOK_ID): ExistingOrderRow[] {
  return db
    .prepare(
      'SELECT order_key, row_json, sheet_date, product_image_url FROM orders WHERE workbook_id = ? AND id = ? ORDER BY order_key ASC',
    )
    .all(workbookId, orderSn) as ExistingOrderRow[]
}

/**
 * Acha a linha desta ocorrência do pedido ignorando o prefixo de data da key.
 *
 * Só serve pro formato ANTIGO (`{data}__{pedido}__{N}`): as keys novas não têm data, então
 * o lookup exato já resolve. Continua aqui enquanto existirem linhas não migradas — e como
 * rede de segurança, já que uma linha antiga que escapasse da migração voltaria a duplicar.
 * A key achada é REUSADA como está (nunca renomeada aqui): `order_pieces`, `images` e o
 * `_order_keys.json` do pipeline local referenciam a key, e trocá-la fora da migração
 * (que atualiza todos eles junto) faria a peça ser tratada como nova.
 */
function findOrderBySnOccurrence(
  orderSn: string,
  occurrence: number,
  workbookId: string = SHOPEE_WORKBOOK_ID,
): ExistingOrderRow | undefined {
  return db
    .prepare(
      // ESCAPE '\' é OBRIGATÓRIO aqui: sem a cláusula, o SQLite trata a barra
      // como caractere LITERAL (não como escape), então o padrão `%\_\_SN\_\_2`
      // passa a procurar barras de verdade dentro da key e nunca casa — o
      // fallback vira um no-op silencioso e a duplicação continua acontecendo.
      `SELECT order_key, row_json, sheet_date, product_image_url FROM orders
        WHERE workbook_id = ? AND id = ? AND order_key LIKE ? ESCAPE '\\'
        ORDER BY order_key ASC LIMIT 1`,
    )
    .get(workbookId, orderSn, `%\\_\\_${orderSn}\\_\\_${occurrence}`) as ExistingOrderRow | undefined
}

/**
 * Posição da linha nova: logo abaixo da última linha já existente do mesmo pedido, empurrando
 * o resto pra baixo. Antes ia sempre pro fim da planilha (MAX+1), então a 2ª peça de um pedido
 * importado em dois momentos aparecia dezenas de linhas depois da 1ª, com outros clientes no
 * meio (caso taty1lima 2026-07-28). Sem irmã no banco, mantém o append no fim.
 */
function posicaoParaNovaLinha(orderSn: string, workbookId: string): number {
  const irma = db
    .prepare('SELECT MAX(position) AS p FROM orders WHERE workbook_id = ? AND id = ?')
    .get(workbookId, orderSn) as { p: number | null }
  if (irma?.p == null) {
    const fim = db
      .prepare('SELECT COALESCE(MAX(position), -1) AS m FROM orders WHERE workbook_id = ?')
      .get(workbookId) as { m: number }
    return fim.m + 1
  }
  const alvo = irma.p + 1
  db.prepare('UPDATE orders SET position = position + 1 WHERE workbook_id = ? AND position >= ?')
    .run(workbookId, alvo)
  return alvo
}

/**
 * Junta as linhas de um pedido que ficaram separadas por linhas de OUTROS pedidos, mantendo-as
 * na posição da primeira. Regra do negócio: um pedido nunca pode ter outro pedido no meio dele.
 * Só é chamada quando entra linha nova — pedido antigo desalinhado não é remexido.
 * Devolve quantas linhas mudaram de posição (0 = já estava certo).
 */
export function reagruparLinhasDoPedido(orderSn: string, workbookId: string): number {
  const doPedido = db
    .prepare('SELECT order_key, position FROM orders WHERE workbook_id = ? AND id = ? ORDER BY position')
    .all(workbookId, orderSn) as Array<{ order_key: string; position: number }>
  if (doPedido.length < 2) return 0
  const primeira = doPedido[0].position
  const ultima = doPedido[doPedido.length - 1].position
  if (ultima - primeira === doPedido.length - 1) return 0

  const todas = db
    .prepare('SELECT order_key, id, position FROM orders WHERE workbook_id = ? ORDER BY position')
    .all(workbookId) as Array<{ order_key: string; id: string; position: number }>
  const chavesDoPedido = new Set(doPedido.map((l) => l.order_key))

  const novaOrdem: string[] = []
  let jaInseriu = false
  for (const linha of todas) {
    if (chavesDoPedido.has(linha.order_key)) {
      if (jaInseriu) continue
      jaInseriu = true
      for (const l of doPedido) novaOrdem.push(l.order_key)
      continue
    }
    novaOrdem.push(linha.order_key)
  }

  const atualiza = db.prepare('UPDATE orders SET position = ? WHERE workbook_id = ? AND order_key = ?')
  let movidas = 0
  const posAtual = new Map(todas.map((l) => [l.order_key, l.position]))
  db.transaction(() => {
    novaOrdem.forEach((key, i) => {
      if (posAtual.get(key) === i) return
      atualiza.run(i, workbookId, key)
      movidas++
    })
  })()
  return movidas
}

export function shopeeOrderExists(orderSn: string, workbookId: string = SHOPEE_WORKBOOK_ID): boolean {
  return findOrdersBySn(orderSn.trim(), workbookId).length > 0
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Busca detalhe na API e cria/atualiza linha — retries porque o push pode chegar antes da API indexar o pedido. */
export async function importShopeeOrderBySn(
  orderSn: string,
  fallbackStatus?: string,
  workbookId: string = SHOPEE_WORKBOOK_ID,
  ctx: SyncContext = {},
): Promise<'created' | 'updated' | 'unchanged' | 'failed'> {
  const sn = orderSn.trim()
  if (!sn) return 'failed'

  const auditBase = {
    source: ctx.source ?? ('push' as AuditSource),
    runId: ctx.runId ?? null,
    workbookId,
    orderSn: sn,
  }

  const retryDelaysMs = [0, 3000, 10000]
  for (let attempt = 0; attempt < retryDelaysMs.length; attempt++) {
    if (retryDelaysMs[attempt] > 0) await sleep(retryDelaysMs[attempt])
    try {
      const data = await getOrderDetail([sn])
      const orders = parseOrderList(data)
      const order = orders.find((o) => o.order_sn === sn) ?? orders[0]
      if (!order?.order_sn) {
        console.warn(`[shopee-push] get_order_detail vazio (tentativa ${attempt + 1}/${retryDelaysMs.length})`, sn)
        recordAudit({
          ...auditBase,
          event: 'import.detalhe_vazio',
          level: 'warn',
          detail: { rotina: ctx.rotina, tentativa: attempt + 1, de: retryDelaysMs.length },
        })
        continue
      }
      if (fallbackStatus && !order.order_status) order.order_status = fallbackStatus
      return upsertShopeeOrder(order, workbookId, ctx)
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(
        `[shopee-push] get_order_detail erro (tentativa ${attempt + 1}/${retryDelaysMs.length})`,
        sn,
        msg,
      )
      recordAudit({
        ...auditBase,
        event: 'import.erro_api',
        level: 'warn',
        detail: { rotina: ctx.rotina, tentativa: attempt + 1, de: retryDelaysMs.length, erro: msg },
      })
    }
  }
  recordAudit({
    ...auditBase,
    event: 'import.desistiu',
    level: 'error',
    detail: { rotina: ctx.rotina, tentativas: retryDelaysMs.length, fallbackStatus },
  })
  return 'failed'
}

/**
 * 1 linha por item; reimport atualiza só G+H (preserva F e demais colunas). Não escreve nada
 * (nem toca updated_at) quando a linha já está idêntica — evita "atualizado" fantasma nas
 * rotinas de reconferência (resyncPendingDateOrders/resyncReadyToShipDates) que rodam de novo
 * sobre pedidos que já estavam certos.
 */
export function upsertShopeeOrder(
  order: ShopeeOrderDetail,
  workbookId: string = SHOPEE_WORKBOOK_ID,
  ctx: SyncContext = {},
): 'created' | 'updated' | 'unchanged' {
  const orderSn = order.order_sn?.trim()
  if (!orderSn) throw new Error('order_sn ausente')

  const sheetDate = resolveSheetDate(order)

  /**
   * Pedido que JÁ tem linha no banco no formato ANTIGO (1 linha por item, sem quantidade
   * explodida) continua nesse formato — trocar pra explodido de uma hora pra outra faria um
   * "5× M MASC" que hoje é 1 linha virar 5, mexendo em coisa já publicada. Mas um pedido que
   * JÁ está no formato explodido (>1 linha armazenada) precisa CONTINUAR resincronizando pelo
   * formato explodido — senão o resync (que roda de novo pra refletir status novo da Shopee,
   * ex. READY_TO_SHIP→SHIPPED) colapsa pra 1 linha de item só, escreve só na linha-pai e as
   * filhas ficam com o status Shopee (col H) congelado no valor da criação pra sempre. Bug
   * real: adrielegiyuri (5 linhas) — pai virou SHIPPED, as 4 filhas nunca mais foram tocadas
   * porque cada resync recalculava só 1 linha de item e escrevia na key da 1ª ocorrência.
   */
  const linhasExistentes = findOrdersBySn(orderSn, workbookId)
  const jaExiste = linhasExistentes.length > 0
  const jaExplodido = linhasExistentes.length > 1
  const unidades = jaExiste && !jaExplodido
    ? mapShopeeOrderToItemRows(order).map((row, itemIndex) => ({ row, itemIndex }))
    : mapShopeeOrderToUnitRows(order)
  const itemRows = unidades.map((u) => u.row)
  const shopeeStatus = order.order_status ?? ''
  const recipient = order.recipient_address?.name ?? ''
  const now = nowMs()
  let anyCreated = false
  let anyChanged = false

  const auditBase = {
    source: ctx.source ?? ('api' as AuditSource),
    runId: ctx.runId ?? null,
    workbookId,
    orderSn,
  }

  const updateStmt = db.prepare(
    'UPDATE orders SET row_json = ?, sheet_date = ?, product_image_url = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?',
  )
  const insertStmt = db.prepare(
    `INSERT INTO orders (workbook_id, order_key, id, row_json, styles_json, disappeared, sheet_date, product_image_url, position, updated_at, parent_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  /** Key da linha-pai: a 1ª ocorrência é sempre o próprio orderSn. */
  const keyDoPai = orderSn

  for (let i = 0; i < itemRows.length; i++) {
    const occurrence = i + 1
    const orderKey = shopeeOrderKey(orderSn, occurrence)
    let existing = findOrderByKey(orderKey, workbookId)
    if (!existing && occurrence === 1) {
      const legacy = findOrdersBySn(orderSn, workbookId)
      if (legacy.length === 1) existing = legacy[0]
    }
    if (!existing && occurrence > 1) {
      // Key com prefixo de data velho (pedido saiu de "Sem data de envio"). Reusa a linha
      // que já existe em vez de criar uma nova — ver findOrderBySnOccurrence.
      existing = findOrderBySnOccurrence(orderSn, occurrence, workbookId)
      if (existing) {
        recordAudit({
          ...auditBase,
          event: 'order.key_reaproveitada',
          level: 'warn',
          orderKey: existing.order_key,
          detail: {
            rotina: ctx.rotina,
            occurrence,
            keyCalculada: orderKey,
            keyExistente: existing.order_key,
            sheetDateAnterior: existing.sheet_date,
            sheetDateNovo: sheetDate,
            motivo: 'ship_by_date mudou; sem este fallback viraria linha duplicada',
          },
        })
      }
    }

    const row = itemRows[i]
    row[SHOPEE_COL_RECIPIENT] = recipient
    row[SHOPEE_COL_SHOPEE_STATUS] = shopeeStatus
    // Só a foto de fato do item comprado — nunca "adivinhar" de outro item da mesma
    // ordem. Com a quantidade explodida, várias unidades apontam pro MESMO item, então
    // o índice vem do mapeamento, não da posição da linha.
    const productImageUrl = itemImageUrl(order.item_list?.[unidades[i].itemIndex])

    if (existing) {
      const prev = JSON.parse(existing.row_json) as string[]
      while (prev.length < SHOPEE_ROW_COLS) prev.push('')
      row[SHOPEE_COL_INTERNAL_STATUS] = prev[SHOPEE_COL_INTERNAL_STATUS]
      row[SHOPEE_COL_ORDER_ID] = prev[SHOPEE_COL_ORDER_ID] || row[SHOPEE_COL_ORDER_ID]
      row[SHOPEE_COL_PRODUCT] = prev[SHOPEE_COL_PRODUCT]
      row[SHOPEE_COL_MODEL] = prev[SHOPEE_COL_MODEL]
      row[SHOPEE_COL_QTY] = prev[SHOPEE_COL_QTY]
      row[SHOPEE_COL_USERNAME] = prev[SHOPEE_COL_USERNAME]
      // Desde 2026-07-24 a Shopee às vezes manda o nome do destinatário mascarado
      // ("H******a", "****") em vez do nome completo. G é a única coluna de texto que
      // o resync sempre atualiza (ver docstring de upsertShopeeOrder) — sem esta guarda,
      // um poll normal substituía o nome de verdade já salvo pelo mascarado. Só troca o
      // valor salvo se o novo vier melhor (não vazio, sem asterisco) que o antigo.
      if (isMaskedOrEmptyRecipient(row[SHOPEE_COL_RECIPIENT]) && !isMaskedOrEmptyRecipient(prev[SHOPEE_COL_RECIPIENT])) {
        row[SHOPEE_COL_RECIPIENT] = prev[SHOPEE_COL_RECIPIENT]
      }
      applyInternalStatusFromShopee(row, shopeeStatus)
      const rowJson = JSON.stringify(row)
      const nextImageUrl = productImageUrl || existing.product_image_url
      if (rowJson !== existing.row_json || sheetDate !== existing.sheet_date
          || nextImageUrl !== existing.product_image_url) {
        updateStmt.run(rowJson, sheetDate, nextImageUrl, now, workbookId, existing.order_key)
        anyChanged = true
        recordAudit({
          ...auditBase,
          event: 'order.atualizada',
          orderKey: existing.order_key,
          detail: {
            rotina: ctx.rotina,
            occurrence,
            shopeeStatus,
            sheetDate: sheetDate !== existing.sheet_date
              ? { de: existing.sheet_date, para: sheetDate }
              : sheetDate,
            rowAntes: JSON.parse(existing.row_json),
            rowDepois: row,
          },
        })
      }
    } else {
      applyInternalStatusFromShopee(row, shopeeStatus)
      anyCreated = true
      anyChanged = true
      const position = posicaoParaNovaLinha(orderSn, workbookId)
      // 1ª unidade = linha do pedido (a contável); as demais penduram nela como filhas.
      const parentKey = occurrence === 1 ? null : keyDoPai
      insertStmt.run(
        workbookId,
        orderKey,
        orderSn,
        JSON.stringify(row),
        '{}',
        0,
        sheetDate,
        productImageUrl,
        position,
        now,
        parentKey,
      )
      const irmas = findOrdersBySn(orderSn, workbookId).length
      recordAudit({
        ...auditBase,
        event: 'order.criada',
        // Linha nova num pedido que já tinha mais linhas do que itens tem cheiro de
        // duplicata — deixa em warn pro relatório destacar sem precisar de query.
        level: irmas > itemRows.length ? 'warn' : 'info',
        orderKey,
        detail: {
          rotina: ctx.rotina,
          occurrence,
          itensNoPedido: itemRows.length,
          linhasDepoisDoInsert: irmas,
          position,
          sheetDate,
          shopeeStatus,
          row,
        },
      })
    }
  }

  // As duas conferências abaixo só rodam quando ESTA chamada mexeu em alguma linha. Pedido
  // antigo que o resync visita e acha idêntico fica intocado de propósito (decisão do user
  // 2026-07-28: corrigir daqui pra frente, não remexer no que já está publicado). Pra auditar
  // o passado sem escrever nada, use GET /api/audit/duplicatas.
  if (anyChanged) {
    // O detalhe da Shopee é a verdade sobre quantas linhas o pedido deve ter: 1 por item do
    // carrinho (produtos ou variantes diferentes = itens diferentes; mesmo item repetido só
    // aumenta a quantidade). Sobra = resíduo de import antigo ou item removido do pedido.
    // Nunca apaga sozinho — a linha pode já ter foto e arte do cliente.
    const linhasNoBanco = findOrdersBySn(orderSn, workbookId)
    if (linhasNoBanco.length > itemRows.length) {
      recordAudit({
        ...auditBase,
        event: 'order.linhas_sobrando',
        level: 'error',
        detail: {
          rotina: ctx.rotina,
          itensNoPedido: itemRows.length,
          linhasNoBanco: linhasNoBanco.length,
          keys: linhasNoBanco.map((l) => l.order_key),
          acao: 'conferir em /api/audit/duplicatas e decidir manualmente',
        },
      })
    }
  }

  if (anyCreated) {
    const movidas = reagruparLinhasDoPedido(orderSn, workbookId)
    if (movidas > 0) {
      recordAudit({
        ...auditBase,
        event: 'order.linhas_reagrupadas',
        level: 'warn',
        detail: { rotina: ctx.rotina, linhasMovidas: movidas, motivo: 'linha nova deixaria outro pedido no meio' },
      })
    }
  }

  if (anyChanged) {
    db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  }
  return anyCreated ? 'created' : anyChanged ? 'updated' : 'unchanged'
}

/** Atualiza Status Shopee (col H) em todas as linhas do pedido — push code 3. */
export function updateShopeeOrderStatus(
  orderSn: string,
  shopeeStatus: string,
  workbookId: string = SHOPEE_WORKBOOK_ID,
): 'updated' | 'missing' {
  const rows = findOrdersBySn(orderSn.trim(), workbookId)
  if (rows.length === 0) return 'missing'
  const now = nowMs()
  const updateStmt = db.prepare(
    'UPDATE orders SET row_json = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?',
  )
  for (const existing of rows) {
    const row = JSON.parse(existing.row_json) as string[]
    while (row.length < SHOPEE_ROW_COLS) row.push('')
    row[SHOPEE_COL_SHOPEE_STATUS] = shopeeStatus
    applyInternalStatusFromShopee(row, shopeeStatus)
    updateStmt.run(JSON.stringify(row), now, workbookId, existing.order_key)
  }
  db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  return 'updated'
}

async function collectOrderSnsPage(
  timeFrom: number,
  timeTo: number,
  orderStatus: string | undefined,
  timeRangeField: 'create_time' | 'update_time' = 'create_time',
): Promise<string[]> {
  const sns: string[] = []
  let cursor = ''
  let more = true
  while (more) {
    const page = await fetchOrderListPage({
      timeFrom,
      timeTo,
      orderStatus,
      pageSize: 100,
      cursor: cursor || undefined,
      timeRangeField,
    })
    sns.push(...page.orderSnList)
    more = page.more
    cursor = page.nextCursor
    if (more && !cursor) break
  }
  return sns
}

/** Lista pedidos de todos os status na janela (poll e import manual) — order_status omitido = sem filtro. */
async function collectOrderSns(
  timeFrom: number,
  timeTo: number,
  errors?: string[],
  timeRangeField: 'create_time' | 'update_time' = 'create_time',
): Promise<string[]> {
  try {
    return collectOrderSnsPage(timeFrom, timeTo, undefined, timeRangeField)
  } catch (error) {
    const msg = `get_order_list: ${error instanceof Error ? error.message : String(error)}`
    console.warn('[shopee-sync] get_order_list falhou —', msg)
    errors?.push(msg)
    return []
  }
}

/** Janela de busca — 20h com poll a cada 2h garante sobreposição ampla se uma execução falhar. */
export const SHOPEE_POLL_LOOKBACK_HOURS = 20

/** Busca detalhe em lotes de 50 e faz upsert — usado por todas as rotinas de sync abaixo. */
async function upsertOrderSnsBatched(
  orderSns: string[],
  preErrors: string[] = [],
  workbookId: string = SHOPEE_WORKBOOK_ID,
  ctx: SyncContext = {},
): Promise<ShopeeSyncResult> {
  const result: ShopeeSyncResult = { listed: orderSns.length, created: 0, updated: 0, errors: [...preErrors] }

  for (const erro of preErrors) {
    recordAudit({
      source: ctx.source ?? 'poll',
      runId: ctx.runId ?? null,
      workbookId,
      event: 'sync.erro_listagem',
      level: 'error',
      detail: { rotina: ctx.rotina, erro },
    })
  }

  for (let i = 0; i < orderSns.length; i += 50) {
    const batch = orderSns.slice(i, i + 50)
    try {
      const data = await getOrderDetail(batch)
      const orders = parseOrderList(data)
      for (const order of orders) {
        try {
          const action = upsertShopeeOrder(order, workbookId, ctx)
          if (action === 'created') result.created++
          else if (action === 'updated') result.updated++
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error)
          result.errors.push(`${order.order_sn ?? '?'}: ${msg}`)
          recordAudit({
            source: ctx.source ?? 'poll',
            runId: ctx.runId ?? null,
            workbookId,
            orderSn: order.order_sn ?? null,
            event: 'sync.erro_pedido',
            level: 'error',
            detail: { rotina: ctx.rotina, erro: msg },
          })
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      result.errors.push(`batch ${Math.floor(i / 50) + 1}: ${msg}`)
      recordAudit({
        source: ctx.source ?? 'poll',
        runId: ctx.runId ?? null,
        workbookId,
        event: 'sync.erro_lote',
        level: 'error',
        detail: { rotina: ctx.rotina, lote: Math.floor(i / 50) + 1, pedidos: batch, erro: msg },
      })
    }
  }

  return result
}

/** Importa pedidos recentes via API — todos os status (push desativado; poll é a única via). */
export async function syncRecentShopeeOrders(options: {
  hours?: number
  ctx?: SyncContext
} = {}): Promise<ShopeeSyncResult> {
  ensureShopeeWorkbook()
  const hours = Math.min(Math.max(options.hours ?? SHOPEE_POLL_LOOKBACK_HOURS, 1), 168)
  const timeTo = Math.floor(Date.now() / 1000)
  const timeFrom = timeTo - hours * 3600

  const errors: string[] = []
  const orderSns = await collectOrderSns(timeFrom, timeTo, errors)
  return upsertOrderSnsBatched(orderSns, errors, SHOPEE_WORKBOOK_ID, {
    rotina: 'syncRecentShopeeOrders',
    ...options.ctx,
  })
}

/**
 * Reconsulta por `update_time` em vez de `create_time` — cobre pedido ANTIGO que só mudou de
 * status (ex.: pago dias depois de criado) dentro da janela. `syncRecentShopeeOrders` (create_time)
 * só pega pedido CRIADO na janela; um pedido criado há 9 dias e pago hoje nunca aparecia em
 * nenhum resync (não é "recente" pra criação, não é "Sem data", e resyncReadyToShipDates só
 * pega quem JÁ está READY_TO_SHIP no nosso banco — UNPAID ficava órfão pra sempre). Ver memória
 * `bug-shopee-unpaid-nunca-resincroniza-2026-07-15`.
 */
export async function syncRecentlyUpdatedShopeeOrders(options: {
  hours?: number
  ctx?: SyncContext
} = {}): Promise<ShopeeSyncResult> {
  ensureShopeeWorkbook()
  const hours = Math.min(Math.max(options.hours ?? SHOPEE_POLL_LOOKBACK_HOURS, 1), 168)
  const timeTo = Math.floor(Date.now() / 1000)
  const timeFrom = timeTo - hours * 3600

  const errors: string[] = []
  const orderSns = await collectOrderSns(timeFrom, timeTo, errors, 'update_time')
  return upsertOrderSnsBatched(orderSns, errors, SHOPEE_WORKBOOK_ID, {
    rotina: 'syncRecentlyUpdatedShopeeOrders',
    ...options.ctx,
  })
}

function findOrderSnsPendingDate(workbookId: string = SHOPEE_WORKBOOK_ID): string[] {
  const rows = db
    .prepare('SELECT DISTINCT id FROM orders WHERE workbook_id = ? AND sheet_date IN (?, ?)')
    .all(workbookId, SHOPEE_PENDING_DATE_LABEL, '') as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/**
 * Reconsulta pedidos presos na aba "Sem data de envio" (ship_by_date ainda não calculado
 * pela Shopee) — roda junto do poll de 2h, sem depender de janela de tempo, já que um pedido
 * pode ficar dias parado antes do prazo de envio aparecer. Também cobre `sheet_date=''`
 * (pedidos que caíram antes do fix, sem o rótulo novo) — autocorrige sozinho. Nunca resolve com
 * data provisória (create_time) — `resolveSheetDate` não tem mais esse fallback; o pedido só
 * sai daqui quando a Shopee realmente calcular o ship_by_date, mesmo que demore várias rodadas
 * de 2h em 2h (decisão do usuário 2026-07-15).
 */
export async function resyncPendingDateOrders(
  workbookId: string = SHOPEE_WORKBOOK_ID,
  ctx: SyncContext = {},
): Promise<ShopeeSyncResult> {
  ensureShopeeWorkbook()
  return upsertOrderSnsBatched(findOrderSnsPendingDate(workbookId), [], workbookId, {
    rotina: 'resyncPendingDateOrders',
    ...ctx,
  })
}

function findOrderSnsByShopeeStatus(
  statuses: string[],
  workbookId: string = SHOPEE_WORKBOOK_ID,
): string[] {
  const wanted = new Set(statuses)
  const rows = db
    .prepare('SELECT id, row_json FROM orders WHERE workbook_id = ?')
    .all(workbookId) as Array<{ id: string; row_json: string }>
  const orderSns = new Set<string>()
  for (const row of rows) {
    let cells: string[]
    try {
      cells = JSON.parse(row.row_json) as string[]
    } catch {
      continue
    }
    if (wanted.has(cells[SHOPEE_COL_SHOPEE_STATUS])) orderSns.add(row.id)
  }
  return [...orderSns]
}

/**
 * Reconfere a data de TODO pedido hoje em READY_TO_SHIP, mesmo os que já têm data — corrige
 * pedidos que vieram com data errada antes do fix do `resolveSheetDate`, e cobre o caso da
 * Shopee às vezes empurrar o ship_by_date +1 dia depois (bug do lado deles) já visto na prática.
 */
export async function resyncReadyToShipDates(
  workbookId: string = SHOPEE_WORKBOOK_ID,
  ctx: SyncContext = {},
): Promise<ShopeeSyncResult> {
  ensureShopeeWorkbook()
  return upsertOrderSnsBatched(findOrderSnsByShopeeStatus(['READY_TO_SHIP'], workbookId), [], workbookId, {
    rotina: 'resyncReadyToShipDates',
    ...ctx,
  })
}

/**
 * Reconfere TODO pedido armazenado como PROCESSED, sem depender de janela de tempo (create_time
 * OU update_time podem estar velhos demais — pedido pode ficar dias em PROCESSED antes de virar
 * SHIPPED/COMPLETED, e nenhum resync por tempo cobria isso). Achado 2026-07-15: 22 pedidos
 * "PROCESSED" no banco, mas só 1 realmente PROCESSED na Shopee — o resto já tinha avançado
 * (COMPLETED etc) sem a gente saber. Ver memória `bug-shopee-processed-nunca-resincroniza-2026-07-15`.
 */
export async function resyncProcessedOrders(
  workbookId: string = SHOPEE_WORKBOOK_ID,
  ctx: SyncContext = {},
): Promise<ShopeeSyncResult> {
  ensureShopeeWorkbook()
  return upsertOrderSnsBatched(findOrderSnsByShopeeStatus(['PROCESSED'], workbookId), [], workbookId, {
    rotina: 'resyncProcessedOrders',
    ...ctx,
  })
}

function findAllOrderSns(workbookId: string = SHOPEE_WORKBOOK_ID): string[] {
  const rows = db
    .prepare('SELECT DISTINCT id FROM orders WHERE workbook_id = ?')
    .all(workbookId) as Array<{ id: string }>
  return rows.map((r) => r.id)
}

/**
 * Reconfere TODO pedido que já está no workbook, um por um, contra o detalhe real na Shopee —
 * conferência manual completa (2026-07-15). Diferente de `syncShopeeWorkbookOrders`: NUNCA lista
 * pedido novo via get_order_list (isso importou ~3200 pedidos históricos nunca rastreados sem
 * querer, teve que reverter) — só busca o order_sn de quem JÁ está no nosso banco, então é
 * impossível esse resync criar pedido novo, só atualizar os existentes.
 */
export async function resyncAllKnownOrders(
  workbookId: string = SHOPEE_WORKBOOK_ID,
  ctx: SyncContext = {},
): Promise<ShopeeSyncResult> {
  ensureShopeeWorkbook()
  return upsertOrderSnsBatched(findAllOrderSns(workbookId), [], workbookId, {
    rotina: 'resyncAllKnownOrders',
    source: 'manual',
    ...ctx,
  })
}

async function collectAllOrderSns(timeFrom: number, timeTo: number, errors?: string[]): Promise<string[]> {
  return collectOrderSns(timeFrom, timeTo, errors)
}

export async function syncShopeeWorkbookOrders(options: {
  days?: number
  /** Dias atrás em que termina a janela (0 = agora). Com days=1 e offsetDays=1 → ontem. */
  offsetDays?: number
} = {}): Promise<ShopeeSyncResult> {
  ensureShopeeWorkbook()
  const days = Math.min(Math.max(options.days ?? 90, 1), 365)
  const offsetDays = Math.max(options.offsetDays ?? 0, 0)
  const timeTo = Math.floor(Date.now() / 1000) - offsetDays * 86400
  const timeFrom = timeTo - days * 86400

  const errors: string[] = []
  const orderSns = await collectAllOrderSns(timeFrom, timeTo, errors)
  return upsertOrderSnsBatched(orderSns, errors, SHOPEE_WORKBOOK_ID, {
    rotina: 'syncShopeeWorkbookOrders',
    source: 'manual',
  })
}
