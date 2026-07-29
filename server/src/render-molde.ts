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
  return partes.join(' ')
}

/** Tamanho da folha por molde. É o ÚNICO dado que muda entre moldes —
 *  molde novo = só acrescentar uma linha aqui. */
export const CANVAS_POR_MOLDE: Record<string, { w: number; h: number }> = {
  'M MASCULINO': { w: 9145, h: 5784 },
  'P FEMININO': { w: 8859, h: 4963 },
  'G MASCULINO': { w: 9259, h: 6140 },
  'GG MASCULINO': { w: 9277, h: 6382 },
  'G CAMISOLA': { w: 7560, h: 8505 },
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

/** Quantas repetições do padrão o print 4×4 mostra. 3 é o que o pipeline local usa. */
export const PRINT_REPETICOES = 3
/** Lado do print entregue (px). O original tem ~2850 e pesa demais pra uma prévia. */
export const PRINT_LADO = 1500

/**
 * Print 4×4 — a prévia que aparece na planilha e vai pro chat do cliente.
 *
 * É um RECORTE da arte já montada, nunca uma miniatura remontada do zero: tentar
 * sintetizar o padrão deu resultado visualmente errado no pipeline local, porque a folha
 * real é um "tijolo" (linhas alternadas deslocadas), não um grid alinhado. Recortando a
 * arte de verdade, o que o cliente vê é exatamente o que vai ser impresso.
 *
 * O tamanho do recorte vem da geometria real do molde: `PRINT_REPETICOES` repetições da
 * unidade horizontal e da altura de linha. Quadrado, pegando do centro.
 */
export async function gerarPrint4x4(arteJpg: Buffer, nFotos: number): Promise<Buffer> {
  const { unitW } = layoutLinha(Math.max(1, nFotos))
  const meta = await sharp(arteJpg).metadata()
  const W = meta.width ?? 0
  const H = meta.height ?? 0
  if (!W || !H) throw new Error('print: arte sem dimensões')

  // Quadrado: o menor entre as duas geometrias, limitado pela arte (molde pequeno pode
  // ser menor que 3 repetições — aí o print é a arte inteira, sem esticar).
  const lado = Math.min(PRINT_REPETICOES * unitW, PRINT_REPETICOES * ROW_PITCH, W, H)
  const left = Math.max(0, Math.round((W - lado) / 2))
  const top = Math.max(0, Math.round((H - lado) / 2))

  return sharp(arteJpg)
    .extract({ left, top, width: lado, height: lado })
    .resize(PRINT_LADO, PRINT_LADO, { fit: 'fill' })
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

/**
 * Monta a folha e devolve o JPG (300 DPI — sem isso a impressora assume ~72
 * e a arte sai ~4× maior; bug já pego no pipeline Python em 2026-05-30).
 */
export async function renderMolde(input: RenderMoldeInput): Promise<Buffer> {
  const { molde, cor, fotos, emojis } = input
  if (fotos.length === 0) throw new Error('renderMolde: nenhuma foto')

  const canvas = input.canvas ?? CANVAS_POR_MOLDE[molde.trim().toUpperCase()]
  if (!canvas) throw new Error(`renderMolde: canvas desconhecido pro molde "${molde}"`)
  const { w: W, h: H } = canvas

  const n = fotos.length
  const { itens, unitW } = layoutLinha(n)

  // Normaliza os PNGs pro tamanho exato do slot (1:1 no molde original).
  const fotosNorm = await Promise.all(
    fotos.map((b) => sharp(b).resize(ROSTO, ROSTO, { fit: 'fill' }).png().toBuffer()),
  )
  const emojisNorm = await Promise.all(
    emojis.map((b) => sharp(b).resize(EMOJI, EMOJI, { fit: 'fill' }).png().toBuffer()),
  )
  const emojiPara = (i: number) => emojisNorm[i] ?? emojisNorm[0]

  // Centraliza a fase do padrão no canvas (o x0 do PSD legado era arbitrário).
  // Math.floor do valor JÁ negativo (não negar depois): é o que casa com a
  // divisão com piso do Python e mantém as duas saídas idênticas ao pixel.
  const x0 = Math.floor(-(unitW - (W % unitW)) / 2)

  const camadas: sharp.OverlayOptions[] = []
  let ancora: { x: number; y: number } | null = null

  // Começa 1 linha acima pra cobrir a borda de cima. A paridade vem do índice
  // derivado do y, então y=0 é SEMPRE linha par (não deslocada) — é o que
  // torna a posição do texto determinística.
  for (let y = -ROW_PITCH; y < H; y += ROW_PITCH) {
    const linha = Math.round(y / ROW_PITCH)
    const deslocada = Math.abs(linha % 2) === 1
    for (let x = x0 + (deslocada ? STAGGER : 0) - unitW; x < W; x += unitW) {
      for (const item of itens) {
        const buf = item.tipo === 'foto' ? fotosNorm[item.indice] : emojiPara(item.indice)
        const dy = item.tipo === 'foto' ? 0 : EMOJI_DY
        camadas.push({ input: buf, left: x + item.dx, top: y + dy })
      }
      if (!ancora && y === 0 && x + ROSTO >= 0) ancora = { x: x + ROSTO, y }
    }
  }

  const label = input.label ?? labelDoMolde(molde)
  if (label && ancora) {
    const { svg } = svgTexto(label)
    camadas.push({ input: svg, left: ancora.x + TEXT_PAD_X, top: ancora.y + TEXT_PAD_Y })
  }

  return sharp({
    create: { width: W, height: H, channels: 3, background: hexParaRgb(cor) },
  })
    .composite(camadas)
    .withMetadata({ density: 300 })
    .jpeg({ quality: input.qualidade ?? 90 })
    .toBuffer()
}
