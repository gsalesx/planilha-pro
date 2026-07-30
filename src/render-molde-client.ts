/**
 * Monta a arte final do pijama NO NAVEGADOR — porte de
 * `server/src/render-molde.ts` pra Canvas 2D.
 *
 * Por quê: montar a folha inteira (até 9277×6382px, centenas de camadas de
 * foto/emoji) no servidor levava ~14s medidos numa peça real (2026-07-29) —
 * pesado o bastante pra competir por CPU com outras operações no mesmo
 * container e deixar TUDO mais lento (inclusive abrir o picker de outra
 * pessoa). A montagem é só posicionar imagens já prontas (900×900 e 350×350,
 * sem escala/máscara/borda — isso já vem pronto do servidor) + escrever um
 * texto — exatamente o que `<canvas>` faz nativamente. Rodando aqui, o custo
 * cai na máquina de quem clicou, não no servidor compartilhado.
 *
 * Geometria idêntica à do servidor (mesmas constantes, mesmo `layoutLinha`) —
 * validada contra 4 PSDs reais em 2026-07-27. NÃO alterar sem re-medir.
 */

// ---- Geometria (medida nos PSDs; não alterar sem re-medir) ----
export const ROSTO = 900
export const EMOJI = 350
export const GAP = 201
export const ROW_PITCH = 950
export const EMOJI_DY = 276
export const STAGGER = -740
export const PASSO_FOTO = ROSTO + GAP // 1101
export const PASSO_EMOJI = EMOJI + GAP // 551

// ---- Texto de identificação (padronizado 2026-07-27) ----
const TEXT_COLOR = '#D4AF37'
const TEXT_CAP_H = 101
const TEXT_PAD_X = 40
const TEXT_PAD_Y = 40
const CAP_RATIO = 0.716

const ABREV_TIPO: Record<string, string> = {
  MASCULINO: 'MASC',
  FEMININO: 'FEM',
  CAMISOLA: 'VEST',
}

/** 'M MASCULINO' → 'M MASC' | 'G CAMISOLA' → 'G VEST' | CONJ mantém inteiro. */
export function labelDoMolde(molde: string): string {
  const partes = molde.trim().toUpperCase().split(/\s+/)
  if (partes.length === 2 && ABREV_TIPO[partes[1]]) {
    return `${partes[0]} ${ABREV_TIPO[partes[1]]}`
  }
  return partes.join(' ')
}

/** Tamanho da folha por molde — mesma tabela do servidor (render-molde.ts). */
export const CANVAS_POR_MOLDE: Record<string, { w: number; h: number }> = {
  'P MASCULINO': { w: 9145, h: 5784 },
  'M MASCULINO': { w: 9145, h: 5784 },
  'G MASCULINO': { w: 9259, h: 6140 },
  'GG MASCULINO': { w: 9277, h: 6382 },
  'P FEMININO': { w: 8859, h: 4963 },
  'M FEMININO': { w: 8859, h: 4963 },
  'G FEMININO': { w: 9089, h: 5433 },
  'GG FEMININO': { w: 9682, h: 5549 },
  'P CAMISOLA': { w: 7324, h: 8269 },
  'M CAMISOLA': { w: 7324, h: 8269 },
  'G CAMISOLA': { w: 7560, h: 8505 },
  'GG CAMISOLA': { w: 7678, h: 8741 },
}

/** Um painel do conjunto — mesma tabela do servidor (render-molde.ts). */
export interface PainelConjunto {
  x: number
  y: number
  w: number
  h: number
  anchorX: number
  anchorY: number
}

/** Geometria dos moldes CONJ — mesma tabela do servidor, medida direto nos
 *  PSDs (ver render-molde.ts para a explicação completa). */
