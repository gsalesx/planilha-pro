/**
 * Picker web — ajusta a foto (coração / recorte) e gera a arte final.
 *
 * Substitui o picker Tkinter local (`picker_coracao.py` do repo "Criador de
 * artes"). Só o caminho MANUAL: o operador posiciona a foto, e o servidor
 * compõe. Não há detecção de rosto, então nada de OpenCV/ONNX aqui.
 *
 * Modelo de armazenamento (decidido 2026-07-27): guarda-se o INSUMO (foto sem
 * fundo + parâmetros de ajuste + composta 900×900), nunca a arte final —
 * ela pesa ~4MB e é barata de refazer, então é gerada no download e descartada.
 */
import crypto from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { Router } from 'express'
import JSZip from 'jszip'
import multer from 'multer'

import { requireAuth } from '../auth.js'
import { db, nowMs } from '../db.js'
import { env } from '../env.js'
import { removerFundo } from '../picwish.js'
import { fetchShopeeCdn } from './pieces.js'
import {
  CANVAS_POR_MOLDE,
  labelDoMolde,
  renderMolde,
} from '../render-molde.js'
import {
  type ParamsEnquadramento,
  renderCoracao,
  renderRecorte,
} from '../render-foto.js'

const router = Router()
const imagesDir = path.join(env.dataDir, 'images')
mkdirSync(imagesDir, { recursive: true })
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } })

/**
 * Máscara do coração — o editor desenha o preview no próprio navegador (pra
 * arrastar/zoom ficarem instantâneos, sem ida e volta ao servidor), então
 * precisa da mesma máscara que o render usa.
 */
router.get('/picker/mask/heart', requireAuth, (_req, res) => {
  const p = path.join(process.cwd(), 'assets', 'molde', 'heart-mask.png')
  if (!existsSync(p)) {
    res.status(404).json({ error: 'máscara não encontrada' })
    return
  }
  res.setHeader('content-type', 'image/png')
  res.setHeader('cache-control', 'public, max-age=31536000, immutable')
  res.send(readFileSync(p))
})

type Modo = 'coracao' | 'recorte'

interface LinhaFoto {
  piece_id: number
  slot: number
  storage_path: string
  crop: string
  ajuste_json: string
  u_width: number | null
  sem_fundo_path: string
  composta_path: string
}

function foto(pieceId: number, slot: number): LinhaFoto | undefined {
  return db
    .prepare(
      `SELECT piece_id, slot, storage_path, crop, ajuste_json, u_width,
              sem_fundo_path, composta_path
         FROM piece_images WHERE piece_id = ? AND slot = ?`,
    )
    .get(pieceId, slot) as LinhaFoto | undefined
}

/**
 * Garante que a foto exista EM DISCO antes de editar.
 *
 * Foto escolhida no chat entra como PENDENTE (`piece_pending_photos`: só a URL
 * do CDN) e só vira arquivo no "Confirmar pedido". O picker precisa dos bytes,
 * então baixa sob demanda — assim dá pra ajustar antes de confirmar o pedido,
 * que é a ordem natural de trabalho (ajusta e só então confirma).
 */
async function garantirFoto(pieceId: number, slot: number): Promise<LinhaFoto | undefined> {
  const atual = foto(pieceId, slot)
  if (atual && existsSync(atual.storage_path)) return atual

  const pendente = db
    .prepare('SELECT url, crop FROM piece_pending_photos WHERE piece_id = ? AND slot = ?')
    .get(pieceId, slot) as { url: string; crop: string } | undefined
  if (!pendente?.url) return atual // nada pendente: devolve o que houver (ou undefined)

  const resp = await fetchShopeeCdn(pendente.url)
  const bytes = Buffer.from(await resp.arrayBuffer())
  const mime = resp.headers.get('content-type') ?? 'image/jpeg'
  const ext = mime.includes('png') ? '.png' : '.jpg'
  const destino = caminhoNovo('foto', pieceId, slot, ext)
  writeFileSync(destino, bytes)

  db.prepare(
    `INSERT INTO piece_images (piece_id, slot, file_name, mime, storage_path, crop, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(piece_id, slot) DO UPDATE SET
       file_name = excluded.file_name, mime = excluded.mime,
       storage_path = excluded.storage_path, updated_at = excluded.updated_at`,
  ).run(pieceId, slot, path.basename(destino), mime, destino, pendente.crop || 'rosto', nowMs())

  return foto(pieceId, slot)
}

