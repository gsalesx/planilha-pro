/**
 * Montagem automática da IA — deixa as artes de um dia MONTADAS como rascunho:
 * peças derivadas, fotos escolhidas do chat, formato, enquadramento, fundo removido,
 * emojis e cor. NÃO gera prévia, NÃO muda status, NÃO manda nada ao cliente — o dono
 * revisa e clica em "Gerar prévia".
 *
 * Só toca pedido em que ninguém trabalhou: sem nenhuma foto (nem pendente) em
 * nenhuma peça, status sem prévia/aprovação e canal não cancelado.
 *
 * Quem decide:
 *  - SCRFD (thread de análise) acha os rostos de cada imagem que o cliente mandou;
 *  - LFM3-VL-2B (container liquid-ia, só rede interna) lê a conversa e diz qual
 *    imagem vai em qual peça, o formato de cada foto, emojis e cor;
 *  - o enquadramento sai das medianas do relatório de ajustes (onde o operador
 *    costuma deixar o grupo de rostos em cada formato), aplicadas aos rostos achados.
 * Tudo que a IA decidiu fica em `ia_montagens` — base pra comparar com o que o
 * operador mudar depois.
 */
import crypto from 'node:crypto'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

import sharp from 'sharp'

import { analisarFoto } from './analise-foto.js'
import { recordAudit } from './audit.js'
import { db, nowMs } from './db.js'
import { listCatalog, resolveByAlias, searchByName } from './emoji-catalog.js'
import {
  MP_COL_INTERNAL_STATUS,
  MP_COL_MARKETPLACE_STATUS,
  MP_COL_MODEL,
  MP_COL_PRODUCT,
  MP_COL_USERNAME,
} from './marketplace-columns.js'
import { SHOPEE_WORKBOOK_ID } from './marketplace.js'
import { recortarRosto, removerFundo } from './picwish.js'
import { ensurePieces, updatePiece, type PieceWithPhotos } from './pieces.js'
import { caminhoNovo, comporFoto, foto, type FonteRecorte, type Modo } from './routes/picker.js'
import { fetchShopeeCdn } from './routes/pieces.js'
import { fetchAllChatMessages, type ParsedChatMessage } from './shopee-api.js'
import { getBuyerChatByUsername } from './shopee-link-conversations.js'

db.exec(`
  CREATE TABLE IF NOT EXISTS ia_montagens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workbook_id TEXT NOT NULL,
    order_key TEXT NOT NULL,
    order_id TEXT NOT NULL,
    sheet_date TEXT NOT NULL,
    criado_em INTEGER NOT NULL,
    resultado TEXT NOT NULL,
    motivo TEXT NOT NULL DEFAULT '',
    decisao_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_ia_montagens_data ON ia_montagens (sheet_date);
`)

const LFM_URL = (process.env.LFM_URL || 'http://liquid-lfm:8080').replace(/\/$/, '')
const CANVAS = 900
const STATUS_INTOCAVEIS = new Set(['Prévia', 'Aprovado', 'Pronto', 'Cancelado', 'Editar', 'Em produção 1', 'Em produção 2', 'Em produção 3', 'Separado', 'Manual'])
const CANAL_CANCELADO = new Set(['CANCELLED', 'IN_CANCEL', 'TO_RETURN'])
const MAX_IMAGENS = 8

type Formato = 'coracao' | 'recorte' | 'rosto'

interface Rosto {
  x: number
  y: number
  w: number
  h: number
  score: number
}

interface Imagem {
  n: number
  url: string
  bytes: Buffer
  largura: number
  altura: number
  giro: number
  rostos: Rosto[]
  hash: string
}

interface Alvo {
  cx: number
  cy: number
  gw: number
  uWidth: number
  amostras: number
}

export interface ResultadoMontagem {
  data: string
  pedidos: number
  montados: number
  pulados: Array<{ pedido: string; motivo: string }>
  erros: Array<{ pedido: string; erro: string }>
  duracaoMs: number
}

/* ------------------------------------------------------------------ *
 * Geometria — mesma convenção do render-foto (gira, escala pela largura,
 * desloca do centro do quadro 900×900; rotação positiva = horário).
 * ------------------------------------------------------------------ */

function girarPonto(giro: number, x: number, y: number, W: number, H: number): [number, number] {
  if (giro === 90) return [H - y, x]
  if (giro === 180) return [W - x, H - y]
  if (giro === 270) return [y, W - x]
  return [x, y]
}

/** Rostos que importam (descarta gente pequena no fundo) já no referencial girado. */
function grupoDeRostos(
  rostos: Rosto[],
  giro: number,
  W: number,
  H: number,
): { x0: number; y0: number; x1: number; y1: number; n: number } | null {
  const bons = rostos.filter((r) => r.score >= 0.6)
  if (bons.length === 0) return null
  const maior = Math.max(...bons.map((r) => r.w))
  const ficam = bons.filter((r) => r.w >= maior * 0.35)
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of ficam) {
    for (const [px, py] of [
      girarPonto(giro, r.x, r.y, W, H),
      girarPonto(giro, r.x + r.w, r.y + r.h, W, H),
    ]) {
      x0 = Math.min(x0, px)
      y0 = Math.min(y0, py)
      x1 = Math.max(x1, px)
      y1 = Math.max(y1, py)
    }
  }
  return { x0, y0, x1, y1, n: ficam.length }
}