export const CONJUNTO_POR_MOLDE: Record<string, { canvas: { w: number; h: number }; paineis: Record<string, PainelConjunto> }> = {
  'P CONJ MASC': {
    canvas: { w: 19115, h: 11387 },
    paineis: {
      Short: { x: 8958, y: 0, w: 10157, h: 6496, anchorX: 2832, anchorY: 0 },
      Frente: { x: 0, y: 20, w: 6733, h: 9333, anchorX: 5, anchorY: 0 },
      Manga: { x: 8954, y: 8434, w: 5433, h: 2953, anchorX: 2592, anchorY: 372 },
    },
  },
  'M CONJ MASC': {
    canvas: { w: 19115, h: 11387 },
    paineis: {
      Short: { x: 8958, y: 0, w: 10157, h: 6496, anchorX: 2832, anchorY: 0 },
      Frente: { x: 0, y: 20, w: 6733, h: 9333, anchorX: 5, anchorY: 0 },
      Manga: { x: 8954, y: 8434, w: 5433, h: 2953, anchorX: 2592, anchorY: 372 },
    },
  },
  'G CONJ MASC': {
    canvas: { w: 19115, h: 11387 },
    paineis: {
      Short: { x: 8839, y: 0, w: 10276, h: 6735, anchorX: 2951, anchorY: 0 },
      Frente: { x: 0, y: 20, w: 6970, h: 9452, anchorX: 5, anchorY: 0 },
      Manga: { x: 8478, y: 8197, w: 6027, h: 3190, anchorX: 3068, anchorY: 625 },
    },
  },
  'GG CONJ MASC': {
    canvas: { w: 19115, h: 11387 },
    paineis: {
      Short: { x: 8481, y: 0, w: 10634, h: 7200, anchorX: 5, anchorY: 0 },
      Frente: { x: 0, y: 20, w: 7350, h: 9831, anchorX: 5, anchorY: 0 },
      Manga: { x: 8478, y: 7889, w: 6297, h: 3498, anchorX: 3068, anchorY: 933 },
    },
  },
  'P CONJ FEM': {
    canvas: { w: 19115, h: 11387 },
    paineis: {
      Short: { x: 10138, y: 0, w: 8977, h: 5315, anchorX: 1652, anchorY: 0 },
      Frente: { x: 0, y: 20, w: 5907, h: 7914, anchorX: 5, anchorY: 0 },
      Manga: { x: 9544, y: 8789, w: 4843, h: 2598, anchorX: 2002, anchorY: 33 },
    },
  },
  'M CONJ FEM': {
    canvas: { w: 19115, h: 11387 },
    paineis: {
      Short: { x: 10138, y: 0, w: 8977, h: 5315, anchorX: 1652, anchorY: 0 },
      Frente: { x: 0, y: 20, w: 5907, h: 7914, anchorX: 5, anchorY: 0 },
      Manga: { x: 9544, y: 8789, w: 4843, h: 2598, anchorX: 2002, anchorY: 33 },
    },
  },
  'G CONJ FEM': {
    canvas: { w: 19115, h: 11387 },
    paineis: {
      Short: { x: 9429, y: 0, w: 9686, h: 5552, anchorX: 2361, anchorY: 0 },
      Frente: { x: 0, y: 20, w: 6143, h: 8268, anchorX: 5, anchorY: 0 },
      Manga: { x: 9308, y: 8788, w: 4844, h: 2599, anchorX: 2238, anchorY: 34 },
    },
  },
  'GG CONJ FEM': {
    canvas: { w: 19115, h: 11387 },
    paineis: {
      Short: { x: 9429, y: 0, w: 9686, h: 5552, anchorX: 2361, anchorY: 0 },
      Frente: { x: 0, y: 20, w: 6379, h: 8504, anchorX: 5, anchorY: 0 },
      Manga: { x: 9072, y: 8552, w: 5315, h: 2835, anchorX: 2474, anchorY: 270 },
    },
  },
}

interface Item {
  tipo: 'foto' | 'emoji'
  indice: number
  dx: number
}

/** Layout de uma linha: Foto1, Emoji1, Foto2, Emoji2, … e a largura da unidade. */
export function layoutLinha(nFotos: number): { itens: Item[]; unitW: number } {
  const itens: Item[] = []
  let dx = 0
  for (let i = 0; i < nFotos; i++) {
    itens.push({ tipo: 'foto', indice: i, dx })
    dx += PASSO_FOTO
    itens.push({ tipo: 'emoji', indice: i, dx })
    dx += PASSO_EMOJI
  }
  return { itens, unitW: dx }
}

export const PRINT_REPETICOES = 3
export const PRINT_LARGURA = 2000
export const PRINT_ALTURA = 1400
export const PRINT_ZOOM_FATOR = 1.3
export const PRINT_DESLOCAMENTO_X = 600

export interface RenderMoldeInput {
  molde: string
  /** Cor de fundo em hex (#RRGGBB). */
  cor: string
  /** Fotos já compostas (900×900, PNG/blob já carregado como imagem). */
  fotos: HTMLImageElement[] | ImageBitmap[]
  /** Emojis (350×350). Se vier só 1, reusado nos dois slots. */
  emojis: HTMLImageElement[] | ImageBitmap[]
  canvas?: { w: number; h: number }
  label?: string
  qualidade?: number
}

