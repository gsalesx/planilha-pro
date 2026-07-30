/**
 * Monta a arte final do pijama SEM depender de PSD.
 *
 * Porte do render local em Python (repo "Criador de artes",
 * scripts/render_molde_local.py), que abria o molde .psd (160–190MB) só pra
 * ler a posição fixa dos smart objects. Essa geometria nunca muda, então foi
 * medida uma vez e virou as constantes abaixo — validada contra 4 PSDs reais
 * em 2026-07-27 (GG MASCULINO bateu 112/112 posições; M MASCULINO 111/112,
 * a divergência sendo jitter manual do próprio PSD).
 *
 * Entrada: fotos JÁ compostas (recorte/coração 900×900) e emojis 350×350 —
 * essa parte continua no Python porque depende de detecção de rosto e
 * remoção de fundo. Aqui é só "carimbar" no lugar certo.
 */
import sharp from 'sharp'

// ---- Geometria (medida nos PSDs; não alterar sem re-medir) ----
export const ROSTO = 900
export const EMOJI = 350
export const GAP = 201
export const ROW_PITCH = 950
/** Emoji é rebaixado dentro da linha (fica centralizado vs a foto). */
export const EMOJI_DY = 276
/** Padrão "tijolo": linha ímpar desloca. Valor escolhido pelo user 2026-07-27. */
export const STAGGER = -740
export const PASSO_FOTO = ROSTO + GAP // 1101
export const PASSO_EMOJI = EMOJI + GAP // 551

/** Faixa garantidamente só com a cor de fundo: entre o fim da Foto 1 e o
 *  início da Foto 2, acima do emoji. É onde vai o texto. */
export const FAIXA_LIMPA_W = PASSO_FOTO + EMOJI + GAP // 752
export const FAIXA_LIMPA_H = EMOJI_DY // 276

// ---- Texto de identificação (padronizado 2026-07-27) ----
const TEXT_COLOR = '#D4AF37'
/** Altura das maiúsculas em px (a maior das duas que existiam nos PSDs). */
const TEXT_CAP_H = 101
const TEXT_PAD_X = 40
const TEXT_PAD_Y = 40
/** Aproximação cap-height/font-size pra fontes bold comuns. */
const CAP_RATIO = 0.716

const ABREV_TIPO: Record<string, string> = {
  MASCULINO: 'MASC',
  FEMININO: 'FEM',
  CAMISOLA: 'VEST', // "vestido" — escolhido pelo user pra não ficar comprido
}

/** 'M MASCULINO' → 'M MASC' | 'G CAMISOLA' → 'G VEST' | CONJ mantém inteiro. */
export function labelDoMolde(molde: string): string {
  const partes = molde.trim().toUpperCase().split(/\s+/)
  if (partes.length === 2 && ABREV_TIPO[partes[1]]) {
    return `${partes[0]} ${ABREV_TIPO[partes[1]]}`
  }
  if (partes.length === 3 && ABREV_TIPO[partes[2]]) {
    // "6 ANOS MASCULINO" -> "6 ANOS MASC" (mesma abreviação do adulto,
    // preservando o tamanho infantil real no texto).
    return `${partes[0]} ${partes[1]} ${ABREV_TIPO[partes[2]]}`
  }
  return partes.join(' ')
}

/** true = molde com tamanho infantil (2/4/6/8/10/12 ANOS) — ver TamanhoInfantil
 *  em sku-rules.ts. Detecta pelo prefixo do nome do molde, ex "6 ANOS
 *  CONJ FEM", "6 ANOS MASCULINO" — não precisa de import cruzado com
 *  sku-rules.ts, só olha o texto. */
function ehMoldeInfantil(molde: string): boolean {
  return /^\d{1,2}\s*ANOS\b/.test(molde.trim().toUpperCase())
}

/** Canvas infantil: SEM medida própria ainda (2026-07-31, pedido do user) —
 *  usa M FEMININO como PLACEHOLDER pra qualquer tamanho/gênero/tipo infantil.
 *  Só a resolução física muda; o texto de identificação continua mostrando
 *  o tamanho REAL (labelDoMolde preserva "6 ANOS..." no nome do molde). */
const CANVAS_INFANTIL_PLACEHOLDER = 'M FEMININO'

