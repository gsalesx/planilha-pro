/**
 * Compõe a FOTO dentro do slot 900×900 — coração, recorte (cápsula) ou rosto
 * (face cutout PicWish, sem moldura).
 *
 * Porte de `coracao_render.render_coracao` / `recorte_render.render_recorte`
 * do repo "Criador de artes". Só o caminho MANUAL: recebe os parâmetros de
 * enquadramento já escolhidos (dx/dy/rotation/width) e aplica. Detecção de
 * rosto fica na API PicWish (face-cutout), não no servidor.
 *
 * As máscaras do coração (base e dilatada p/ a borda) dependem só de
 * constantes, então foram pré-calculadas em `assets/molde/*.png` em vez de
 * recomputar distanceTransform a cada render. A máscara do recorte é um
 * retângulo arredondado — desenhada como SVG. O modo rosto não usa moldura:
 * só a silhueta do face-cutout + borda branca (mesmo `bordaExpandida`).
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

/**
 * Distance transform euclidiano EXATO (Felzenszwalb & Huttenlocher, 2004 — dois passes
 * 1D separáveis, O(n)) — mesma matemática do `cv2.distanceTransform(DIST_L2)` usado no
 * pipeline Python (`render_molde_local.borda_expandida`). Sharp/libvips não expõe
 * distance transform, e Node não tem OpenCV; implementar o algoritmo exato (em vez de
 * uma aproximação por blur/dilatação) é o que garante bater pixel a pixel com a borda
 * já validada — ela é resultado de comparativo direto contra o Photopea em 2026-05-30,
 * não pode regredir pra uma aproximação pior.
 *
 * `seed[i] = 0` no pixel-fonte (dentro da silhueta), `Infinity` fora. Devolve a
 * distância euclidiana ao pixel-fonte mais próximo.
 */
function edt1d(f: Float64Array, n: number): Float64Array {
  const d = new Float64Array(n)
  const v = new Int32Array(n)
  const z = new Float64Array(n + 1)
  let k = 0
  v[0] = 0
  z[0] = -Infinity
  z[1] = Infinity
  for (let q = 1; q < n; q++) {
    let s = 0
    while (true) {
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k])
      if (s <= z[k]) {
        k--
      } else break
    }
    k++
    v[k] = q
    z[k] = s
    z[k + 1] = Infinity
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const dq = q - v[k]
    d[q] = dq * dq + f[v[k]]
  }
  return d
}

function distanceTransform(seedZero: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e10
  const g = new Float64Array(w * h)
  // Passo 1: colunas.
  const col = new Float64Array(h)
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) col[y] = seedZero[y * w + x] ? 0 : INF
    const dcol = edt1d(col, h)
    for (let y = 0; y < h; y++) g[y * w + x] = dcol[y]
  }
  // Passo 2: linhas, sobre o resultado do passo 1.
  const out = new Float32Array(w * h)
  const row = new Float64Array(w)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) row[x] = g[y * w + x]
    const drow = edt1d(row, w)
    for (let x = 0; x < w; x++) out[y * w + x] = Math.sqrt(drow[x])
  }
  return out
}

/**
 * Borda branca pelo modelo do Photopea, EXATAMENTE como `render_molde_local.borda_expandida`:
 * silhueta branca expandida ATRÁS da foto (a foto cobre por cima; sobra o branco onde ela
 * não chega). Expansão medida a partir da borda visível (alpha≥128) via distance transform
 * — dá largura uniforme com ~1px de AA, sem afinar em cantos côncavos (o problema que a
 * dilatação por blur do alpha suave dava, comparado 2026-05-30).
 *
 * Diferente do coração (máscara sempre igual → pré-calculada em PNG), a máscara do recorte
 * varia com a largura da cápsula — a expansão precisa ser calculada em runtime.
 */
