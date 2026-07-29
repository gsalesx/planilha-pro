/**
 * Picker web — ajusta a foto (coração / recorte) e gera a arte final.
 *
 * Substitui o picker Tkinter local (`picker_coracao.py` do repo "Criador de
 * artes"). Só o caminho MANUAL: o operador posiciona a foto, e o servidor
 * compõe. Não há detecção de rosto, então nada de OpenCV/ONNX aqui.
 *
 * Modelo de armazenamento: guarda-se sempre o INSUMO (foto sem fundo + parâmetros de
 * ajuste + composta 900×900) — regenerar a arte a partir disso é barato. A arte FINAL
 * (o JPG do molde inteiro) passou a ser cacheada por até 10 dias ou até o pedido virar
 * "Concluído" (2026-07-29 — decisão revista: gerar sob demanda toda vez tornava
 * "gerar todas as artes de hoje" e depois só baixar" impraticável em lote; ver
 * `gerarArteDaPecaCache`/`limparArtesExpiradas`).
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
  gerarPrint4x4,
  labelDoMolde,
  renderMolde,
} from '../render-molde.js'
import {
  SHOPEE_COL_INTERNAL_STATUS,
  SHOPEE_INTERNAL_STATUS_SHIPPED,
  SHOPEE_PHOTO_COL_START,
  SHOPEE_PHOTO_COUNT,
} from '../shopee-columns.js'
import { SHOPEE_WORKBOOK_ID } from '../shopee-workbook.js'
import {
  BORDER_PX,
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

/** 'original' = foto COM fundo, cortada direto (uso legítimo — nem toda foto precisa
 *  de remoção de fundo); 'sem_fundo' = usa o PicWish (silhueta recortada de verdade). */
type FonteRecorte = 'original' | 'sem_fundo'

/** `fonteRecorte` mora dentro do MESMO ajuste_json que dx/dy/rotation/width — evita
 *  migração de schema pra guardar 1 campo a mais. `parseAjuste` só devolve os campos
 *  numéricos (o que os render*() esperam); `parseFonteRecorte` lê o mesmo blob pra
 *  achar a escolha de fonte. */
function parseAjuste(json: string): ParamsEnquadramento {
  if (!json) return {}
  try {
    const obj = JSON.parse(json) as ParamsEnquadramento & { fonteRecorte?: unknown }
    return { width: obj.width, height: obj.height, dx: obj.dx, dy: obj.dy, rotation: obj.rotation }
  } catch {
    return {}
  }
}