function mediana(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  return s.length ? s[Math.floor(s.length / 2)] : NaN
}

const ALVO_PADRAO: Record<'coracao' | 'rosto', Record<number, Omit<Alvo, 'amostras'>>> = {
  coracao: { 1: { cx: 450, cy: 380, gw: 300, uWidth: 600 }, 2: { cx: 450, cy: 380, gw: 520, uWidth: 600 }, 3: { cx: 450, cy: 390, gw: 640, uWidth: 600 } },
  rosto: { 1: { cx: 450, cy: 260, gw: 260, uWidth: 600 }, 2: { cx: 450, cy: 280, gw: 480, uWidth: 800 }, 3: { cx: 450, cy: 300, gw: 620, uWidth: 1000 } },
}

/**
 * Onde o operador costuma deixar o grupo de rostos (centro e largura no quadro) e a
 * largura da cápsula, por formato e nº de rostos — medianas do relatório de ajustes.
 */
function alvosDoRelatorio(): Record<'coracao' | 'rosto', Record<number, Alvo>> {
  const coleta: Record<string, { cx: number[]; cy: number[]; gw: number[]; u: number[] }> = {}
  let rows: Array<{ dados_json: string }> = []
  try {
    rows = db.prepare("SELECT dados_json FROM relatorio_ajustes WHERE modo IN ('coracao', 'rosto')").all() as typeof rows
  } catch {
    rows = []
  }
  for (const { dados_json } of rows) {
    let d: any
    try {
      d = JSON.parse(dados_json)
    } catch {
      continue
    }
    const a = d?.ajuste
    if (!a?.ajustado) continue
    const modo = a.modo as 'coracao' | 'rosto'
    const rot = Number(a.rotation ?? 0)
    if (rot % 90 !== 0) continue
    const giroAj = ((rot % 360) + 360) % 360
    const usaFonte = d?.fonte?.tipo && d.fonte.tipo !== 'original' && d.fonte.deteccao?.scrfd
    const W = usaFonte ? d.fonte.largura : d?.foto?.largura
    const H = usaFonte ? d.fonte.altura : d?.foto?.altura
    const det = usaFonte ? d.fonte.deteccao.scrfd : d?.deteccao?.scrfd
    if (!W || !H || !det?.rostos?.length) continue
    const g = grupoDeRostos(det.rostos as Rosto[], giroAj, W, H)
    if (!g) continue
    const [Wr, Hr] = giroAj === 90 || giroAj === 270 ? [H, W] : [W, H]
    const s = a.width ? a.width / Wr : a.height ? a.height / Hr : 1
    const k = `${modo}:${Math.min(g.n, 3)}`
    coleta[k] ??= { cx: [], cy: [], gw: [], u: [] }
    coleta[k].cx.push(CANVAS / 2 + Number(a.dx ?? 0) + ((g.x0 + g.x1) / 2 - Wr / 2) * s)
    coleta[k].cy.push(CANVAS / 2 + Number(a.dy ?? 0) + ((g.y0 + g.y1) / 2 - Hr / 2) * s)
    coleta[k].gw.push((g.x1 - g.x0) * s)
    if (a.u_width) coleta[k].u.push(Number(a.u_width))
  }
  const out = { coracao: {}, rosto: {} } as Record<'coracao' | 'rosto', Record<number, Alvo>>
  for (const modo of ['coracao', 'rosto'] as const) {
    for (const n of [1, 2, 3]) {
      const c = coleta[`${modo}:${n}`]
      const p = ALVO_PADRAO[modo][n]
      out[modo][n] =
        c && c.cx.length >= 8
          ? { cx: mediana(c.cx), cy: mediana(c.cy), gw: mediana(c.gw), uWidth: c.u.length ? mediana(c.u) : p.uWidth, amostras: c.cx.length }
          : { ...p, amostras: c?.cx.length ?? 0 }
    }
  }
  return out
}

interface Ajuste {
  width?: number
  dx?: number
  dy?: number
  rotation?: number
}

function enquadrar(
  formato: Formato,
  W: number,
  H: number,
  giro: number,
  rostos: Rosto[],
  alvos: Record<'coracao' | 'rosto', Record<number, Alvo>>,
): { ajuste: Ajuste; uWidth: number } {
  if (formato === 'rosto') return { ajuste: giro ? { rotation: giro } : {}, uWidth: 600 }
  const chave = formato === 'coracao' ? 'coracao' : 'rosto'
  const [Wr, Hr] = giro === 90 || giro === 270 ? [H, W] : [W, H]
  const g = grupoDeRostos(rostos, giro, W, H)
  const alvo = alvos[chave][Math.min(g?.n ?? 1, 3)]
  let s: number
  let dx = 0
  let dy = 0
  if (!g) {
    s = formato === 'coracao' ? CANVAS / Wr : (U_ALTURA / Hr)
  } else {
    s = alvo.gw / Math.max(1, g.x1 - g.x0)
  }
  if (formato === 'coracao') s = Math.max(s, CANVAS / Wr) // sem vão dos lados no coração
  s = Math.min(Math.max(s, 0.05), 12)
  if (g) {
    dx = alvo.cx - CANVAS / 2 - ((g.x0 + g.x1) / 2 - Wr / 2) * s
    dy = alvo.cy - CANVAS / 2 - ((g.y0 + g.y1) / 2 - Hr / 2) * s
  }
  const sw = Wr * s
  const sh = Hr * s
  if (formato === 'coracao') {
    const folgaX = Math.max(0, (sw - CANVAS) / 2)
    const folgaY = Math.max(0, (sh - CANVAS) / 2)
    dx = Math.min(folgaX, Math.max(-folgaX, dx))
    dy = Math.min(folgaY, Math.max(-folgaY, dy))
  }
  const ajuste: Ajuste = { width: Math.round(sw), dx: Math.round(dx * 10) / 10, dy: Math.round(dy * 10) / 10 }
  if (giro) ajuste.rotation = giro
  return { ajuste, uWidth: Math.round(Math.min(1000, Math.max(300, alvo.uWidth))) }
}
const U_ALTURA = 828