/** Carrega uma URL/blob como HTMLImageElement — mesma função usada no picker-editor. */
export function carregarImagem(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`falha ao carregar imagem: ${url}`))
    img.src = url
  })
}

type ImagemFonte = HTMLImageElement | ImageBitmap

/**
 * Tileia o padrão Foto/Emoji dentro de uma área (painel ou canvas inteiro) e
 * desenha direto no ctx (coordenadas ABSOLUTAS: soma offsetX/offsetY). `x0/y0`
 * é a âncora da fase — no painel único vem da fórmula de centralização, no
 * conjunto vem medida do PSD (ver CONJUNTO_POR_MOLDE, cada painel tem fase
 * própria). Mesma lógica de `tileFotos` do servidor (render-molde.ts).
 */
function tileFotosCanvas(opts: {
  ctx: CanvasRenderingContext2D
  offsetX: number
  offsetY: number
  w: number
  h: number
  x0: number
  y0: number
  itens: Item[]
  unitW: number
  fotos: ImagemFonte[]
  emojiPara: (i: number) => ImagemFonte | undefined
}): { x: number; y: number } | null {
  const { ctx, offsetX, offsetY, w, h, x0, y0, itens, unitW, fotos, emojiPara } = opts
  let ancora: { x: number; y: number } | null = null
  const yInicio = y0 - Math.ceil((y0 + ROW_PITCH) / ROW_PITCH) * ROW_PITCH
  for (let y = yInicio; y < h; y += ROW_PITCH) {
    const linha = Math.round((y - y0) / ROW_PITCH)
    const deslocada = Math.abs(linha % 2) === 1
    const xInicioLinha = x0 + (deslocada ? STAGGER : 0)
    const xInicio = xInicioLinha - Math.ceil((xInicioLinha + unitW) / unitW) * unitW
    for (let x = xInicio; x < w; x += unitW) {
      for (const item of itens) {
        const buf = item.tipo === 'foto' ? fotos[item.indice] : emojiPara(item.indice)
        const tam = item.tipo === 'foto' ? ROSTO : EMOJI
        const dy = item.tipo === 'foto' ? 0 : EMOJI_DY
        if (buf) ctx.drawImage(buf, offsetX + x + item.dx, offsetY + y + dy, tam, tam)
      }
      if (!ancora && y === y0 && x === x0) ancora = { x: offsetX + x + ROSTO, y: offsetY + y }
    }
  }
  return ancora
}

function desenharLabel(ctx: CanvasRenderingContext2D, label: string, ancora: { x: number; y: number }): void {
  const fontSize = Math.round(TEXT_CAP_H / CAP_RATIO)
  ctx.fillStyle = TEXT_COLOR
  ctx.font = `bold ${fontSize}px "DejaVu Sans", Arial, Helvetica, sans-serif`
  ctx.textBaseline = 'alphabetic'
  // O SVG do servidor desenha a partir de y=TEXT_CAP_H (baseline); canvas
  // fillText também usa baseline por padrão — mesma referência.
  ctx.fillText(label, ancora.x + TEXT_PAD_X, ancora.y + TEXT_PAD_Y + TEXT_CAP_H)
}

function canvasParaBlob(canvas: HTMLCanvasElement, qualidade = 90): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('falha ao gerar JPEG'))),
      'image/jpeg',
      qualidade / 100,
    )
  })
}

/**
 * Monta a folha inteira num canvas e devolve como JPEG (Blob). Mesma lógica
 * de tiling do servidor (`renderMolde`), com `ctx.drawImage` no lugar de
 * `sharp.composite` — cada foto/emoji já vem pronto (900×900/350×350), então
 * isto é só posicionamento, sem resize/máscara/borda (essas etapas continuam
 * no servidor, ao salvar o ajuste no picker).
 */