/** Resolve o molde a usar pra CANVAS/tiling — infantil sempre cai no
 *  placeholder (CANVAS_INFANTIL_PLACEHOLDER); os demais usam o próprio nome.
 *  Conjunto infantil (ex "6 ANOS CONJ FEM") também usa o placeholder de
 *  painel único: não tem geometria de conjunto própria pro infantil ainda,
 *  então a arte infantil sai como painel único mesmo quando o pedido é
 *  CONJUNTO (até haver medida real, decisão do user 2026-07-31). */
export function moldeCanvasPlaceholder(molde: string): string {
  return ehMoldeInfantil(molde) ? CANVAS_INFANTIL_PLACEHOLDER : molde.trim().toUpperCase()
}

/** Tamanho da folha por molde. É o ÚNICO dado que muda entre moldes —
 *  molde novo = só acrescentar uma linha aqui. */
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

/** Um painel do conjunto (Frente/Manga/Short) — bbox absoluto no canvas do
 *  conjunto + a âncora de fase do tiling (posição de Rosto 1 na 1ª linha
 *  "par", isto é, não deslocada pelo STAGGER) medida DIRETO no PSD. Cada
 *  painel tem fase própria (não é a mesma fórmula de centralização do molde
 *  de painel único) — sem essa âncora não dá pra saber onde o padrão começa. */
export interface PainelConjunto {
  x: number
  y: number
  w: number
  h: number
  /** Posição do Rosto 1 na linha de referência (y relativo ao painel = anchorY). */
  anchorX: number
  anchorY: number
}

/**
 * Geometria dos moldes CONJ (multi-painel: Frente/Manga/Short no mesmo
 * canvas) — medida direto nos 8 PSDs `Moldes/{TAM} CONJ {FEM,MASC}.psd`
 * (psd-tools, 2026-07-30). O stagger/pitch do tiling são os MESMOS de
 * qualquer molde (STAGGER=-740, ROW_PITCH=950 — confirmado: os 3 painéis de
 * todos os 8 moldes batem com STAGGER exato; ROW_PITCH real de Frente/Manga
 * é ~967, mesmo tipo de jitter manual do PSD já visto em painel único —
 * ROW_PITCH=950 continua a fonte da verdade). Só a ÂNCORA (onde a linha
 * "não deslocada" começa) varia por painel — não dá pra derivar de uma
 * fórmula, por isso fica tabelada aqui.
 */
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

/** 'GG CONJ MASC' → 'GG MASCULINO' | 'P CONJ FEM' → 'P FEMININO' — nome do
 *  molde de painel único (short/calça normal) do mesmo tamanho/gênero. */
function moldeShortNormal(moldeConj: string): string {
  const partes = moldeConj.trim().toUpperCase().split(/\s+/) // ['GG','CONJ','MASC']
  const tamanho = partes[0]
  const genero = partes[2] === 'MASC' ? 'MASCULINO' : 'FEMININO'
  return `${tamanho} ${genero}`
}

/**
 * Canvas do painel "Short" do conjunto — NÃO usa o tamanho do PSD conjunto
 * (que é ligeiramente MAIOR que o short normal do mesmo tamanho/gênero:
 * medido 2026-07-31, até 15% maior no MASCULINO, até 7% no FEMININO).
 * Usa direto o CANVAS_POR_MOLDE do short normal correspondente — o mesmo
 * tiling (fotos/emojis, mesma âncora medida) é montado dentro desse canvas
 * menor, sem escalar nada depois (resize pós-processamento distorcia o
 * texto de identificação junto — bug reportado 2026-07-31).
 */
function canvasShortDoConjunto(moldeConj: string): { w: number; h: number } {
  return CANVAS_POR_MOLDE[moldeShortNormal(moldeConj)]
}

export interface RenderMoldeInput {
  /** Nome do molde, ex 'M MASCULINO'. Precisa existir em CANVAS_POR_MOLDE. */
  molde: string
  /** Cor de fundo em hex (#RRGGBB). */
  cor: string
  /** Fotos já compostas (900×900 com alpha). 1+ — define o N do padrão. */
  fotos: Buffer[]
  /** Emojis (350×350 com alpha). Mesma quantidade das fotos; se vier só 1,
   *  é reusado em todos os slots. */
  emojis: Buffer[]
  /** Sobrescreve o canvas (usado pelos painéis do conjunto). */
  canvas?: { w: number; h: number }
  /** Sobrescreve o texto (default = derivado do nome do molde). */
  label?: string
  qualidade?: number
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
  return { itens, unitW: dx } // unitW = nFotos * 1652
}

/** Quantas repetições do padrão o print 4×4 mostra (base do enquadramento, antes do
 *  fator de afastamento — ver `PRINT_ZOOM_FATOR`). 3 é o que o pipeline local usa. */
