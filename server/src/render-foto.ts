/**
 * Compõe a FOTO dentro do slot 900×900 — coração ou recorte (cápsula).
 *
 * Porte de `coracao_render.render_coracao` / `recorte_render.render_recorte`
 * do repo "Criador de artes". Só o caminho MANUAL: recebe os parâmetros de
 * enquadramento já escolhidos (dx/dy/rotation/width) e aplica. Não há
 * detecção de rosto aqui — por isso nada de OpenCV/ONNX no servidor.
 *
 * As máscaras do coração (base e dilatada p/ a borda) dependem só de
 * constantes, então foram pré-calculadas em `assets/molde/*.png` em vez de
 * recomputar distanceTransform a cada render. A máscara do recorte é um
 * retângulo arredondado — desenhada como SVG.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'

import sharp from 'sharp'

export const CANVAS = 900
/** Borda branca em volta da foto (mesma medida do stroke do recorte). */
export const BORDER_PX = 13

/** Cápsula do recorte: extensão vertical fixa, só a largura varia. */
const U_TOP = 36
const U_BOTTOM = 864
const U_WIDTH_MIN = 120
const U_WIDTH_MAX = 1000
/** Margem final do reenquadramento — paridade com `recorte_silhueta`. */
const MARGEM_BORDA = 20

const assetsDir = path.join(process.cwd(), 'assets', 'molde')

let heartMaskCache: Buffer | null = null
let heartGrownCache: Buffer | null = null

/** Alpha do coração (900×900, 1 canal). Gerado por `coracao_render.heart_alpha`. */
function heartMask(): Buffer {
  heartMaskCache ??= readFileSync(path.join(assetsDir, 'heart-mask.png'))
  return heartMaskCache
}

/** Coração dilatado em BORDER_PX — é o branco que aparece como borda. */
function heartGrown(): Buffer {
  heartGrownCache ??= readFileSync(path.join(assetsDir, 'heart-grown.png'))
  return heartGrownCache
}

export interface ParamsEnquadramento {
  /** Graus, positivo = horário (convenção do Photoshop/Photopea). */
  rotation?: number
  /** Largura alvo da foto após escalar (exclusivo com `height`). */
  width?: number
  height?: number
  /** Deslocamento a partir do centro do canvas. */
  dx?: number
  dy?: number
}

/** Tamanho da foto após escalar — paridade com `coracao_render.scaled_size`. */
export function scaledSize(
  ow: number,
  oh: number,
  width?: number,
  height?: number,
): { w: number; h: number } {
  if (width) return { w: Math.round(width), h: Math.round((oh * width) / ow) }
  if (height) return { w: Math.round((ow * height) / oh), h: Math.round(height) }
  return { w: ow, h: oh }
}

/** Posição do canto quando a foto é centralizada no canvas. */
function defaultTopLeft(sw: number, sh: number): { x: number; y: number } {
  return { x: (CANVAS - sw) / 2, y: (CANVAS - sh) / 2 }
}

/**
 * Aplica rotação + escala + deslocamento e devolve a foto já posicionada num
 * canvas 900×900 transparente (ainda SEM máscara).
 */
async function fotoPosicionada(
  foto: Buffer,
  params: ParamsEnquadramento,
  fundoRotacao: sharp.Color = '#ffffff',
): Promise<Buffer> {
  const rot = Number(params.rotation ?? 0)

  // Rotaciona ANTES de escalar (mesma ordem do Python). `expand` do PIL =
  // manter a foto inteira: no sharp é o comportamento padrão do rotate.
  // O coração preenche de branco (não abrir buraco); o recorte preenche de
  // transparente (a foto já vem sem fundo).
  let img = sharp(foto).ensureAlpha()
  if (rot) img = sharp(await img.rotate(rot, { background: fundoRotacao }).png().toBuffer())

  const meta = await img.metadata()
  const ow = meta.width ?? CANVAS
  const oh = meta.height ?? CANVAS
  const { w: sw, h: sh } = scaledSize(ow, oh, params.width, params.height)

  const escalada = await img.resize(sw, sh, { fit: 'fill', kernel: 'lanczos3' }).png().toBuffer()

  const dx = Number(params.dx ?? 0)
  const dy = Number(params.dy ?? 0)
  const tl = defaultTopLeft(sw, sh)
  const cx = tl.x + sw / 2 + dx
  const cy = tl.y + sh / 2 + dy
  const left = Math.round(cx - sw / 2)
  const top = Math.round(cy - sh / 2)

  const vazio = sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })

  // A foto escalada quase sempre é MAIOR que o canvas (é o normal: enquadrar
  // = ampliar e cortar). O PIL corta sozinho no composite; o sharp recusa
  // entrada maior que o destino, então recorta-se aqui a parte visível.
  const srcX = Math.max(0, -left)
  const srcY = Math.max(0, -top)
  const dstX = Math.max(0, left)
  const dstY = Math.max(0, top)
  const visW = Math.min(sw - srcX, CANVAS - dstX)
  const visH = Math.min(sh - srcY, CANVAS - dstY)
  if (visW <= 0 || visH <= 0) return vazio.png().toBuffer() // fora do canvas

  const recorte = await sharp(escalada)
    .extract({ left: srcX, top: srcY, width: visW, height: visH })
    .png()
    .toBuffer()

  return vazio.composite([{ input: recorte, left: dstX, top: dstY }]).png().toBuffer()
}

/** Máscara como bytes crus de 1 canal (0–255), 900×900. */
async function mascaraRaw(png: Buffer): Promise<Buffer> {
  return sharp(png).greyscale().raw().toBuffer()
}