function modoDa(l: LinhaFoto): Modo {
  return l.crop === 'coracao' ? 'coracao' : 'recorte'
}

function parseAjuste(json: string): ParamsEnquadramento {
  if (!json) return {}
  try {
    return JSON.parse(json) as ParamsEnquadramento
  } catch {
    return {}
  }
}

function caminhoNovo(prefixo: string, pieceId: number, slot: number, ext = '.png'): string {
  const nome = `${prefixo}_${pieceId}_s${slot}_${crypto.randomBytes(4).toString('hex')}${ext}`
  return path.join(imagesDir, nome)
}

function trocarArquivo(antigo: string, novo: string, dados: Buffer): void {
  writeFileSync(novo, dados)
  if (antigo && antigo !== novo && existsSync(antigo)) {
    try {
      unlinkSync(antigo)
    } catch {
      // arquivo antigo já sumiu — não impede a troca
    }
  }
}

function parseIds(req: { params: Record<string, string> }): { pieceId: number; slot: number } | null {
  const pieceId = Number(req.params.id)
  const slot = Number(req.params.slot)
  if (!Number.isInteger(pieceId) || (slot !== 1 && slot !== 2)) return null
  return { pieceId, slot }
}

/* ------------------------------------------------------------------ *
 * Foto sem fundo (PicWish) — cacheada, pois a chamada externa é cara.
 * ------------------------------------------------------------------ */
router.post('/pieces/:id/photo/:slot/remove-bg', requireAuth, async (req, res) => {
  const ids = parseIds(req)
  if (!ids) {
    res.status(400).json({ error: 'piece/slot inválido' })
    return
  }
  const l = foto(ids.pieceId, ids.slot)
  if (!l || !existsSync(l.storage_path)) {
    res.status(404).json({ error: 'foto não encontrada' })
    return
  }
  const forcar = req.query.force === '1'
  if (!forcar && l.sem_fundo_path && existsSync(l.sem_fundo_path)) {
    res.json({ ok: true, cache: true })
    return
  }
  try {
    const png = await removerFundo(readFileSync(l.storage_path), path.basename(l.storage_path))
    const destino = caminhoNovo('semfundo', ids.pieceId, ids.slot)
    trocarArquivo(l.sem_fundo_path, destino, png)
    db.prepare(
      'UPDATE piece_images SET sem_fundo_path = ?, updated_at = ? WHERE piece_id = ? AND slot = ?',
    ).run(destino, nowMs(), ids.pieceId, ids.slot)
    res.json({ ok: true, cache: false })
  } catch (e) {
    res.status(502).json({ error: (e as Error).message })
  }
})

/** Serve a foto sem fundo (base do editor no modo recorte). */
router.get('/pieces/:id/photo/:slot/sem-fundo', requireAuth, (req, res) => {
  const ids = parseIds(req)
  if (!ids) {
    res.status(400).json({ error: 'piece/slot inválido' })
    return
  }
  const l = foto(ids.pieceId, ids.slot)
  if (!l?.sem_fundo_path || !existsSync(l.sem_fundo_path)) {
    res.status(404).json({ error: 'sem fundo ainda não gerado' })
    return
  }
  res.setHeader('content-type', 'image/png')
  res.send(readFileSync(l.sem_fundo_path))
})

/**
 * Substitui a foto sem fundo pela versão editada com a BORRACHA.
 * A borracha é aplicada no navegador (canvas) e o resultado sobe aqui —
 * mesmo efeito do picker local, que reescreve o `{slot} sem fundo.png`.
 */