export const PRINT_REPETICOES = 3
/** Proporção 10:7 (paisagem) — escolhida pelo user em teste local 2026-07-29,
 *  comparando lado a lado contra o quadrado 1500×1500 usado antes. */
export const PRINT_LARGURA = 2000
export const PRINT_ALTURA = 1400
/** "Afasta um pouco pra pegar mais imagens" (pedido do user) — multiplica o crop
 *  base em 30%, mantendo a proporção 10:7. Comparado contra 1.6x/2.0x em teste
 *  local; 1.3x foi o escolhido. */
export const PRINT_ZOOM_FATOR = 1.3
/** Desloca o centro do recorte pro lado em vez de ficar exatamente centralizado —
 *  pedido do user ("fazer o print um pouco pro lado do que pega hoje"), escolhido
 *  entre 300/600/900px em teste local. */
export const PRINT_DESLOCAMENTO_X = 600

/**
 * Print — a prévia que aparece na planilha e vai pro chat do cliente.
 *
 * É um RECORTE da arte já montada, nunca uma miniatura remontada do zero: tentar
 * sintetizar o padrão deu resultado visualmente errado no pipeline local, porque a folha
 * real é um "tijolo" (linhas alternadas deslocadas), não um grid alinhado. Recortando a
 * arte de verdade, o que o cliente vê é exatamente o que vai ser impresso.
 *
 * O tamanho-base do recorte vem da geometria real do molde (repetições da unidade
 * horizontal e da altura de linha), depois ampliado por `PRINT_ZOOM_FATOR` e deslocado
 * lateralmente por `PRINT_DESLOCAMENTO_X` — os três valores vieram de comparação visual
 * direta em `_test/testes sem psd/teste previa/` (arquivos G_deslocado_600px_2000x1400
 * em diante), não são chute.
 */
export async function gerarPrint4x4(arteJpg: Buffer, nFotos: number): Promise<Buffer> {
  const { unitW } = layoutLinha(Math.max(1, nFotos))
  const meta = await sharp(arteJpg).metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  if (!W || !H) throw new Error('print: arte sem dimensões')

  // Altura-base = a mesma lógica de antes (quadrado limitado pelas duas geometrias),
  // multiplicada pelo fator de afastamento; largura vem da PROPORÇÃO alvo (não mais
  // igual à altura) — é o que torna o crop 10:7 em vez de quadrado.
  const alturaBase = Math.min(PRINT_REPETICOES * unitW, PRINT_REPETICOES * ROW_PITCH, W, H)
  const cropH = Math.min(Math.round(alturaBase * PRINT_ZOOM_FATOR), H)
  const cropW = Math.min(Math.round(cropH * (PRINT_LARGURA / PRINT_ALTURA)), W)

  const centroX = Math.round((W - cropW) / 2)
  const left = Math.max(0, Math.min(centroX + PRINT_DESLOCAMENTO_X, W - cropW))
  const top = Math.max(0, Math.round((H - cropH) / 2))

  return sharp(arteJpg)
    .extract({ left, top, width: cropW, height: cropH })
    .resize(PRINT_LARGURA, PRINT_ALTURA, { fit: 'fill' })
    .jpeg({ quality: 86 })
    .toBuffer()
}

function hexParaRgb(hex: string): { r: number; g: number; b: number } {
  const limpo = hex.replace('#', '').trim()
  const full = limpo.length === 3 ? limpo.split('').map((c) => c + c).join('') : limpo
  const n = Number.parseInt(full, 16)
  if (!Number.isFinite(n) || full.length !== 6) return { r: 0, g: 0, b: 0 }
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string),
  )
}

/** Texto como SVG (sharp não desenha texto direto). Precisa de fonte bold
 *  instalada no container — ver nota no Dockerfile (ttf-dejavu). */