/* ------------------------------------------------------------------ *
 * LFM (Liquid) — lê a conversa e devolve o pedido em JSON.
 * ------------------------------------------------------------------ */

async function lfmPronto(esperaMs: number): Promise<boolean> {
  const fim = Date.now() + esperaMs
  while (Date.now() < fim) {
    try {
      const r = await fetch(`${LFM_URL}/health`, { signal: AbortSignal.timeout(5000) })
      if (r.ok) return true
    } catch {
      // ainda subindo / baixando o modelo
    }
    await new Promise((r) => setTimeout(r, 15_000))
  }
  return false
}

interface PedidoLfm {
  pecas: Array<{ peca: number; fotos: Array<{ imagem: number; formato: Formato }> }>
  emojis: string[]
  cor: string | null
  observacao: string
}

function textoDaConversa(msgs: ParsedChatMessage[], numeroDaImagem: Map<string, number>, imagens: Imagem[]): string {
  const linhas: string[] = []
  for (const m of msgs) {
    const quem = m.fromBuyer ? 'Cliente' : 'Loja'
    const n = m.imageUrl ? numeroDaImagem.get(m.id) : undefined
    if (n) {
      const img = imagens.find((i) => i.n === n)!
      linhas.push(`${quem}: [IMAGEM ${n} — ${img.rostos.length} rosto(s)]`)
    } else if (m.text?.trim()) {
      linhas.push(`${quem}: ${m.text.trim().replace(/\s+/g, ' ').slice(0, 300)}`)
    }
  }
  return linhas.slice(-40).join('\n')
}