router.put('/pieces/:id/photo/:slot/sem-fundo', requireAuth, upload.single('image'), (req, res) => {
  const ids = parseIds(req)
  if (!ids) {
    res.status(400).json({ error: 'piece/slot inválido' })
    return
  }
  if (!req.file?.buffer?.length) {
    res.status(400).json({ error: 'envie o PNG no campo "image"' })
    return
  }
  const l = foto(ids.pieceId, ids.slot)
  if (!l) {
    res.status(404).json({ error: 'foto não encontrada' })
    return
  }
  const destino = caminhoNovo('semfundo', ids.pieceId, ids.slot)
  trocarArquivo(l.sem_fundo_path, destino, req.file.buffer)
  db.prepare(
    'UPDATE piece_images SET sem_fundo_path = ?, updated_at = ? WHERE piece_id = ? AND slot = ?',
  ).run(destino, nowMs(), ids.pieceId, ids.slot)
  res.json({ ok: true })
})

/* ------------------------------------------------------------------ *
 * Preview ao vivo — compõe com os parâmetros enviados, sem persistir.
 * ------------------------------------------------------------------ */
router.post('/pieces/:id/photo/:slot/preview', requireAuth, async (req, res) => {
  const ids = parseIds(req)
  if (!ids) {
    res.status(400).json({ error: 'piece/slot inválido' })
    return
  }
  const l = foto(ids.pieceId, ids.slot)
  if (!l) {
    res.status(404).json({ error: 'foto não encontrada' })
    return
  }
  const body = req.body as {
    modo?: Modo
    ajuste?: ParamsEnquadramento
    uWidth?: number
    /** Sem recorte na máscara — mostra o que sobra de fora (guia do editor). */
    semClip?: boolean
  }
  const modo: Modo = body.modo ?? modoDa(l)
  const ajuste = body.ajuste ?? parseAjuste(l.ajuste_json)

  try {
    const png = await comporFoto(l, modo, ajuste, body.uWidth ?? l.u_width ?? 600, body.semClip)
    res.setHeader('content-type', 'image/png')
    res.setHeader('cache-control', 'no-store')
    res.send(png)
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

async function comporFoto(
  l: LinhaFoto,
  modo: Modo,
  ajuste: ParamsEnquadramento,
  uWidth: number,
  semClip = false,
): Promise<Buffer> {
  if (modo === 'recorte') {
    if (!l.sem_fundo_path || !existsSync(l.sem_fundo_path)) {
      throw new Error('rode remove-bg antes de compor o recorte')
    }
    // `semClip` no recorte = ver a foto inteira antes da cápsula (e sem o
    // reenquadramento, que só faz sentido no resultado final).
    return renderRecorte(readFileSync(l.sem_fundo_path), ajuste, uWidth, !semClip)
  }
  if (!existsSync(l.storage_path)) throw new Error('foto original não encontrada')
  return renderCoracao(readFileSync(l.storage_path), ajuste, { clip: !semClip })
}

/* ------------------------------------------------------------------ *
 * Salvar o ajuste — grava params + a composta 900×900 pronta.
 * ------------------------------------------------------------------ */
router.put('/pieces/:id/photo/:slot/ajuste', requireAuth, async (req, res) => {
  const ids = parseIds(req)
  if (!ids) {
    res.status(400).json({ error: 'piece/slot inválido' })
    return
  }
  const l = foto(ids.pieceId, ids.slot)
  if (!l) {
    res.status(404).json({ error: 'foto não encontrada' })
    return
  }
  const body = req.body as { modo?: Modo; ajuste?: ParamsEnquadramento; uWidth?: number }
  const modo: Modo = body.modo ?? modoDa(l)
  const ajuste = body.ajuste ?? {}
  const uWidth = body.uWidth ?? l.u_width ?? 600

  try {
    const composta = await comporFoto(l, modo, ajuste, uWidth)
    const destino = caminhoNovo('composta', ids.pieceId, ids.slot)
    trocarArquivo(l.composta_path, destino, composta)
    db.prepare(
      `UPDATE piece_images
          SET crop = ?, ajuste_json = ?, u_width = ?, composta_path = ?, updated_at = ?
        WHERE piece_id = ? AND slot = ?`,
    ).run(
      modo === 'coracao' ? 'coracao' : 'rosto',
      JSON.stringify(ajuste),
      uWidth,
      destino,
      nowMs(),
      ids.pieceId,
      ids.slot,
    )
    res.json({ ok: true })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

/** Estado atual do ajuste (o editor abre já no que foi salvo). */
router.get('/pieces/:id/photo/:slot/ajuste', requireAuth, async (req, res) => {
  const ids = parseIds(req)
  if (!ids) {
    res.status(400).json({ error: 'piece/slot inválido' })
    return
  }
  // Baixa a foto pendente aqui: é a primeira chamada que o editor faz, então
  // o download acontece uma vez só, antes de qualquer preview.
  let l: LinhaFoto | undefined
  try {
    l = await garantirFoto(ids.pieceId, ids.slot)
  } catch (e) {
    res.status(502).json({ error: `falha ao baixar a foto do chat: ${(e as Error).message}` })
    return
  }
  if (!l) {
    res.status(404).json({ error: 'nenhuma foto escolhida nesse slot' })
    return
  }
  res.json({
    modo: modoDa(l),
    ajuste: parseAjuste(l.ajuste_json),
    uWidth: l.u_width ?? 600,
    temSemFundo: Boolean(l.sem_fundo_path && existsSync(l.sem_fundo_path)),
    temComposta: Boolean(l.composta_path && existsSync(l.composta_path)),
  })
})

/** Composta 900×900 já salva (thumb do picker). */
router.get('/pieces/:id/photo/:slot/composta', requireAuth, (req, res) => {
  const ids = parseIds(req)
  if (!ids) {
    res.status(400).json({ error: 'piece/slot inválido' })
    return
  }
  const l = foto(ids.pieceId, ids.slot)
  if (!l?.composta_path || !existsSync(l.composta_path)) {
    res.status(404).json({ error: 'ainda não composta' })
    return
  }
  res.setHeader('content-type', 'image/png')
  res.send(readFileSync(l.composta_path))
})

/* ------------------------------------------------------------------ *
 * Arte final — gerada sob demanda, nunca armazenada.
 * ------------------------------------------------------------------ */
interface LinhaPeca {
  id: number
  molde: string
  cor: string
  emoji1: string
  emoji2: string
}

export async function gerarArteDaPeca(pieceId: number): Promise<{ nome: string; jpg: Buffer }> {
  const peca = db
    .prepare('SELECT id, molde, cor, emoji1, emoji2 FROM order_pieces WHERE id = ?')
    .get(pieceId) as LinhaPeca | undefined
  if (!peca) throw new Error('peça não encontrada')

  const molde = (peca.molde || '').trim().toUpperCase()
  if (!CANVAS_POR_MOLDE[molde]) throw new Error(`molde sem canvas cadastrado: "${peca.molde}"`)

  const fotos: Buffer[] = []
  for (const slot of [1, 2]) {
    const l = foto(pieceId, slot)
    if (l?.composta_path && existsSync(l.composta_path)) fotos.push(readFileSync(l.composta_path))
  }
  if (fotos.length === 0) throw new Error('nenhuma foto composta — ajuste as fotos no picker antes')
  // Foto única: o slot 2 repete a 1 (mesma regra do pipeline local).
  if (fotos.length === 1) fotos.push(fotos[0])

  const emojis = [peca.emoji1, peca.emoji2]
    .map((nome) => caminhoEmoji(nome))
    .filter((p): p is string => Boolean(p))
    .map((p) => readFileSync(p))
  if (emojis.length === 0) throw new Error('emoji não encontrado no catálogo')

  const jpg = await renderMolde({
    molde,
    cor: peca.cor || '#000000',
    fotos,
    emojis,
  })
  return { nome: `${labelDoMolde(molde)}.jpg`, jpg }
}

/** Resolve o PNG do emoji no catálogo embutido (`server/assets/emojis`). */
function caminhoEmoji(nome: string): string | null {
  const limpo = (nome || '').trim()
  if (!limpo || /^SEM[\s_]?EMOJI$/i.test(limpo)) return null
  const base = path.join(process.cwd(), 'assets', 'emojis')
  for (const cand of [`${limpo}.png`, `${limpo.toUpperCase()}.png`]) {
    const p = path.join(base, cand)
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Download em massa dos APROVADOS — substitui o Processo G (Remessa), que era
 * feito à mão: varrer aprovados, copiar as artes pra uma pasta, marcar
 * "Em produção".
 *
 *   ?sheetDate=DD-MM-AAAA  → só os aprovados daquela data
 *   (sem sheetDate)        → aprovados de TODAS as datas
 *
 * As artes não são armazenadas: cada uma é montada aqui e vai direto pro zip.
 * O status NÃO é alterado — marcar "Em produção" é passo separado e explícito
 * (assim baixar só pra conferir não muda nada).
 */
router.get('/picker/artes-aprovadas.zip', requireAuth, async (req, res) => {
  const sheetDate = typeof req.query.sheetDate === 'string' ? req.query.sheetDate : null
  const STATUS_COL = 5
  const APROVADO = 'Aprovado'

  const where = ["json_extract(row_json, '$[" + STATUS_COL + "]') = ?"]
  const params: unknown[] = [APROVADO]
  if (sheetDate) {
    where.push('sheet_date = ?')
    params.push(sheetDate)
  }
  const pedidos = db
    .prepare(
      `SELECT order_key, id, sheet_date, row_json FROM orders
        WHERE ${where.join(' AND ')} ORDER BY sheet_date, position`,
    )
    .all(...params) as Array<{ order_key: string; id: string; sheet_date: string; row_json: string }>

  if (pedidos.length === 0) {
    res.status(404).json({ error: sheetDate ? `nenhum aprovado em ${sheetDate}` : 'nenhum pedido aprovado' })
    return
  }

  const zip = new JSZip()
  const falhas: string[] = []
  let geradas = 0

  for (const pedido of pedidos) {
    const cliente = (JSON.parse(pedido.row_json)[4] as string) || pedido.id
    const pecas = db
      .prepare('SELECT id FROM order_pieces WHERE order_key = ? ORDER BY seq')
      .all(pedido.order_key) as Array<{ id: number }>
    for (const peca of pecas) {
      try {
        const { nome, jpg } = await gerarArteDaPeca(peca.id)
        // nome do arquivo espelha o do pipeline: "{cliente} {molde}.jpg"
        zip.file(`${cliente} ${nome}`, jpg)
        geradas++
      } catch (e) {
        falhas.push(`${cliente}/peça ${peca.id}: ${(e as Error).message}`)
      }
    }
  }

  if (geradas === 0) {
    res.status(422).json({ error: 'nenhuma arte pôde ser gerada', detalhes: falhas.slice(0, 20) })
    return
  }
  if (falhas.length) zip.file('_FALHAS.txt', falhas.join('\n'))

  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  const rotulo = sheetDate ? `aprovados ${sheetDate}` : 'aprovados (todas as datas)'
  res.setHeader('content-type', 'application/zip')
  res.setHeader('content-disposition', `attachment; filename="${rotulo}.zip"`)
  res.send(buf)
})

/** Quantos aprovados existem — o botão mostra o número antes de baixar. */
router.get('/picker/artes-aprovadas/contagem', requireAuth, (req, res) => {
  const sheetDate = typeof req.query.sheetDate === 'string' ? req.query.sheetDate : null
  const STATUS_COL = 5
  const where = ["json_extract(row_json, '$[" + STATUS_COL + "]') = 'Aprovado'"]
  const params: unknown[] = []
  if (sheetDate) {
    where.push('sheet_date = ?')
    params.push(sheetDate)
  }
  const r = db
    .prepare(`SELECT COUNT(*) AS n FROM orders WHERE ${where.join(' AND ')}`)
    .get(...params) as { n: number }
  res.json({ pedidos: r.n })
})

router.get('/pieces/:id/arte', requireAuth, async (req, res) => {
  const pieceId = Number(req.params.id)
  if (!Number.isInteger(pieceId)) {
    res.status(400).json({ error: 'peça inválida' })
    return
  }
  try {
    const { nome, jpg } = await gerarArteDaPeca(pieceId)
    res.setHeader('content-type', 'image/jpeg')
    res.setHeader('content-disposition', `attachment; filename="${nome}"`)
    res.send(jpg)
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

export default router