async function bordaExpandida(rgba: Buffer, strokePx: number): Promise<Buffer> {
  const { data, info } = await sharp(rgba).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: w, height: h } = info
  const n = w * h
  const alpha = new Uint8Array(n)
  const binario = new Uint8Array(n)
  for (let i = 0, p = 3; i < n; i++, p += 4) {
    alpha[i] = data[p]
    binario[i] = data[p] >= 128 ? 1 : 0
  }
  const dist = distanceTransform(binario, w, h)

  const grown = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const aa = Math.min(1, Math.max(0, strokePx + 0.75 - dist[i])) * 255
    grown[i] = Math.max(aa, alpha[i])
  }

  const baseData = Buffer.allocUnsafe(n * 4)
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    baseData[p] = 255
    baseData[p + 1] = 255
    baseData[p + 2] = 255
    baseData[p + 3] = grown[i]
  }
  const base = await sharp(baseData, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
  const foto = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer()
  return sharp(base).composite([{ input: foto }]).png().toBuffer()
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
 * Recorte 900×900: foto (já sem fundo) enquadrada e recortada na cápsula, com a borda
 * branca do modelo Photopea (silhueta expandida atrás — ver `bordaExpandida`).
 *
 * `borderPx=0` devolve o recorte LIMPO, sem borda — é o insumo que o picker guarda
 * (`{slot} recorte.png`) pra poder reeditar depois sem acumular borda em cima de borda;
 * a borda só entra na hora de montar a arte final, igual o pipeline Python
 * (`pipeline_prep` chama `--no-stroke`, a borda entra só no estágio 3).
 */
export async function renderRecorte(
  fotoSemFundo: Buffer,
  params: ParamsEnquadramento,
  uWidth = 600,
  reenquadrar = true,
  borderPx = 0,
): Promise<Buffer> {
  const posicionada = await fotoPosicionada(fotoSemFundo, params, {
    r: 0, g: 0, b: 0, alpha: 0,
  })
  const recortada = await aplicarMascara(posicionada, await mascaraRaw(capsulaSvg(uWidth)))
  const final = reenquadrar ? await reframe(recortada) : recortada
  return borderPx > 0 ? bordaExpandida(final, borderPx) : final
}

/**
 * Rosto 900×900: face cutout do PicWish (já sem fundo, sem moldura) enquadrado
 * e com a mesma borda branca do recorte (`bordaExpandida`). Diferente do
 * recorte, NÃO aplica cápsula — a silhueta é a do próprio face-cutout.
 *
 * `borderPx=0` devolve limpo (preview do editor / insumo reedital); a borda
 * entra na composta final, igual ao recorte.
 */
export async function renderFace(
  fotoFaceCutout: Buffer,
  params: ParamsEnquadramento,
  reenquadrar = true,
  borderPx = 0,
): Promise<Buffer> {
  const posicionada = await fotoPosicionada(fotoFaceCutout, params, {
    r: 0, g: 0, b: 0, alpha: 0,
  })
  const final = reenquadrar ? await reframe(posicionada) : posicionada
  return borderPx > 0 ? bordaExpandida(final, borderPx) : final
}

/**
 * Recorta no bbox real do alpha, escala pra tocar a margem no lado que
 * limita e recentraliza no 900×900 — faz o recorte manual sair
 * geometricamente igual ao automático. Paridade com `recorte_render.reframe`
 * / `recorte_silhueta._reframe_final`.
 *
 * ⚠️ Testado (2026-07-29) escalar por LARGURA-alvo em vez de max(pw,ph), pra
 * padronizar o footprint visual do recorte com o do coração. Revertido: pra
 * fotos verticais (o caso comum), a altura da CÁPSULA (fixa em 828px) satura
 * antes da largura — o teto de altura sempre domina, e o resultado sai
 * idêntico ao de hoje (medido com a peça real 316/slot2, adriellylara165:
 * 632×860 nos dois algoritmos). A largura final de um recorte é limitada pela
 * LARGURA DA CÁPSULA escolhida (uWidth) ANTES do reframe rodar — não tem como
 * o reframe inventar largura que a máscara já cortou fora sem esticar a
 * pessoa (distorcer). Se o objetivo é aproximar do footprint do coração, o
 * lugar certo é revisar o uWidth padrão/escolhido, não esta função.
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