async function perguntarLfm(
  produto: string,
  modelo: string,
  pecas: PieceWithPhotos[],
  conversa: string,
  imagens: Imagem[],
  nomesEmoji: string[],
): Promise<{ pedido: PedidoLfm | null; bruto: string }> {
  const prompt =
    `Você monta artes de pijama personalizado com fotos do cliente.\n` +
    `Produto: ${produto}\nVariação: ${modelo}\n` +
    `Peças do pedido:\n${pecas.map((p, i) => `- Peça ${i + 1}: ${p.molde}`).join('\n')}\n\n` +
    `Formatos possíveis de cada foto:\n` +
    `- "coracao": a foto vai dentro de um coração\n` +
    `- "recorte": a pessoa recortada sem fundo, numa cápsula (o mais comum)\n` +
    `- "rosto": só o rosto recortado\n` +
    `Cada peça leva no máximo 2 fotos. Imagens disponíveis: ${imagens.map((i) => `${i.n} (${i.rostos.length} rosto(s))`).join(', ')}.\n` +
    `Imagem sem rosto quase nunca é foto pra estampa (print de tela, produto, comprovante).\n` +
    `Emojis do catálogo (use exatamente estes nomes): ${nomesEmoji.join(', ')}.\n\n` +
    `Conversa (mais antiga primeiro):\n${conversa}\n\n` +
    `Responda SÓ com JSON neste formato:\n` +
    `{"pecas":[{"peca":1,"fotos":[{"imagem":1,"formato":"recorte"}]}],"emojis":["CORAÇÃO"],"cor":"#000000 ou null","observacao":"pedido especial do cliente, se houver"}`

  const corpo = {
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 500,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    chat_template_kwargs: { enable_thinking: false },
  }
  const r = await fetch(`${LFM_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
    signal: AbortSignal.timeout(180_000),
  })
  if (!r.ok) throw new Error(`LFM HTTP ${r.status}`)
  const j = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const bruto = j.choices?.[0]?.message?.content ?? ''
  const m = bruto.match(/\{[\s\S]*\}/)
  if (!m) return { pedido: null, bruto }
  try {
    const p = JSON.parse(m[0]) as Partial<PedidoLfm>
    const formatos = new Set(['coracao', 'recorte', 'rosto'])
    const nums = new Set(imagens.map((i) => i.n))
    const pedido: PedidoLfm = {
      pecas: (Array.isArray(p.pecas) ? p.pecas : [])
        .map((x) => ({
          peca: Number(x?.peca),
          fotos: (Array.isArray(x?.fotos) ? x.fotos : [])
            .filter((f) => nums.has(Number(f?.imagem)))
            .slice(0, 2)
            .map((f) => ({ imagem: Number(f.imagem), formato: (formatos.has(f.formato) ? f.formato : 'recorte') as Formato })),
        }))
        .filter((x) => x.peca >= 1 && x.peca <= pecas.length),
      emojis: Array.isArray(p.emojis) ? p.emojis.filter((e) => typeof e === 'string').slice(0, 2) : [],
      cor: typeof p.cor === 'string' && /^#[0-9a-fA-F]{6}$/.test(p.cor) ? p.cor.toLowerCase() : null,
      observacao: typeof p.observacao === 'string' ? p.observacao.slice(0, 300) : '',
    }
    return { pedido, bruto }
  } catch {
    return { pedido: null, bruto }
  }
}

/* ------------------------------------------------------------------ *
 * Pedido a pedido
 * ------------------------------------------------------------------ */

interface LinhaPedido {
  order_key: string
  id: string
  row_json: string
}

function chavesDoPedido(orderKey: string): string[] {
  const filhas = db
    .prepare('SELECT order_key FROM orders WHERE workbook_id = ? AND parent_key = ? ORDER BY position')
    .all(SHOPEE_WORKBOOK_ID, orderKey) as Array<{ order_key: string }>
  return [orderKey, ...filhas.map((f) => f.order_key)]
}

function pecaTemFoto(pieceId: number): boolean {
  return Boolean(
    db.prepare('SELECT 1 FROM piece_images WHERE piece_id = ? LIMIT 1').get(pieceId) ||
      db.prepare('SELECT 1 FROM piece_pending_photos WHERE piece_id = ? LIMIT 1').get(pieceId),
  )
}

/** Data de criação embutida no nº do pedido Shopee (AAMMDD...). */
function criadoEmDoPedido(orderSn: string): number | null {
  const m = orderSn.match(/^(\d{2})(\d{2})(\d{2})/)
  if (!m) return null
  const t = Date.parse(`20${m[1]}-${m[2]}-${m[3]}T00:00:00-03:00`)
  return Number.isFinite(t) ? t : null
}

function formatoParaModo(f: Formato): { modo: Modo; crop: string; fonte: FonteRecorte } {
  if (f === 'coracao') return { modo: 'coracao', crop: 'coracao', fonte: 'original' }
  if (f === 'rosto') return { modo: 'face', crop: 'face', fonte: 'sem_fundo' }
  return { modo: 'recorte', crop: 'rosto', fonte: 'sem_fundo' }
}

const FUNDO_COR_PADRAO = '#ff0000'
const BORDA_COR_PADRAO = '#ffffff'

/** Grava a foto montada no slot — mesmo resultado de escolher + remover fundo + salvar ajuste. */
async function gravarFoto(
  pieceId: number,
  slot: number,
  img: Imagem,
  formato: Formato,
  alvos: Record<'coracao' | 'rosto', Record<number, Alvo>>,
): Promise<Record<string, unknown>> {
  const { modo, crop, fonte } = formatoParaModo(formato)
  const ext = img.bytes[0] === 0x89 ? '.png' : '.jpg'
  const original = caminhoNovo('foto', pieceId, slot, ext)
  writeFileSync(original, img.bytes)

  let semFundo = ''
  let W = img.largura
  let H = img.altura
  let giro = img.giro
  let rostos = img.rostos
  if (fonte === 'sem_fundo') {
    const nome = path.basename(original)
    const png = formato === 'rosto' ? await recortarRosto(img.bytes, nome) : await removerFundo(img.bytes, nome)
    semFundo = caminhoNovo(formato === 'rosto' ? 'facecut' : 'semfundo', pieceId, slot)
    writeFileSync(semFundo, png)
    if (formato === 'recorte') {
      // O enquadramento é aplicado sobre o arquivo sem fundo: mede nele.
      const meta = await sharp(png).metadata()
      const a = await analisarFoto(png, ['scrfd'])
      const det = (a.deteccao as { scrfd?: { giro: number; rostos: Rosto[] } }).scrfd
      W = meta.width ?? W
      H = meta.height ?? H
      if (det?.rostos?.length) {
        rostos = det.rostos
        giro = det.giro
      } else if (W !== img.largura || H !== img.altura) {
        const fx = W / img.largura
        const fy = H / img.altura
        rostos = img.rostos.map((r) => ({ ...r, x: r.x * fx, y: r.y * fy, w: r.w * fx, h: r.h * fy }))
      }
    }
  }

  const { ajuste, uWidth } = enquadrar(formato, W, H, giro, rostos, alvos)
  const agora = nowMs()
  db.prepare(
    `INSERT INTO piece_images (piece_id, slot, file_name, mime, storage_path, crop, origem_url, sem_fundo_path, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(piece_id, slot) DO UPDATE SET
       file_name = excluded.file_name, mime = excluded.mime, storage_path = excluded.storage_path,
       crop = excluded.crop, origem_url = excluded.origem_url, sem_fundo_path = excluded.sem_fundo_path,
       composta_path = '', ajuste_json = '', u_width = NULL, updated_at = excluded.updated_at`,
  ).run(pieceId, slot, path.basename(original), ext === '.png' ? 'image/png' : 'image/jpeg', original, crop, img.url, semFundo, agora)

  const linha = foto(pieceId, slot)!
  const composta = await comporFoto(linha, modo, ajuste, uWidth, false, fonte, FUNDO_COR_PADRAO, BORDA_COR_PADRAO, false)
  const destino = caminhoNovo('composta', pieceId, slot)
  writeFileSync(destino, composta)
  db.prepare(
    'UPDATE piece_images SET ajuste_json = ?, u_width = ?, composta_path = ?, updated_at = ? WHERE piece_id = ? AND slot = ?',
  ).run(
    JSON.stringify({ ...ajuste, fonteRecorte: fonte, fundoCor: FUNDO_COR_PADRAO, bordaCor: BORDA_COR_PADRAO, semBorda: false }),
    uWidth,
    destino,
    nowMs(),
    pieceId,
    slot,
  )
  return { slot, imagem: img.n, formato, ajuste, uWidth, rostos: rostos.length, giro }
}

function registrar(l: LinhaPedido, data: string, resultado: string, motivo: string, decisao: unknown): void {
  db.prepare(
    `INSERT INTO ia_montagens (workbook_id, order_key, order_id, sheet_date, criado_em, resultado, motivo, decisao_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(SHOPEE_WORKBOOK_ID, l.order_key, l.id, data, nowMs(), resultado, motivo, JSON.stringify(decisao ?? {}))
}

async function montarPedido(
  l: LinhaPedido,
  data: string,
  alvos: Record<'coracao' | 'rosto', Record<number, Alvo>>,
  nomesEmoji: string[],
): Promise<{ montado: boolean; motivo: string }> {
  const cells = JSON.parse(l.row_json) as string[]
  const status = (cells[MP_COL_INTERNAL_STATUS] ?? '').trim()
  const canal = (cells[MP_COL_MARKETPLACE_STATUS] ?? '').trim()
  if (STATUS_INTOCAVEIS.has(status)) return { montado: false, motivo: `status ${status}` }
  if (CANAL_CANCELADO.has(canal)) return { montado: false, motivo: `canal ${canal}` }

  const pecas: PieceWithPhotos[] = []
  for (const chave of chavesDoPedido(l.order_key)) pecas.push(...ensurePieces(SHOPEE_WORKBOOK_ID, chave).pieces)
  if (pecas.length === 0) return { montado: false, motivo: 'SKU sem peças reconhecidas' }
  if (pecas.some((p) => pecaTemFoto(p.id))) return { montado: false, motivo: 'já tem foto escolhida' }

  const username = (cells[MP_COL_USERNAME] ?? '').trim()
  const chat = username ? getBuyerChatByUsername(username) : undefined
  if (!chat) return { montado: false, motivo: 'chat do cliente não vinculado' }
  const { messages } = await fetchAllChatMessages(chat.conversationId, chat.toId, { maxPages: 6 })
  const desde = (criadoEmDoPedido(l.id) ?? Date.now() - 10 * 86_400_000) - 3 * 86_400_000
  const janela = messages.filter((m) => (m.createdAt ?? 0) >= desde)

  // Imagens do cliente na janela, sem repetidas (mesmo arquivo reenviado).
  const imagens: Imagem[] = []
  const numeroDaImagem = new Map<string, number>()
  const vistas = new Map<string, number>()
  for (const m of janela.filter((x) => x.fromBuyer && x.imageUrl).slice(-MAX_IMAGENS)) {
    try {
      const url = m.imageUrl!
      const resp = await fetchShopeeCdn(url.includes('@') ? url.slice(0, url.indexOf('@')) : url)
      const bytes = Buffer.from(await resp.arrayBuffer())
      const hash = crypto.createHash('sha256').update(bytes).digest('hex')
      const jaVista = vistas.get(hash)
      if (jaVista) {
        numeroDaImagem.set(m.id, jaVista)
        continue
      }
      const a = await analisarFoto(bytes, ['scrfd'])
      const det = (a.deteccao as { scrfd?: { giro: number; rostos: Rosto[] } }).scrfd
      const n = imagens.length + 1
      imagens.push({
        n,
        url,
        bytes,
        largura: Number(a.medidas.largura) || 0,
        altura: Number(a.medidas.altura) || 0,
        giro: det?.giro ?? 0,
        rostos: det?.rostos ?? [],
        hash,
      })
      vistas.set(hash, n)
      numeroDaImagem.set(m.id, n)
    } catch {
      // imagem que não baixa fica de fora
    }
  }
  const comRosto = imagens.filter((i) => i.rostos.length > 0)
  if (comRosto.length === 0) {
    return { montado: false, motivo: imagens.length ? 'nenhuma imagem do cliente tem rosto' : 'cliente ainda não mandou foto' }
  }

  // LFM lê a conversa; se falhar, regra simples: fotos com rosto em ordem, recorte.
  let pedidoLfm: PedidoLfm | null = null
  let bruto = ''
  try {
    const r = await perguntarLfm(
      cells[MP_COL_PRODUCT] ?? '',
      cells[MP_COL_MODEL] ?? '',
      pecas,
      textoDaConversa(janela, numeroDaImagem, imagens),
      imagens,
      nomesEmoji,
    )
    pedidoLfm = r.pedido
    bruto = r.bruto
  } catch (e) {
    bruto = `erro: ${(e as Error).message}`
  }

  const plano: Array<Array<{ imagem: number; formato: Formato }>> = pecas.map((_, i) => {
    const doLfm = pedidoLfm?.pecas.find((x) => x.peca === i + 1)?.fotos ?? []
    const validas = doLfm.filter((f) => comRosto.some((c) => c.n === f.imagem))
    if (validas.length) return validas
    return comRosto.slice(0, 2).map((c) => ({ imagem: c.n, formato: 'recorte' as Formato }))
  })

  const feitas: unknown[] = []
  for (let i = 0; i < pecas.length; i++) {
    const p = pecas[i]
    if (pecaTemFoto(p.id)) continue // alguém começou a mexer no meio da montagem
    for (let k = 0; k < plano[i].length; k++) {
      const img = imagens.find((x) => x.n === plano[i][k].imagem)!
      feitas.push({ peca: p.id, ...(await gravarFoto(p.id, k + 1, img, plano[i][k].formato, alvos)) })
    }
  }

  // Emojis: unicode que o cliente mandou no texto vale mais que o palpite do LFM.
  const emojis: string[] = []
  for (const m of janela.filter((x) => x.fromBuyer && x.text)) {
    const item = resolveByAlias(m.text)
    if (item && !emojis.includes(item.name)) emojis.push(item.name)
  }
  for (const nome of pedidoLfm?.emojis ?? []) {
    const item = nomesEmoji.includes(nome) ? nome : searchByName(nome)[0]?.name
    if (item && !emojis.includes(item)) emojis.push(item)
  }
  const patch: { emoji1?: string; emoji2?: string; cor?: string } = {}
  if (emojis[0]) {
    patch.emoji1 = emojis[0]
    patch.emoji2 = emojis[1] ?? emojis[0]
  }
  if (pedidoLfm?.cor) patch.cor = pedidoLfm.cor
  if (Object.keys(patch).length) for (const p of pecas) updatePiece(p.id, patch)

  registrar(l, data, 'montado', '', {
    imagens: imagens.map((i) => ({ n: i.n, rostos: i.rostos.length, giro: i.giro, largura: i.largura, altura: i.altura })),
    lfm: pedidoLfm,
    lfmBruto: bruto.slice(0, 2000),
    plano,
    fotos: feitas,
    emojis: patch,
  })
  return { montado: true, motivo: '' }
}

let rodando = false

export async function montarDia(data: string): Promise<ResultadoMontagem> {
  const t0 = Date.now()
  const res: ResultadoMontagem = { data, pedidos: 0, montados: 0, pulados: [], erros: [], duracaoMs: 0 }
  if (rodando) {
    res.erros.push({ pedido: '-', erro: 'montagem já em andamento' })
    return res
  }
  rodando = true
  try {
    if (!(await lfmPronto(40 * 60_000))) console.warn('[montagem-ia] LFM não respondeu — seguindo só com regras')
    const alvos = alvosDoRelatorio()
    console.log('[montagem-ia] alvos de enquadramento', JSON.stringify(alvos))
    const nomesEmoji = listCatalog().map((i) => i.name)
    const linhas = db
      .prepare(
        `SELECT order_key, id, row_json FROM orders
          WHERE workbook_id = ? AND sheet_date = ? AND parent_key IS NULL
          ORDER BY position`,
      )
      .all(SHOPEE_WORKBOOK_ID, data) as LinhaPedido[]
    res.pedidos = linhas.length
    for (const l of linhas) {
      try {
        const r = await montarPedido(l, data, alvos, nomesEmoji)
        if (r.montado) res.montados++
        else {
          res.pulados.push({ pedido: l.id, motivo: r.motivo })
          // Pedido que a equipe já fez não entra no registro — só o que a IA tentou e não conseguiu.
          if (!r.motivo.startsWith('status ') && r.motivo !== 'já tem foto escolhida') registrar(l, data, 'pulado', r.motivo, {})
        }
      } catch (e) {
        const erro = (e as Error).message
        res.erros.push({ pedido: l.id, erro })
        try {
          registrar(l, data, 'erro', erro, {})
        } catch {
          // ignore
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
  } finally {
    rodando = false
    res.duracaoMs = Date.now() - t0
  }
  recordAudit({
    source: 'boot',
    event: 'ia.montagem',
    level: res.erros.length ? 'warn' : 'info',
    detail: { ...res, pulados: res.pulados.slice(0, 200), erros: res.erros.slice(0, 50) },
  })
  console.log('[montagem-ia] fim', { data, pedidos: res.pedidos, montados: res.montados, pulados: res.pulados.length, erros: res.erros.length, ms: res.duracaoMs })
  return res
}

/**
 * Datas pedidas no env `IA_MONTAR_DATAS` (DD-MM-AAAA, separadas por vírgula) que ainda
 * não rodaram — cada data roda uma vez (marcada em `ia_montagens_execucoes`).
 */
export async function montarDatasPendentes(): Promise<void> {
  db.exec(`CREATE TABLE IF NOT EXISTS ia_montagens_execucoes (data TEXT PRIMARY KEY, inicio INTEGER NOT NULL, fim INTEGER, resumo_json TEXT NOT NULL DEFAULT '{}')`)
  const datas = (process.env.IA_MONTAR_DATAS ?? '')
    .split(',')
    .map((d) => d.trim())
    .filter((d) => /^\d{2}-\d{2}-\d{4}$/.test(d))
  for (const data of datas) {
    if (db.prepare('SELECT 1 FROM ia_montagens_execucoes WHERE data = ?').get(data)) continue
    db.prepare('INSERT INTO ia_montagens_execucoes (data, inicio) VALUES (?, ?)').run(data, nowMs())
    const r = await montarDia(data)
    db.prepare('UPDATE ia_montagens_execucoes SET fim = ?, resumo_json = ? WHERE data = ?').run(nowMs(), JSON.stringify(r), data)
  }
}

export function montagensDoDia(data: string): unknown[] {
  return (
    db
      .prepare('SELECT order_id, order_key, criado_em, resultado, motivo, decisao_json FROM ia_montagens WHERE sheet_date = ? ORDER BY id')
      .all(data) as Array<{ decisao_json: string } & Record<string, unknown>>
  ).map(({ decisao_json, ...r }) => {
    let decisao: unknown = {}
    try {
      decisao = JSON.parse(decisao_json)
    } catch {
      // ignore
    }
    return { ...r, decisao }
  })
}

export function execucoesMontagem(): unknown[] {
  try {
    return db.prepare('SELECT data, inicio, fim, resumo_json FROM ia_montagens_execucoes ORDER BY inicio DESC LIMIT 10').all()
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------ *
 * Montagem com escolha externa (1ª vez feita pelo Claude, conferindo
 * cada conversa): as mesmas peças, a mesma gravação e o mesmo registro.
 * Só pedido sem arte feita: sem foto em nenhuma peça e status sem prévia.
 * ------------------------------------------------------------------ */

function linhaDoPedido(orderKey: string): LinhaPedido | undefined {
  return db
    .prepare('SELECT order_key, id, row_json FROM orders WHERE workbook_id = ? AND order_key = ?')
    .get(SHOPEE_WORKBOOK_ID, orderKey) as LinhaPedido | undefined
}

function pedidoIntocavel(cells: string[]): string | null {
  const status = (cells[MP_COL_INTERNAL_STATUS] ?? '').trim()
  const canal = (cells[MP_COL_MARKETPLACE_STATUS] ?? '').trim()
  if (STATUS_INTOCAVEIS.has(status)) return `status ${status}`
  if (CANAL_CANCELADO.has(canal)) return `canal ${canal}`
  return null
}

/** Pedidos do dia que ninguém começou e que a IA pode montar. */
export function pendentesDoDia(data: string): unknown[] {
  const linhas = db
    .prepare(
      `SELECT order_key, id, row_json FROM orders
        WHERE workbook_id = ? AND sheet_date = ? AND parent_key IS NULL ORDER BY position`,
    )
    .all(SHOPEE_WORKBOOK_ID, data) as LinhaPedido[]
  const out: unknown[] = []
  for (const l of linhas) {
    const cells = JSON.parse(l.row_json) as string[]
    if (pedidoIntocavel(cells)) continue
    const chaves = chavesDoPedido(l.order_key)
    const pecas = chaves.flatMap(
      (k) =>
        db.prepare('SELECT id FROM order_pieces WHERE workbook_id = ? AND order_key = ?').all(SHOPEE_WORKBOOK_ID, k) as Array<{ id: number }>,
    )
    if (pecas.some((p) => pecaTemFoto(p.id))) continue
    const username = (cells[MP_COL_USERNAME] ?? '').trim()
    out.push({
      orderKey: l.order_key,
      pedido: l.id,
      cliente: username,
      produto: cells[MP_COL_PRODUCT] ?? '',
      modelo: cells[MP_COL_MODEL] ?? '',
      status: (cells[MP_COL_INTERNAL_STATUS] ?? '').trim(),
      unidades: chaves.length,
      chatVinculado: Boolean(username && getBuyerChatByUsername(username)),
    })
  }
  return out
}

/** Peças (derivadas do SKU, como ao abrir o chat) + conversa recente do cliente. */
export async function conversaDoPedido(orderKey: string): Promise<Record<string, unknown>> {
  const l = linhaDoPedido(orderKey)
  if (!l) throw new Error('pedido não encontrado')
  const cells = JSON.parse(l.row_json) as string[]
  const pecas: PieceWithPhotos[] = []
  for (const chave of chavesDoPedido(orderKey)) pecas.push(...ensurePieces(SHOPEE_WORKBOOK_ID, chave).pieces)
  const username = (cells[MP_COL_USERNAME] ?? '').trim()
  const chat = username ? getBuyerChatByUsername(username) : undefined
  let mensagens: unknown[] = []
  if (chat) {
    const { messages } = await fetchAllChatMessages(chat.conversationId, chat.toId, { maxPages: 6 })
    const desde = (criadoEmDoPedido(l.id) ?? Date.now() - 10 * 86_400_000) - 3 * 86_400_000
    mensagens = messages
      .filter((m) => (m.createdAt ?? 0) >= desde)
      .map((m) => ({ cliente: m.fromBuyer, tipo: m.type, texto: m.text, imagem: m.imageUrl, em: m.createdAt }))
  }
  return {
    orderKey,
    pedido: l.id,
    cliente: username,
    produto: cells[MP_COL_PRODUCT] ?? '',
    modelo: cells[MP_COL_MODEL] ?? '',
    status: cells[MP_COL_INTERNAL_STATUS] ?? '',
    intocavel: pedidoIntocavel(cells),
    pecas: pecas.map((p, i) => ({ n: i + 1, id: p.id, molde: p.molde, emoji1: p.emoji1, emoji2: p.emoji2, cor: p.cor, temFoto: pecaTemFoto(p.id) })),
    chatVinculado: Boolean(chat),
    mensagens,
  }
}

export interface EscolhaPedido {
  pecas: Array<{ fotos: Array<{ url: string; formato: Formato }> }>
  emojis?: string[]
  cor?: string
  autor?: string
}

export async function montarComEscolha(orderKey: string, escolha: EscolhaPedido): Promise<Record<string, unknown>> {
  const l = linhaDoPedido(orderKey)
  if (!l) throw new Error('pedido não encontrado')
  const cells = JSON.parse(l.row_json) as string[]
  const bloqueio = pedidoIntocavel(cells)
  if (bloqueio) throw new Error(`arte já feita ou pedido fora (${bloqueio}) — não mexo`)
  const pecas: PieceWithPhotos[] = []
  for (const chave of chavesDoPedido(orderKey)) pecas.push(...ensurePieces(SHOPEE_WORKBOOK_ID, chave).pieces)
  if (pecas.some((p) => pecaTemFoto(p.id))) throw new Error('pedido já tem foto escolhida — não mexo')
  if (!Array.isArray(escolha?.pecas) || escolha.pecas.length === 0) throw new Error('escolha sem peças')
  const alvos = alvosDoRelatorio()

  const cache = new Map<string, Imagem>()
  async function imagemDe(url: string): Promise<Imagem> {
    const ja = cache.get(url)
    if (ja) return ja
    const limpa = url.includes('@') ? url.slice(0, url.indexOf('@')) : url
    const resp = await fetchShopeeCdn(limpa)
    const bytes = Buffer.from(await resp.arrayBuffer())
    const a = await analisarFoto(bytes, ['scrfd'])
    const det = (a.deteccao as { scrfd?: { giro: number; rostos: Rosto[] } }).scrfd
    const img: Imagem = {
      n: cache.size + 1,
      url: limpa,
      bytes,
      largura: Number(a.medidas.largura) || 0,
      altura: Number(a.medidas.altura) || 0,
      giro: det?.giro ?? 0,
      rostos: det?.rostos ?? [],
      hash: String(a.medidas.hash ?? ''),
    }
    cache.set(url, img)
    return img
  }

  const formatos = new Set(['coracao', 'recorte', 'rosto'])
  const feitas: unknown[] = []
  for (let i = 0; i < pecas.length; i++) {
    // Peça sem escolha própria repete a última (casal com as mesmas fotos).
    const e = escolha.pecas[Math.min(i, escolha.pecas.length - 1)]
    const fotos = (e?.fotos ?? []).slice(0, 2)
    for (let k = 0; k < fotos.length; k++) {
      const f = fotos[k]
      if (!f?.url || !formatos.has(f.formato)) throw new Error(`peça ${i + 1} foto ${k + 1}: url/formato inválido`)
      const img = await imagemDe(f.url)
      feitas.push({ peca: pecas[i].id, ...(await gravarFoto(pecas[i].id, k + 1, img, f.formato, alvos)) })
    }
  }

  const patch: { emoji1?: string; emoji2?: string; cor?: string } = {}
  const nomes = new Set(listCatalog().map((x) => x.name))
  const emojis = (escolha.emojis ?? []).map((n) => (nomes.has(n) ? n : searchByName(n)[0]?.name)).filter(Boolean) as string[]
  if (emojis[0]) {
    patch.emoji1 = emojis[0]
    patch.emoji2 = emojis[1] ?? emojis[0]
  }
  if (escolha.cor && /^#[0-9a-fA-F]{6}$/.test(escolha.cor)) patch.cor = escolha.cor.toLowerCase()
  if (Object.keys(patch).length) for (const p of pecas) updatePiece(p.id, patch)

  const data = db.prepare('SELECT sheet_date FROM orders WHERE workbook_id = ? AND order_key = ?').get(SHOPEE_WORKBOOK_ID, orderKey) as
    | { sheet_date: string }
    | undefined
  registrar(l, data?.sheet_date ?? '', 'montado', '', { autor: escolha.autor ?? 'claude', escolha, fotos: feitas, emojis: patch })
  return { ok: true, fotos: feitas, emojis: patch }
}

/** Miniatura de imagem do chat (CDN da Shopee) pra conferir a escolha. */
export async function miniaturaDoChat(url: string, largura: number): Promise<Buffer> {
  const host = new URL(url).hostname
  if (!/susercontent|shopee/i.test(host)) throw new Error('só imagem do CDN da Shopee')
  const limpa = url.includes('@') ? url.slice(0, url.indexOf('@')) : url
  const resp = await fetchShopeeCdn(limpa)
  const bytes = Buffer.from(await resp.arrayBuffer())
  return sharp(bytes).rotate().resize({ width: largura, height: largura, fit: 'inside' }).jpeg({ quality: 70 }).toBuffer()
}