export async function montarArteCanvas(input: RenderMoldeInput): Promise<Blob> {
  const { molde, cor, fotos, emojis } = input
  if (fotos.length === 0) throw new Error('montarArteCanvas: nenhuma foto')

  const canvasSize = input.canvas ?? CANVAS_POR_MOLDE[molde.trim().toUpperCase()]
  if (!canvasSize) throw new Error(`montarArteCanvas: canvas desconhecido pro molde "${molde}"`)
  const { w: W, h: H } = canvasSize

  const n = fotos.length
  const { itens, unitW } = layoutLinha(n)
  const emojiPara = (i: number) => emojis[i] ?? emojis[0]

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'

  ctx.fillStyle = cor || '#000000'
  ctx.fillRect(0, 0, W, H)

  // Math.floor do valor JÁ negativo (não negar depois) — paridade com o servidor
  // (e com o pipeline Python original), mantém as 3 saídas idênticas ao pixel.
  const x0 = Math.floor(-(unitW - (W % unitW)) / 2)

  const ancora = tileFotosCanvas({
    ctx, offsetX: 0, offsetY: 0, w: W, h: H, x0, y0: 0, itens, unitW, fotos, emojiPara,
  })

  const label = input.label ?? labelDoMolde(molde)
  if (label && ancora) desenharLabel(ctx, label, ancora)

  return canvasParaBlob(canvas, input.qualidade)
}

export interface RenderConjuntoInput {
  /** Nome do molde CONJ, ex 'GG CONJ MASC'. Precisa existir em CONJUNTO_POR_MOLDE. */
  molde: string
  cor: string
  fotos: ImagemFonte[]
  emojis: ImagemFonte[]
  qualidade?: number
}

/**
 * Monta os 3 painéis do conjunto (Frente/Manga/Short) — cada um como um Blob
 * JPEG separado (mesmo tiling do servidor, ver renderConjunto/render-molde.ts
 * pra explicação completa da geometria por painel).
 */
export async function montarConjuntoCanvas(
  input: RenderConjuntoInput,
): Promise<Array<{ painel: string; blob: Blob }>> {
  const { molde, cor, fotos, emojis } = input
  if (fotos.length === 0) throw new Error('montarConjuntoCanvas: nenhuma foto')

  const def = CONJUNTO_POR_MOLDE[molde.trim().toUpperCase()]
  if (!def) throw new Error(`montarConjuntoCanvas: conjunto desconhecido pro molde "${molde}"`)

  const n = fotos.length
  const { itens, unitW } = layoutLinha(n)
  const emojiPara = (i: number) => emojis[i] ?? emojis[0]
  const label = labelDoMolde(molde)

  const saidas: Array<{ painel: string; blob: Blob }> = []
  for (const [nomePainel, p] of Object.entries(def.paineis)) {
    const canvas = document.createElement('canvas')
    canvas.width = p.w
    canvas.height = p.h
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.fillStyle = cor || '#000000'
    ctx.fillRect(0, 0, p.w, p.h)

    const ancora = tileFotosCanvas({
      ctx, offsetX: 0, offsetY: 0, w: p.w, h: p.h, x0: p.anchorX, y0: p.anchorY, itens, unitW, fotos, emojiPara,
    })
    if (label && ancora) desenharLabel(ctx, label, ancora)

    saidas.push({ painel: nomePainel, blob: await canvasParaBlob(canvas, input.qualidade) })
  }
  return saidas
}

/**
 * Print — recorte da arte já montada (mesma lógica de `gerarPrint4x4` do
 * servidor, com `drawImage` fazendo o crop+resize).
 */
export async function cortarPrintCanvas(arteBlob: Blob, nFotos: number): Promise<Blob> {
  const { unitW } = layoutLinha(Math.max(1, nFotos))
  const url = URL.createObjectURL(arteBlob)
  let img: HTMLImageElement
  try {
    img = await carregarImagem(url)
  } finally {
    URL.revokeObjectURL(url)
  }
  const W = img.naturalWidth
  const H = img.naturalHeight
  if (!W || !H) throw new Error('print: arte sem dimensões')

  const alturaBase = Math.min(PRINT_REPETICOES * unitW, PRINT_REPETICOES * ROW_PITCH, W, H)
  const cropH = Math.min(Math.round(alturaBase * PRINT_ZOOM_FATOR), H)
  const cropW = Math.min(Math.round(cropH * (PRINT_LARGURA / PRINT_ALTURA)), W)

  const centroX = Math.round((W - cropW) / 2)
  const left = Math.max(0, Math.min(centroX + PRINT_DESLOCAMENTO_X, W - cropW))
  const top = Math.max(0, Math.round((H - cropH) / 2))

  const canvas = document.createElement('canvas')
  canvas.width = PRINT_LARGURA
  canvas.height = PRINT_ALTURA
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, left, top, cropW, cropH, 0, 0, PRINT_LARGURA, PRINT_ALTURA)

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('falha ao gerar print'))),
      'image/jpeg',
      0.86,
    )
  })
}