function parseFonteRecorte(json: string, temSemFundo: boolean): FonteRecorte {
  if (json) {
    try {
      const obj = JSON.parse(json) as { fonteRecorte?: unknown }
      if (obj.fonteRecorte === 'original' || obj.fonteRecorte === 'sem_fundo') return obj.fonteRecorte
    } catch {
      // cai no default abaixo
    }
  }
  // 1ª vez: sem-fundo se já existir (reusa o que já foi removido), original senão —
  // mesma regra do picker local (`fonte = "sem_fundo" if sf.exists() else "original"`).
  return temSemFundo ? 'sem_fundo' : 'original'
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
  // Só baixa do CDN aqui (não mais em GET /ajuste) — remover fundo é o momento em
  // que os bytes de verdade passam a ser necessários no servidor.
  let l: LinhaFoto | undefined
  try {
    l = await garantirFoto(ids.pieceId, ids.slot)
  } catch (e) {
    res.status(502).json({ error: `falha ao baixar a foto do chat: ${(e as Error).message}` })
    return
  }
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
    fonteRecorte?: FonteRecorte
  }
  const modo: Modo = body.modo ?? modoDa(l)
  const ajuste = body.ajuste ?? parseAjuste(l.ajuste_json)
  const fonteRecorte = body.fonteRecorte ?? parseFonteRecorte(l.ajuste_json, Boolean(l.sem_fundo_path && existsSync(l.sem_fundo_path)))

  try {
    const png = await comporFoto(l, modo, ajuste, body.uWidth ?? l.u_width ?? 600, body.semClip, fonteRecorte)
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
  fonteRecorte: FonteRecorte = 'sem_fundo',
): Promise<Buffer> {
  if (modo === 'recorte') {
    // Duas fontes válidas pro recorte: a foto SEM FUNDO (silhueta recortada de
    // verdade pelo PicWish) ou a foto ORIGINAL, cortada direto pela cápsula sem
    // remover fundo — uso legítimo quando o fundo já é liso/não atrapalha, ou o
    // operador só quer conferir/posicionar sem gastar a chamada do PicWish.
    const origem = fonteRecorte === 'original' ? l.storage_path : l.sem_fundo_path
    if (!origem || !existsSync(origem)) {
      throw new Error(
        fonteRecorte === 'original'
          ? 'foto original não encontrada'
          : 'rode remove-bg antes de compor o recorte',
      )
    }
    // `semClip` no recorte = ver a foto inteira antes da cápsula (e sem o
    // reenquadramento, que só faz sentido no resultado final) — a borda também só
    // faz sentido no resultado final (precisa da cápsula+reenquadramento prontos).
    // A composta salva aqui vai direto pra arte final sem nenhum passo depois (esse
    // port não tem "estágio 3" separado como o pipeline Python), então a borda entra
    // já na composição — mesmo timing que renderCoracao já usa por padrão.
    return renderRecorte(readFileSync(origem), ajuste, uWidth, !semClip, semClip ? 0 : BORDER_PX)
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
  // Só baixa aqui (não mais em GET /ajuste) — salvar é o momento em que os bytes de
  // verdade passam a ser necessários no servidor (compor coração/recorte).
  let l: LinhaFoto | undefined
  try {
    l = await garantirFoto(ids.pieceId, ids.slot)
  } catch (e) {
    res.status(502).json({ error: `falha ao baixar a foto do chat: ${(e as Error).message}` })
    return
  }
  if (!l) {
    res.status(404).json({ error: 'foto não encontrada' })
    return
  }
  const body = req.body as {
    modo?: Modo
    ajuste?: ParamsEnquadramento
    uWidth?: number
    fonteRecorte?: FonteRecorte
  }
  const modo: Modo = body.modo ?? modoDa(l)
  const ajuste = body.ajuste ?? {}
  const uWidth = body.uWidth ?? l.u_width ?? 600
  const fonteRecorte = body.fonteRecorte ?? parseFonteRecorte(l.ajuste_json, Boolean(l.sem_fundo_path && existsSync(l.sem_fundo_path)))

  try {
    const composta = await comporFoto(l, modo, ajuste, uWidth, false, fonteRecorte)
    const destino = caminhoNovo('composta', ids.pieceId, ids.slot)
    trocarArquivo(l.composta_path, destino, composta)
    db.prepare(
      `UPDATE piece_images
          SET crop = ?, ajuste_json = ?, u_width = ?, composta_path = ?, updated_at = ?
        WHERE piece_id = ? AND slot = ?`,
    ).run(
      modo === 'coracao' ? 'coracao' : 'rosto',
      // fonteRecorte guardado no MESMO blob — sem migração de schema pra 1 campo.
      JSON.stringify({ ...ajuste, fonteRecorte }),
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

/**
 * Estado atual do ajuste (o editor abre já no que foi salvo).
 *
 * ⚠️ Antes chamava `garantirFoto` aqui — baixava a foto do CDN da Shopee de forma
 * SÍNCRONA, bloqueando a resposta (e o editor inteiro) até terminar. Quando a Shopee
 * demorava/travava pro servidor (visto em produção: URL válida — funciona na hora
 * testada de outra rede —, mas falha/expira repetido só a partir do container), o
 * picker simplesmente NÃO ABRIA. Como o NAVEGADOR de quem está operando consegue
 * buscar a mesma URL direto (é o caminho que qualquer navegador usa normalmente,
 * sem o gargalo específico do servidor), essa rota agora só LÊ o banco — se a foto
 * ainda não foi baixada, devolve a URL pendente pro cliente carregar direto, sem
 * nenhum download aqui. O download de verdade só acontece em PUT /ajuste (salvar) e
 * POST /remove-bg — os dois momentos que realmente precisam dos bytes no servidor.
 */
router.get('/pieces/:id/photo/:slot/ajuste', requireAuth, (req, res) => {
  const ids = parseIds(req)
  if (!ids) {
    res.status(400).json({ error: 'piece/slot inválido' })
    return
  }
  const l = foto(ids.pieceId, ids.slot)
  if (l && existsSync(l.storage_path)) {
    const temSemFundo = Boolean(l.sem_fundo_path && existsSync(l.sem_fundo_path))
    res.json({
      modo: modoDa(l),
      ajuste: parseAjuste(l.ajuste_json),
      uWidth: l.u_width ?? 600,
      temSemFundo,
      temComposta: Boolean(l.composta_path && existsSync(l.composta_path)),
      fonteRecorte: parseFonteRecorte(l.ajuste_json, temSemFundo),
      pendingUrl: null,
    })
    return
  }

  // Ainda não baixada — devolve a URL do CDN pro NAVEGADOR carregar direto (evita
  // o gargalo do servidor) em vez de 502 esperando um download que pode nem
  // terminar. `l` pode existir aqui (peça já composta antes, mas o arquivo sumiu
  // do disco) — nesse caso o crop salvo prevalece sobre o da foto pendente.
  const pendente = db
    .prepare('SELECT url, crop FROM piece_pending_photos WHERE piece_id = ? AND slot = ?')
    .get(ids.pieceId, ids.slot) as { url: string; crop: string } | undefined
  if (!pendente?.url) {
    res.status(404).json({ error: 'nenhuma foto escolhida nesse slot' })
    return
  }
  const crop = l?.crop ?? pendente.crop
  res.json({
    modo: crop === 'coracao' ? 'coracao' : 'recorte',
    ajuste: parseAjuste(l?.ajuste_json ?? ''),
    uWidth: l?.u_width ?? 600,
    temSemFundo: false,
    temComposta: false,
    fonteRecorte: 'original',
    pendingUrl: pendente.url,
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
 * Arte final — cacheada por até 10 dias ou até o pedido virar "Concluído".
 * ------------------------------------------------------------------ */
interface LinhaPeca {
  id: number
  molde: string
  cor: string
  emoji1: string
  emoji2: string
}

/** Nome do JPG exportado: "{cliente} {molde}.jpg" — mesmo padrão do pipeline local
 *  (`{cliente} {tamanho}.jpg`). Sem o cliente, o arquivo baixado vira só "G MASC.jpg"
 *  e não dá pra saber de quem é fora do contexto da tela. */
function nomeArteFinal(molde: string, orderKey: string, workbookId: string): string {
  const linha = db
    .prepare('SELECT id FROM orders WHERE workbook_id = ? AND order_key = ?')
    .get(workbookId, orderKey) as { id: string } | undefined
  const row = linha
    ? (db.prepare('SELECT row_json FROM orders WHERE workbook_id = ? AND order_key = ?')
        .get(workbookId, orderKey) as { row_json: string })
    : null
  const cliente = row ? String((JSON.parse(row.row_json) as string[])[4] ?? '').trim() : ''
  return cliente ? `${cliente} ${labelDoMolde(molde)}.jpg` : `${labelDoMolde(molde)}.jpg`
}

export async function gerarArteDaPeca(pieceId: number, workbookId: string = SHOPEE_WORKBOOK_ID): Promise<{ nome: string; jpg: Buffer }> {
  const peca = db
    .prepare('SELECT id, order_key, molde, cor, emoji1, emoji2 FROM order_pieces WHERE id = ?')
    .get(pieceId) as (LinhaPeca & { order_key: string }) | undefined
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
  return { nome: nomeArteFinal(molde, peca.order_key, workbookId), jpg }
}

/** 10 dias — teto de guarda mesmo se o pedido nunca chegar a "Concluído" na Shopee. */
const ARTE_CACHE_DIAS = 10
const ARTE_CACHE_MS = ARTE_CACHE_DIAS * 24 * 60 * 60 * 1000

/** Muda sempre que algo que afeta o RENDER muda — cor/emoji/molde/tipo/tamanho da peça
 *  (order_pieces.updated_at) ou a foto composta de qualquer slot (piece_images.updated_at).
 *  Comparar essa string com a guardada é o que decide se a arte em cache ainda vale, sem
 *  precisar caçar e invalidar manualmente em cada rota que mexe em peça/foto. */
function chaveCacheArte(pieceId: number): string | null {
  const peca = db
    .prepare('SELECT updated_at, molde, cor, emoji1, emoji2 FROM order_pieces WHERE id = ?')
    .get(pieceId) as { updated_at: number; molde: string; cor: string; emoji1: string; emoji2: string } | undefined
  if (!peca) return null
  const fotos = db
    .prepare('SELECT slot, updated_at FROM piece_images WHERE piece_id = ? ORDER BY slot')
    .all(pieceId) as Array<{ slot: number; updated_at: number }>
  return JSON.stringify([peca.updated_at, peca.molde, peca.cor, peca.emoji1, peca.emoji2, fotos])
}

/**
 * Igual `gerarArteDaPeca`, mas reaproveita o JPG já montado se nada que afeta o render
 * mudou desde então — é o que permite "gerar todas as artes" rodar em lote e o download
 * (individual, do pedido, ou o zip de aprovados) ser praticamente instantâneo depois.
 */
export async function gerarArteDaPecaCache(pieceId: number, workbookId: string = SHOPEE_WORKBOOK_ID): Promise<{ nome: string; jpg: Buffer }> {
  const chave = chaveCacheArte(pieceId)
  if (chave) {
    const cache = db
      .prepare('SELECT cache_key, jpg_path FROM piece_arte_cache WHERE piece_id = ?')
      .get(pieceId) as { cache_key: string; jpg_path: string } | undefined
    if (cache && cache.cache_key === chave && existsSync(cache.jpg_path)) {
      const peca = db
        .prepare('SELECT molde, order_key FROM order_pieces WHERE id = ?')
        .get(pieceId) as { molde: string; order_key: string }
      return {
        nome: nomeArteFinal(peca.molde.trim().toUpperCase(), peca.order_key, workbookId),
        jpg: readFileSync(cache.jpg_path),
      }
    }
  }

  const { nome, jpg } = await gerarArteDaPeca(pieceId, workbookId)
  if (chave) {
    const destino = path.join(imagesDir, `arte_${pieceId}_${crypto.randomBytes(4).toString('hex')}.jpg`)
    const now = nowMs()
    const anterior = db
      .prepare('SELECT jpg_path FROM piece_arte_cache WHERE piece_id = ?')
      .get(pieceId) as { jpg_path: string } | undefined
    writeFileSync(destino, jpg)
    db.prepare(
      `INSERT INTO piece_arte_cache (piece_id, cache_key, jpg_path, gerado_em, expira_em)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(piece_id) DO UPDATE SET
         cache_key = excluded.cache_key, jpg_path = excluded.jpg_path,
         gerado_em = excluded.gerado_em, expira_em = excluded.expira_em`,
    ).run(pieceId, chave, destino, now, now + ARTE_CACHE_MS)
    if (anterior && anterior.jpg_path !== destino) {
      try {
        unlinkSync(anterior.jpg_path)
      } catch {
        // arquivo já sumiu — sem problema
      }
    }
  }
  return { nome, jpg }
}

/**
 * Roda periodicamente (ver index.ts): apaga arte cacheada com mais de 10 dias OU cujo
 * pedido já virou "Concluído" (SHIPPED confirmado pela Shopee — depois disso a arte
 * não tem mais utilidade, o pedido já foi despachado).
 */
export function limparArtesExpiradas(): { apagadas: number } {
  const agora = nowMs()
  const expiradasPorTempo = db
    .prepare('SELECT piece_id, jpg_path FROM piece_arte_cache WHERE expira_em <= ?')
    .all(agora) as Array<{ piece_id: number; jpg_path: string }>

  const concluidos = db
    .prepare(
      `SELECT DISTINCT p.id AS piece_id, c.jpg_path
         FROM piece_arte_cache c
         INNER JOIN order_pieces p ON p.id = c.piece_id
         INNER JOIN orders o ON o.workbook_id = p.workbook_id AND o.order_key = p.order_key
        WHERE json_extract(o.row_json, '$[${SHOPEE_COL_INTERNAL_STATUS}]') = ?`,
    )
    .all(SHOPEE_INTERNAL_STATUS_SHIPPED) as Array<{ piece_id: number; jpg_path: string }>

  const todas = new Map<number, string>()
  for (const l of [...expiradasPorTempo, ...concluidos]) todas.set(l.piece_id, l.jpg_path)

  const del = db.prepare('DELETE FROM piece_arte_cache WHERE piece_id = ?')
  for (const [pieceId, jpgPath] of todas) {
    del.run(pieceId)
    try {
      unlinkSync(jpgPath)
    } catch {
      // arquivo já sumiu — sem problema
    }
  }
  return { apagadas: todas.size }
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
 * GET /pieces/:id/emoji/:slot — serve o PNG do emoji (1 ou 2) de uma peça.
 * Rota LEVE (só resolve o nome e lê o arquivo, sem nenhum processamento) —
 * existe pra o montador de arte no NAVEGADOR (render-molde-client.ts) montar
 * a folha sem precisar que o servidor componha nada.
 */
router.get('/pieces/:id/emoji/:slot', requireAuth, (req, res) => {
  const pieceId = Number(req.params.id)
  const slot = Number(req.params.slot)
  if (!Number.isInteger(pieceId) || (slot !== 1 && slot !== 2)) {
    res.status(400).json({ error: 'peça/slot inválido' })
    return
  }
  const peca = db
    .prepare('SELECT emoji1, emoji2 FROM order_pieces WHERE id = ?')
    .get(pieceId) as { emoji1: string; emoji2: string } | undefined
  if (!peca) {
    res.status(404).json({ error: 'peça não encontrada' })
    return
  }
  const nomeEmoji = slot === 1 ? peca.emoji1 : peca.emoji2
  const p = caminhoEmoji(nomeEmoji)
  if (!p) {
    res.status(404).json({ error: 'emoji não encontrado no catálogo' })
    return
  }
  res.setHeader('content-type', 'image/png')
  res.setHeader('cache-control', 'private, max-age=3600')
  res.send(readFileSync(p))
})

/**
 * POST /pieces/:id/print-upload — grava um print JÁ MONTADO NO NAVEGADOR
 * (multipart, campo "image") na coluna de foto da linha, marcando Pronto se
 * for o caso — mesma gravação de `gerarEGuardarPrint`, sem gerar nada aqui
 * (o servidor só recebe e guarda).
 */
router.post('/pieces/:id/print-upload', requireAuth, upload.single('image'), (req, res) => {
  const pieceId = Number(req.params.id)
  if (!Number.isInteger(pieceId)) {
    res.status(400).json({ error: 'peça inválida' })
    return
  }
  const workbookId = typeof req.query.workbookId === 'string' ? req.query.workbookId : SHOPEE_WORKBOOK_ID
  if (!req.file) {
    res.status(400).json({ error: 'arquivo "image" obrigatório' })
    return
  }
  const peca = db
    .prepare('SELECT order_key, seq FROM order_pieces WHERE id = ? AND workbook_id = ?')
    .get(pieceId, workbookId) as { order_key: string; seq: number } | undefined
  if (!peca) {
    res.status(404).json({ error: 'peça não encontrada' })
    return
  }
  const linha = db
    .prepare('SELECT id FROM orders WHERE workbook_id = ? AND order_key = ?')
    .get(workbookId, peca.order_key) as { id: string } | undefined
  if (!linha) {
    res.status(404).json({ error: 'linha do pedido não encontrada' })
    return
  }
  const col = colunaDaPeca(peca.seq)
  guardarPrint(workbookId, peca.order_key, col, req.file.buffer)
  const pronto = marcarProntoSeCompleto(workbookId, linha.id)
  res.json({ ok: true, col, marcadoPronto: pronto })
})

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
        // nome já vem como "{cliente} {molde}.jpg" (nomeArteFinal) — não prefixar de novo.
        const { nome, jpg } = await gerarArteDaPecaCache(peca.id)
        zip.file(nome, jpg)
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
    const { nome, jpg } = await gerarArteDaPecaCache(pieceId)
    res.setHeader('content-type', 'image/jpeg')
    res.setHeader('content-disposition', `attachment; filename="${nome}"`)
    res.send(jpg)
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

/**
 * GET /workbooks/:wb/orders/:orderKey/artes — baixa a(s) arte(s) do PEDIDO INTEIRO
 * (linha + filhas, todas as peças de cada uma) direto do painel do chat, sem esperar
 * o pedido virar "Aprovado" — pedido do user: conferir/entregar uma arte pontual sem
 * passar pelo fluxo de remessa em massa.
 *
 * 1 peça só → devolve o JPG direto. 2+ → zip (mesmo padrão de artes-aprovadas.zip).
 */
router.get('/workbooks/:wb/orders/:orderKey/artes', requireAuth, async (req, res) => {
  const { wb, orderKey } = req.params
  const linha = db
    .prepare('SELECT order_key, id, parent_key FROM orders WHERE workbook_id = ? AND order_key = ?')
    .get(wb, orderKey) as { order_key: string; id: string; parent_key: string | null } | undefined
  if (!linha) {
    res.status(404).json({ error: 'Pedido não encontrado' })
    return
  }
  const chavePai = linha.parent_key ?? linha.order_key
  const chaves = [
    chavePai,
    ...(
      db.prepare('SELECT order_key FROM orders WHERE workbook_id = ? AND parent_key = ? ORDER BY position')
        .all(wb, chavePai) as Array<{ order_key: string }>
    ).map((f) => f.order_key),
  ]

  const pecas = chaves.flatMap(
    (k) => db.prepare('SELECT id FROM order_pieces WHERE workbook_id = ? AND order_key = ? ORDER BY seq').all(wb, k) as Array<{ id: number }>,
  )
  if (pecas.length === 0) {
    res.status(404).json({ error: 'Nenhuma peça montada ainda pra este pedido' })
    return
  }

  const geradas: Array<{ nome: string; jpg: Buffer }> = []
  const falhas: string[] = []
  for (const p of pecas) {
    try {
      geradas.push(await gerarArteDaPecaCache(p.id, wb))
    } catch (e) {
      falhas.push(`peça ${p.id}: ${(e as Error).message}`)
    }
  }
  if (geradas.length === 0) {
    res.status(422).json({ error: 'Nenhuma arte pôde ser gerada', detalhes: falhas })
    return
  }

  if (geradas.length === 1 && falhas.length === 0) {
    res.setHeader('content-type', 'image/jpeg')
    res.setHeader('content-disposition', `attachment; filename="${geradas[0].nome}"`)
    res.send(geradas[0].jpg)
    return
  }

  const zip = new JSZip()
  geradas.forEach((g, i) => zip.file(`${linha.id} ${i + 1} - ${g.nome}`, g.jpg))
  if (falhas.length) zip.file('_FALHAS.txt', falhas.join('\n'))
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  res.setHeader('content-type', 'application/zip')
  res.setHeader('content-disposition', `attachment; filename="${linha.id}.zip"`)
  res.send(buf)
})

/* ===========================================================
   Print 4×4 — a prévia que vai pra planilha e pro chat
   =========================================================== */

const STATUS_PRONTO = 'Pronto'

/**
 * Coluna de foto da peça. Normalmente a linha é a peça, então tudo cai na primeira
 * coluna; quando várias peças dividem a mesma linha (SKU combo tipo CAMISOLA+SHORT, e
 * pedidos antigos ainda no formato 1-linha-por-item), elas ocupam colunas seguidas.
 */
function colunaDaPeca(seq: number): number {
  const offset = Math.max(0, Math.min(SHOPEE_PHOTO_COUNT - 1, seq - 1))
  return SHOPEE_PHOTO_COL_START + offset
}

/** Grava o print na coluna de foto da linha, substituindo o anterior (arquivo incluso). */
function guardarPrint(workbookId: string, orderKey: string, col: number, jpg: Buffer): void {
  const fileName = `print_${orderKey.replace(/[^A-Za-z0-9_-]/g, '_')}_c${col}_${crypto.randomBytes(4).toString('hex')}.jpg`
  const storagePath = path.join(imagesDir, fileName)
  writeFileSync(storagePath, jpg)
  const now = nowMs()
  db.transaction(() => {
    const anterior = db
      .prepare('SELECT storage_path FROM images WHERE workbook_id = ? AND order_id = ? AND col = ?')
      .get(workbookId, orderKey, col) as { storage_path: string } | undefined
    if (anterior) {
      try {
        unlinkSync(anterior.storage_path)
      } catch {
        // arquivo já sumiu — o registro no banco é o que importa
      }
    }
    db.prepare(
      `INSERT INTO images (workbook_id, order_id, col, file_name, mime, storage_path, updated_at)
       VALUES (?, ?, ?, ?, 'image/jpeg', ?, ?)
       ON CONFLICT(workbook_id, order_id, col) DO UPDATE SET
         file_name = excluded.file_name, mime = excluded.mime,
         storage_path = excluded.storage_path, updated_at = excluded.updated_at`,
    ).run(workbookId, orderKey, col, fileName, storagePath, now)
    db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  })()
}

/**
 * Marca "Pronto" em TODAS as linhas do pedido — mas só quando todas as peças dele já têm
 * print. Um pedido com 2 peças e só 1 prévia não está pronto: marcar cedo faria a prévia
 * ser disparada pro cliente faltando peça.
 */
function marcarProntoSeCompleto(workbookId: string, orderSn: string): boolean {
  const linhas = db
    .prepare('SELECT order_key, row_json FROM orders WHERE workbook_id = ? AND id = ?')
    .all(workbookId, orderSn) as Array<{ order_key: string; row_json: string }>
  if (linhas.length === 0) return false

  for (const l of linhas) {
    const pecas = db
      .prepare('SELECT seq FROM order_pieces WHERE workbook_id = ? AND order_key = ?')
      .all(workbookId, l.order_key) as Array<{ seq: number }>
    if (pecas.length === 0) return false // linha sem peça: pedido ainda não montado
    for (const p of pecas) {
      const tem = db
        .prepare('SELECT 1 FROM images WHERE workbook_id = ? AND order_id = ? AND col = ?')
        .get(workbookId, l.order_key, colunaDaPeca(p.seq))
      if (!tem) return false
    }
  }

  const now = nowMs()
  const upd = db.prepare('UPDATE orders SET row_json = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?')
  db.transaction(() => {
    for (const l of linhas) {
      const row = JSON.parse(l.row_json || '[]') as unknown[]
      while (row.length <= SHOPEE_COL_INTERNAL_STATUS) row.push('')
      if (String(row[SHOPEE_COL_INTERNAL_STATUS] ?? '') === STATUS_PRONTO) continue
      row[SHOPEE_COL_INTERNAL_STATUS] = STATUS_PRONTO
      upd.run(JSON.stringify(row), now, workbookId, l.order_key)
    }
    db.prepare('UPDATE workbooks SET updated_at = ? WHERE id = ?').run(now, workbookId)
  })()
  return true
}

/** Monta a arte da peça, recorta o print e grava na coluna. Devolve a coluna usada. */
async function gerarEGuardarPrint(pieceId: number, workbookId: string): Promise<{ col: number; orderKey: string; orderSn: string }> {
  const peca = db
    .prepare('SELECT order_key, seq FROM order_pieces WHERE id = ? AND workbook_id = ?')
    .get(pieceId, workbookId) as { order_key: string; seq: number } | undefined
  if (!peca) throw new Error('peça não encontrada')

  const linha = db
    .prepare('SELECT id FROM orders WHERE workbook_id = ? AND order_key = ?')
    .get(workbookId, peca.order_key) as { id: string } | undefined
  if (!linha) throw new Error('linha do pedido não encontrada')

  const { jpg } = await gerarArteDaPecaCache(pieceId, workbookId)
  // nFotos = quantas fotos a arte usa; define a largura da unidade do padrão.
  const nFotos = [1, 2].filter((slot) => {
    const l = foto(pieceId, slot)
    return !!l?.composta_path && existsSync(l.composta_path)
  }).length
  const print = await gerarPrint4x4(jpg, Math.max(1, nFotos))

  const col = colunaDaPeca(peca.seq)
  guardarPrint(workbookId, peca.order_key, col, print)
  return { col, orderKey: peca.order_key, orderSn: linha.id }
}

/** POST /pieces/:id/print — gera a prévia de UMA peça e grava na planilha. */
router.post('/pieces/:id/print', requireAuth, async (req, res) => {
  const pieceId = Number(req.params.id)
  if (!Number.isInteger(pieceId)) {
    res.status(400).json({ error: 'peça inválida' })
    return
  }
  const workbookId = typeof req.query.workbookId === 'string' ? req.query.workbookId : SHOPEE_WORKBOOK_ID
  try {
    const r = await gerarEGuardarPrint(pieceId, workbookId)
    const pronto = marcarProntoSeCompleto(workbookId, r.orderSn)
    res.json({
      ok: true,
      col: r.col,
      orderSn: r.orderSn,
      marcadoPronto: pronto,
      url: `/api/workbooks/${encodeURIComponent(workbookId)}/images/${encodeURIComponent(r.orderKey)}/${r.col}`,
    })
  } catch (e) {
    res.status(400).json({ error: (e as Error).message })
  }
})

/**
 * POST /workbooks/:wb/orders/:orderKey/gerar-previas — prévia de UM pedido inteiro
 * (todas as peças da linha + filhas), direto do painel do chat. Mesma lógica de
 * `/picker/prints` (que faz o dia inteiro), só que escopada a 1 pedido — pra gerar a
 * prévia sem esperar rodar o lote do dia.
 */
router.post('/workbooks/:wb/orders/:orderKey/gerar-previas', requireAuth, async (req, res) => {
  const { wb, orderKey } = req.params
  const linha = db
    .prepare('SELECT order_key, id, parent_key FROM orders WHERE workbook_id = ? AND order_key = ?')
    .get(wb, orderKey) as { order_key: string; id: string; parent_key: string | null } | undefined
  if (!linha) {
    res.status(404).json({ error: 'Pedido não encontrado' })
    return
  }
  const chavePai = linha.parent_key ?? linha.order_key
  const chaves = [
    chavePai,
    ...(
      db.prepare('SELECT order_key FROM orders WHERE workbook_id = ? AND parent_key = ? ORDER BY position')
        .all(wb, chavePai) as Array<{ order_key: string }>
    ).map((f) => f.order_key),
  ]

  const feitas: Array<{ pieceId: number; col: number; orderKey: string; molde: string }> = []
  const falhas: Array<{ pieceId: number; erro: string }> = []
  for (const chave of chaves) {
    const pecas = db
      .prepare('SELECT id, molde FROM order_pieces WHERE workbook_id = ? AND order_key = ? ORDER BY seq')
      .all(wb, chave) as Array<{ id: number; molde: string }>
    for (const p of pecas) {
      try {
        const r = await gerarEGuardarPrint(p.id, wb)
        feitas.push({ pieceId: p.id, col: r.col, orderKey: r.orderKey, molde: p.molde })
      } catch (e) {
        falhas.push({ pieceId: p.id, erro: (e as Error).message })
      }
    }
  }
  if (feitas.length === 0) {
    res.status(422).json({ error: 'Nenhuma prévia pôde ser gerada', detalhes: falhas })
    return
  }
  const pronto = marcarProntoSeCompleto(wb, linha.id)
  res.json({
    ok: true,
    previasGeradas: feitas.length,
    // Pro operador escolher qual prévia mandar no chat, sem ter que ir até o grid.
    previas: feitas.map((f) => ({ orderKey: f.orderKey, col: f.col, label: f.molde })),
    falhas,
    marcadoPronto: pronto,
  })
})

/**
 * POST /picker/prints?sheetDate=DD-MM-AAAA — prévias em massa do dia.
 *
 * Substitui `gerar_prints_4x4.py` + `planilha_upload_previews.py` do pipeline local, que
 * dependiam do staging em disco (`_test/{data}/…`) — inexistente pros pedidos montados no
 * picker web. `?status=` filtra a fila (default: todos menos os já Prontos/entregues);
 * `?forcar=1` refaz a prévia de quem já tem.
 */
router.post('/picker/prints', requireAuth, async (req, res) => {
  const workbookId = typeof req.query.workbookId === 'string' ? req.query.workbookId : SHOPEE_WORKBOOK_ID
  const sheetDate = typeof req.query.sheetDate === 'string' ? req.query.sheetDate.trim() : ''
  const forcar = req.query.forcar === '1' || req.query.forcar === 'true'
  if (!sheetDate) {
    res.status(400).json({ error: 'sheetDate (DD-MM-AAAA) obrigatório' })
    return
  }

  const linhas = db
    .prepare('SELECT order_key, id FROM orders WHERE workbook_id = ? AND sheet_date = ? ORDER BY position')
    .all(workbookId, sheetDate) as Array<{ order_key: string; id: string }>

  const feitas: Array<{ orderSn: string; pieceId: number; col: number }> = []
  const puladas: Array<{ orderSn: string; pieceId: number; motivo: string }> = []
  const falhas: Array<{ orderSn: string; pieceId: number; erro: string }> = []
  const pedidosTocados = new Set<string>()

  for (const l of linhas) {
    const pecas = db
      .prepare('SELECT id, seq FROM order_pieces WHERE workbook_id = ? AND order_key = ? ORDER BY seq')
      .all(workbookId, l.order_key) as Array<{ id: number; seq: number }>
    for (const p of pecas) {
      const col = colunaDaPeca(p.seq)
      if (!forcar) {
        const jaTem = db
          .prepare('SELECT 1 FROM images WHERE workbook_id = ? AND order_id = ? AND col = ?')
          .get(workbookId, l.order_key, col)
        if (jaTem) {
          puladas.push({ orderSn: l.id, pieceId: p.id, motivo: 'já tem prévia' })
          continue
        }
      }
      try {
        const r = await gerarEGuardarPrint(p.id, workbookId)
        feitas.push({ orderSn: l.id, pieceId: p.id, col: r.col })
        pedidosTocados.add(l.id)
      } catch (e) {
        // Peça sem foto ajustada ainda é o caso NORMAL no meio do dia — não é erro do
        // sistema, e não pode derrubar o lote inteiro.
        falhas.push({ orderSn: l.id, pieceId: p.id, erro: (e as Error).message })
      }
    }
  }

  const prontos: string[] = []
  for (const sn of pedidosTocados) {
    if (marcarProntoSeCompleto(workbookId, sn)) prontos.push(sn)
  }

  res.json({
    ok: true,
    sheetDate,
    previasGeradas: feitas.length,
    pedidosMarcadosPronto: prontos.length,
    prontos,
    puladas: puladas.length,
    falhas,
  })
})

/* ===========================================================
   Gerar todas as artes em lote — roda em SEGUNDO PLANO no servidor
   =========================================================== */

interface JobGerarArtes {
  rodando: boolean
  total: number
  feitas: number
  falhas: Array<{ pieceId: number; erro: string }>
  iniciadoEm: number
  concluidoEm: number | null
}

/**
 * Estado do lote em memória (1 job por vez) — NÃO por request HTTP. O pedido do user
 * é "deixo gerando e depois só volto pra baixar": se isso fosse uma requisição comum,
 * navegar pra outra tela cancelaria o fetch e o trabalho pararia no meio. Rodando fora
 * do ciclo de vida da request, o job continua mesmo com o navegador fechado; o
 * progresso é consultado por polling em GET /picker/gerar-todas-artes/status.
 */
let jobGerarArtes: JobGerarArtes | null = null

/**
 * POST /picker/gerar-todas-artes?sheetDate=DD-MM-AAAA (opcional) — pré-gera (cacheia)
 * a arte de toda peça de todo pedido do dia, ou de TODOS os dias se omitido. Só
 * aquece o cache; usar depois GET /pieces/:id/arte, o download do pedido ou o zip de
 * aprovados pra baixar — vão sair praticamente instantâneos por já estarem prontos.
 */
router.post('/picker/gerar-todas-artes', requireAuth, (req, res) => {
  if (jobGerarArtes?.rodando) {
    res.status(409).json({ error: 'Já tem um lote rodando', job: jobGerarArtes })
    return
  }
  const workbookId = typeof req.query.workbookId === 'string' ? req.query.workbookId : SHOPEE_WORKBOOK_ID
  const sheetDate = typeof req.query.sheetDate === 'string' ? req.query.sheetDate.trim() : ''

  const where = sheetDate ? 'AND sheet_date = ?' : ''
  const params = sheetDate ? [workbookId, sheetDate] : [workbookId]
  const pecas = db
    .prepare(
      `SELECT p.id AS piece_id FROM order_pieces p
         INNER JOIN orders o ON o.workbook_id = p.workbook_id AND o.order_key = p.order_key
        WHERE p.workbook_id = ? ${where}
        ORDER BY o.position`,
    )
    .all(...params) as Array<{ piece_id: number }>

  jobGerarArtes = { rodando: true, total: pecas.length, feitas: 0, falhas: [], iniciadoEm: nowMs(), concluidoEm: null }
  res.json({ ok: true, job: jobGerarArtes })

  // Roda DEPOIS de responder — o operador não fica esperando o lote inteiro.
  void (async () => {
    for (const p of pecas) {
      try {
        await gerarArteDaPecaCache(p.piece_id)
      } catch (e) {
        jobGerarArtes!.falhas.push({ pieceId: p.piece_id, erro: (e as Error).message })
      }
      jobGerarArtes!.feitas++
    }
    jobGerarArtes!.rodando = false
    jobGerarArtes!.concluidoEm = nowMs()
  })()
})

/** GET /picker/gerar-todas-artes/status — progresso do lote em andamento (ou do último). */
router.get('/picker/gerar-todas-artes/status', requireAuth, (_req, res) => {
  res.json({ ok: true, job: jobGerarArtes })
})

export default router