/**
 * alpha_final = alpha_atual × máscara — equivalente ao `ImageChops.multiply`
 * do PIL. Feito nos bytes crus porque o `joinChannel`/`blend:'multiply'` do
 * sharp não deu o resultado esperado (o alpha saía 255 em tudo, perdendo a
 * transparência fora do coração).
 */
async function aplicarMascara(rgba: Buffer, mascara: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(rgba)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  for (let i = 0, p = 3; i < mascara.length; i++, p += 4) {
    data[p] = Math.round((data[p] * mascara[i]) / 255)
  }
  return sharp(data, {
    raw: { width: info.width, height: info.height, channels: 4 },
  })
    .png()
    .toBuffer()
}

/**
 * Coração 900×900: foto enquadrada, recortada na máscara, com a borda branca
 * aparecendo onde a foto não cobre.
 */
export async function renderCoracao(
  foto: Buffer,
  params: ParamsEnquadramento,
  opts: { clip?: boolean; borderPx?: number } = {},
): Promise<Buffer> {
  const clip = opts.clip ?? true
  const borderPx = opts.borderPx ?? BORDER_PX

  const posicionada = await fotoPosicionada(foto, params)
  if (!clip) return posicionada // preview do editor: mostra o que sai da máscara

  const recortada = await aplicarMascara(posicionada, await mascaraRaw(heartMask()))
  if (borderPx <= 0) return recortada

  // Base branca no formato do coração dilatado → vira a borda onde a foto
  // não chega; a foto recortada entra por cima. Montada nos bytes crus pelo
  // mesmo motivo do aplicarMascara.
  const grown = await mascaraRaw(heartGrown())
  const baseData = Buffer.allocUnsafe(CANVAS * CANVAS * 4)
  for (let i = 0, p = 0; i < grown.length; i++, p += 4) {
    baseData[p] = 255
    baseData[p + 1] = 255
    baseData[p + 2] = 255
    baseData[p + 3] = grown[i]
  }
  const base = await sharp(baseData, {
    raw: { width: CANVAS, height: CANVAS, channels: 4 },
  })
    .png()
    .toBuffer()

  return sharp(base).composite([{ input: recortada }]).png().toBuffer()
}

/** Máscara da cápsula do recorte — retângulo arredondado, raio = metade da largura. */
export function capsulaSvg(widthPx: number): Buffer {
  const w = Math.max(U_WIDTH_MIN, Math.min(U_WIDTH_MAX, Math.round(widthPx)))
  const x0 = Math.floor((CANVAS - w) / 2)
  const r = Math.floor(w / 2)
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}">` +
      `<rect x="${x0}" y="${U_TOP}" width="${w}" height="${U_BOTTOM - U_TOP}" ` +
      `rx="${r}" ry="${r}" fill="#fff"/></svg>`,
  )
}

/**
 * Recorte 900×900: foto (já sem fundo) enquadrada e recortada na cápsula.
 */
export async function renderRecorte(
  fotoSemFundo: Buffer,
  params: ParamsEnquadramento,
  uWidth = 600,
  reenquadrar = true,
): Promise<Buffer> {
  const posicionada = await fotoPosicionada(fotoSemFundo, params, {
    r: 0, g: 0, b: 0, alpha: 0,
  })
  const recortada = await aplicarMascara(posicionada, await mascaraRaw(capsulaSvg(uWidth)))
  return reenquadrar ? reframe(recortada) : recortada
}

/**
 * Recorta no bbox real do alpha, escala pra tocar a margem no lado que
 * limita e recentraliza no 900×900 — faz o recorte manual sair
 * geometricamente igual ao automático. Paridade com `recorte_render.reframe`
 * / `recorte_silhueta._reframe_final`.
 */
export async function reframe(rgba: Buffer, margem = MARGEM_BORDA): Promise<Buffer> {
  const { data, info } = await sharp(rgba)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })

  let minX = info.width
  let minY = info.height
  let maxX = -1
  let maxY = -1
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (maxX < 0) return rgba // nada visível

  const pw = maxX - minX + 1
  const ph = maxY - minY + 1
  const alvo = CANVAS - 2 * margem
  const escala = alvo / Math.max(pw, ph)
  const nw = Math.max(1, Math.round(pw * escala))
  const nh = Math.max(1, Math.round(ph * escala))

  // Redimensiona COR e ALPHA separadamente: é o que o PIL faz (resize por
  // banda). O sharp, por padrão, pré-multiplica o alpha no resize, o que
  // apaga bordas de alpha baixo e encolhe a peça ~7px (medido contra o
  // Python). Separando os canais a saída fica equivalente.
  const recortado = sharp(rgba).extract({ left: minX, top: minY, width: pw, height: ph })
  const [corRes, alphaRes] = await Promise.all([
    recortado.clone().removeAlpha().resize(nw, nh, { fit: 'fill', kernel: 'lanczos3' })
      .raw().toBuffer(),
    recortado.clone().extractChannel('alpha').resize(nw, nh, { fit: 'fill', kernel: 'lanczos3' })
      .raw().toBuffer(),
  ])
  const pecaData = Buffer.allocUnsafe(nw * nh * 4)
  for (let i = 0, c = 0, p = 0; i < alphaRes.length; i++, c += 3, p += 4) {
    pecaData[p] = corRes[c]
    pecaData[p + 1] = corRes[c + 1]
    pecaData[p + 2] = corRes[c + 2]
    pecaData[p + 3] = alphaRes[i]
  }
  const peca = await sharp(pecaData, { raw: { width: nw, height: nh, channels: 4 } })
    .png()
    .toBuffer()

  return sharp({
    create: {
      width: CANVAS,
      height: CANVAS,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([{
      input: peca,
      left: Math.floor((CANVAS - nw) / 2),
      top: Math.floor((CANVAS - nh) / 2),
    }])
    .png()
    .toBuffer()
}