function svgTexto(label: string): { svg: Buffer; w: number; h: number } {
  const fontSize = Math.round(TEXT_CAP_H / CAP_RATIO)
  // largura generosa: o SVG é transparente, sobra não atrapalha
  const w = Math.ceil(label.length * fontSize * 0.75) + 20
  const h = fontSize * 2
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <text x="0" y="${TEXT_CAP_H}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif"
          font-weight="bold" font-size="${fontSize}" fill="${TEXT_COLOR}"
          xml:space="preserve">${escapeXml(label)}</text>
  </svg>`
  return { svg: Buffer.from(svg), w, h }
}

/** Normaliza fotos/emojis pro tamanho exato do slot (1:1 no molde original). */
async function normalizarSlots(
  fotos: Buffer[],
  emojis: Buffer[],
): Promise<{ fotosNorm: Buffer[]; emojiPara: (i: number) => Buffer | null }> {
  const fotosNorm = await Promise.all(
    fotos.map((b) => sharp(b).resize(ROSTO, ROSTO, { fit: 'fill' }).png().toBuffer()),
  )
  const emojisNorm = await Promise.all(
    emojis.map((b) => sharp(b).resize(EMOJI, EMOJI, { fit: 'fill' }).png().toBuffer()),
  )
  // Lista vazia = pedido SEM EMOJI de propósito (emojiPara nunca "acerta"
  // nesse caso — ver o `if (!buf) continue` em quem consome).
  const emojiPara = (i: number): Buffer | null =>
    emojisNorm.length === 0 ? null : emojisNorm[i] ?? emojisNorm[0]
  return { fotosNorm, emojiPara }
}

/**
 * Tileia o padrão Foto/Emoji dentro de uma área retangular (painel ou canvas
 * inteiro) e empilha as camadas em `camadas` (coordenadas ABSOLUTAS — soma
 * `offsetX/offsetY` do painel). `x0/y0` é a âncora da fase do PADRÃO de
 * fotos/emojis: a posição do 1º item da linha "par" (não deslocada pelo
 * STAGGER) — no painel único isso é calculado centralizando no canvas; no
 * conjunto vem medido do PSD (cada painel tem fase própria, ver
 * CONJUNTO_POR_MOLDE). Essa âncora é só do TILING — o texto de identificação
 * NÃO usa mais essa posição (ver svgTexto/desenharLabel): fica sempre fixo
 * no canto superior-esquerdo do painel, independente de onde o padrão de
 * fotos começa. Bug corrigido 2026-07-31: no painel "Manga" do conjunto, a
 * âncora medida do PSD cai no MEIO do painel (não no canto), e o texto
 * herdava essa posição — saía "no meio da manga" em vez de canto superior
 * esquerdo como nos demais moldes.
 */
function tileFotos(opts: {
  camadas: sharp.OverlayOptions[]
  offsetX: number
  offsetY: number
  w: number
  h: number
  x0: number
  y0: number
  itens: Item[]
  unitW: number
  fotosNorm: Buffer[]
  emojiPara: (i: number) => Buffer | null
}): void {
  const { camadas, offsetX, offsetY, w, h, x0, y0, itens, unitW, fotosNorm, emojiPara } = opts
  // Varre da 1ª linha "par" (y0) pra cima e pra baixo, cobrindo toda a altura
  // do painel — y0 pode ser >0 (ver painéis Manga/Frente medidos no PSD).
  const yInicio = y0 - Math.ceil((y0 + ROW_PITCH) / ROW_PITCH) * ROW_PITCH
  for (let y = yInicio; y < h; y += ROW_PITCH) {
    const linha = Math.round((y - y0) / ROW_PITCH)
    const deslocada = Math.abs(linha % 2) === 1
    const xInicioLinha = x0 + (deslocada ? STAGGER : 0)
    const xInicio = xInicioLinha - Math.ceil((xInicioLinha + unitW) / unitW) * unitW
    for (let x = xInicio; x < w; x += unitW) {
      for (const item of itens) {
        const buf = item.tipo === 'foto' ? fotosNorm[item.indice] : emojiPara(item.indice)
        if (!buf) continue // SEM EMOJI: pula a camada, sem tentar compositar undefined
        const dy = item.tipo === 'foto' ? 0 : EMOJI_DY
        camadas.push({ input: buf, left: offsetX + x + item.dx, top: offsetY + y + dy })
      }
    }
  }
}

/**
 * Monta a folha e devolve o JPG (300 DPI — sem isso a impressora assume ~72
 * e a arte sai ~4× maior; bug já pego no pipeline Python em 2026-05-30).
 */
export async function renderMolde(input: RenderMoldeInput): Promise<Buffer> {
  const { molde, cor, fotos, emojis } = input
  if (fotos.length === 0) throw new Error('renderMolde: nenhuma foto')

  const canvas = input.canvas ?? CANVAS_POR_MOLDE[moldeCanvasPlaceholder(molde)]
  if (!canvas) throw new Error(`renderMolde: canvas desconhecido pro molde "${molde}"`)
  const { w: W, h: H } = canvas

  const n = fotos.length
  const { itens, unitW } = layoutLinha(n)
  const { fotosNorm, emojiPara } = await normalizarSlots(fotos, emojis)

  // Centraliza a fase do padrão no canvas (o x0 do PSD legado era arbitrário).
  // Math.floor do valor JÁ negativo (não negar depois): é o que casa com a
  // divisão com piso do Python e mantém as duas saídas idênticas ao pixel.
  const x0 = Math.floor(-(unitW - (W % unitW)) / 2)

  const camadas: sharp.OverlayOptions[] = []
  tileFotos({
    camadas, offsetX: 0, offsetY: 0, w: W, h: H, x0, y0: 0, itens, unitW, fotosNorm, emojiPara,
  })

  // Canto superior-esquerdo do canvas, SEMPRE — independente de onde o
  // padrão de fotos começa (ver nota em tileFotos).
  const label = input.label ?? labelDoMolde(molde)
  if (label) {
    const { svg } = svgTexto(label)
    camadas.push({ input: svg, left: TEXT_PAD_X, top: TEXT_PAD_Y })
  }

  return sharp({
    create: { width: W, height: H, channels: 3, background: hexParaRgb(cor) },
  })
    .composite(camadas)
    .withMetadata({ density: 300 })
    .jpeg({ quality: input.qualidade ?? 90 })
    .toBuffer()
}

export interface RenderConjuntoInput {
  /** Nome do molde CONJ, ex 'GG CONJ MASC'. Precisa existir em CONJUNTO_POR_MOLDE. */
  molde: string
  cor: string
  fotos: Buffer[]
  emojis: Buffer[]
  qualidade?: number
}

/**
 * Monta os 3 painéis do conjunto (Frente/Manga/Short) — cada um exportado
 * como JPG separado, igual ao pipeline Python (`_export_conjunto`). O padrão
 * de tiling é o MESMO em todo painel (STAGGER/ROW_PITCH), só a âncora de
 * fase muda (medida por painel, ver CONJUNTO_POR_MOLDE).
 */
export async function renderConjunto(
  input: RenderConjuntoInput,
): Promise<Array<{ painel: string; jpg: Buffer }>> {
  const { molde, cor, fotos, emojis } = input
  if (fotos.length === 0) throw new Error('renderConjunto: nenhuma foto')

  const def = CONJUNTO_POR_MOLDE[molde.trim().toUpperCase()]
  if (!def) throw new Error(`renderConjunto: conjunto desconhecido pro molde "${molde}"`)

  const n = fotos.length
  const { itens, unitW } = layoutLinha(n)
  const { fotosNorm, emojiPara } = await normalizarSlots(fotos, emojis)
  const label = labelDoMolde(molde)
  const cmyk = hexParaRgb(cor)

  const saidas: Array<{ painel: string; jpg: Buffer }> = []
  for (const [nomePainel, p] of Object.entries(def.paineis)) {
    // Short: usa o canvas do short NORMAL (menor que o do PSD conjunto — ver
    // canvasShortDoConjunto) — mesma âncora medida, só o canvas ao redor
    // muda, então o tiling tileia igual e corta na borda menor, sem precisar
    // escalar nada depois (evita distorcer o texto de identificação, que
    // sempre sai no tamanho fixo padrão TEXT_CAP_H).
    const canvasPainel = nomePainel === 'Short' ? canvasShortDoConjunto(molde) : { w: p.w, h: p.h }

    const camadas: sharp.OverlayOptions[] = []
    tileFotos({
      camadas,
      offsetX: 0,
      offsetY: 0,
      w: canvasPainel.w,
      h: canvasPainel.h,
      x0: p.anchorX,
      y0: p.anchorY,
      itens,
      unitW,
      fotosNorm,
      emojiPara,
    })
    // Canto superior-esquerdo do PAINEL — cada painel (Frente/Manga/Short) é
    // uma imagem própria, então o texto sempre fica no canto dela, sempre no
    // mesmo tamanho fixo (TEXT_CAP_H) — nenhuma escala pós-processamento.
    if (label) {
      const { svg } = svgTexto(label)
      camadas.push({ input: svg, left: TEXT_PAD_X, top: TEXT_PAD_Y })
    }

    const jpg = await sharp({
      create: { width: canvasPainel.w, height: canvasPainel.h, channels: 3, background: cmyk },
    })
      .composite(camadas)
      .withMetadata({ density: 300 })
      .jpeg({ quality: input.qualidade ?? 90 })
      .toBuffer()
    saidas.push({ painel: nomePainel, jpg })
  }
  return saidas
}
