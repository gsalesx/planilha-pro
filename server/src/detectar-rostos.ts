/**
 * Detecção de rosto pro relatório de ajustes — dois motores, mesmo formato de saída:
 *
 *  - SCRFD-10G (InsightFace buffalo_l/det_10g): o melhor em perfil, beijo, rosto pequeno
 *    e o 2º rosto de casal — foi o escolhido no pipeline Python antigo. Licença dos pesos:
 *    pesquisa não comercial (decisão do dono do projeto); por isso NÃO vai pro git
 *    (repo público) — o Dockerfile baixa no build e confere o sha256.
 *  - YuNet 2023mar (OpenCV Zoo, MIT): leve, fica como segunda opinião.
 *
 * Roda em onnxruntime-web (WASM) porque a imagem Docker é Alpine (musl) e o
 * onnxruntime-node não tem binário pra musl.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import sharp from 'sharp'

const require = createRequire(import.meta.url)
const ort = require('onnxruntime-web') as typeof import('onnxruntime-web')
type Sessao = import('onnxruntime-web').InferenceSession

export type Motor = 'scrfd' | 'yunet'

export const DETECTORES: Record<Motor, string> = {
  scrfd: 'scrfd-10g',
  yunet: 'yunet-2023mar',
}

const MODELOS: Record<Motor, string> = {
  scrfd: path.join(process.cwd(), 'assets', 'models', 'scrfd_10g.onnx'),
  yunet: path.join(process.cwd(), 'assets', 'models', 'face_detection_yunet_2023mar.onnx'),
}

/** Lado da entrada dos dois modelos (o YuNet do zoo é fixo em 640×640). */
const LADO = 640
const SCORE_MIN: Record<Motor, number> = { scrfd: 0.5, yunet: 0.7 }
const NMS_IOU: Record<Motor, number> = { scrfd: 0.4, yunet: 0.3 }
const STRIDES = [8, 16, 32] as const
const SCRFD_CONFIANTE = 0.75

export interface Rosto {
  x: number
  y: number
  w: number
  h: number
  score: number
  /** Olho direito, olho esquerdo, nariz, canto direito e canto esquerdo da boca (da pessoa). */
  pontos: Array<[number, number]>
  /** Inclinação da linha dos olhos em graus (0 = rosto em pé; ±90 = deitado; ±180 = invertido). */
  inclinacao: number
}

type Giro = 0 | 90 | 180 | 270

export interface Deteccao {
  detector: string
  largura: number
  altura: number
  /** Giro (horário) em que os rostos foram achados com mais confiança. Diferente de 0
   *  = a foto chegou deitada/invertida em relação à pessoa. */
  giro: Giro
  rostos: Rosto[]
}

const sessoes = new Map<Motor, Promise<Sessao>>()

export function motorDisponivel(motor: Motor): boolean {
  return existsSync(MODELOS[motor])
}

function sessao(motor: Motor): Promise<Sessao> {
  let s = sessoes.get(motor)
  if (!s) {
    ort.env.wasm.numThreads = 1
    s = ort.InferenceSession.create(MODELOS[motor])
    sessoes.set(motor, s)
  }
  return s
}

function iou(a: Rosto, b: Rosto): number {
  const x1 = Math.max(a.x, b.x)
  const y1 = Math.max(a.y, b.y)
  const x2 = Math.min(a.x + a.w, b.x + b.w)
  const y2 = Math.min(a.y + a.h, b.y + b.h)
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1)
  return inter / (a.w * a.h + b.w * b.h - inter || 1)
}

function nms(rostos: Rosto[], limiar: number): Rosto[] {
  const ordenados = [...rostos].sort((a, b) => b.score - a.score)
  const ficam: Rosto[] = []
  for (const r of ordenados) {
    if (ficam.every((f) => iou(f, r) < limiar)) ficam.push(r)
  }
  return ficam
}

const r1 = (n: number) => Math.round(n * 10) / 10

/** Ponto na imagem girada (sharp.rotate, sentido horário) → ponto na imagem original W×H. */
function desgirar(giro: Giro, x: number, y: number, W: number, H: number): [number, number] {
  if (giro === 90) return [y, H - x]
  if (giro === 270) return [W - y, x]
  if (giro === 180) return [W - x, H - y]
  return [x, y]
}

/** Imagem reduzida (lado maior ≤ 640) colada no canto de um quadro 640×640, NCHW. */
async function montarEntrada(
  bytes: Buffer,
  largura: number,
  altura: number,
  pixel: (r: number, g: number, b: number) => [number, number, number],
  /** Valor da sobra do quadro — o pixel preto já normalizado, igual ao letterbox original. */
  vazio: number,
): Promise<{ entrada: Float32Array; escala: number }> {
  const escala = Math.min(1, LADO / Math.max(largura, altura))
  const w = Math.max(1, Math.round(largura * escala))
  const h = Math.max(1, Math.round(altura * escala))
  const rgb = await sharp(bytes)
    .flatten({ background: '#808080' })
    .resize(w, h, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer()
  const plano = LADO * LADO
  const entrada = new Float32Array(3 * plano).fill(vazio)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 3
      const d = y * LADO + x
      const [c0, c1, c2] = pixel(rgb[s], rgb[s + 1], rgb[s + 2])
      entrada[d] = c0
      entrada[plano + d] = c1
      entrada[2 * plano + d] = c2
    }
  }
  return { entrada, escala }
}

/** YuNet: entrada BGR 0–255; saídas cls/obj/bbox/kps por stride (cv::FaceDetectorYN). */
async function yunetSemGiro(bytes: Buffer, largura: number, altura: number): Promise<Rosto[]> {
  const { entrada, escala } = await montarEntrada(bytes, largura, altura, (r, g, b) => [b, g, r], 0)
  const s = await sessao('yunet')
  const saida = await s.run({ input: new ort.Tensor('float32', entrada, [1, 3, LADO, LADO]) })
  const brutos: Rosto[] = []
  for (const stride of STRIDES) {
    const cls = saida[`cls_${stride}`].data as Float32Array
    const obj = saida[`obj_${stride}`].data as Float32Array
    const bbox = saida[`bbox_${stride}`].data as Float32Array
    const kps = saida[`kps_${stride}`].data as Float32Array
    const cols = LADO / stride
    for (let i = 0; i < cols * cols; i++) {
      const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])))
      if (score < SCORE_MIN.yunet) continue
      const c = i % cols
      const r = Math.floor(i / cols)
      const cx = (c + bbox[i * 4]) * stride
      const cy = (r + bbox[i * 4 + 1]) * stride
      const bw = Math.exp(bbox[i * 4 + 2]) * stride
      const bh = Math.exp(bbox[i * 4 + 3]) * stride
      const pontos: Array<[number, number]> = []
      for (let n = 0; n < 5; n++) {
        pontos.push([((kps[i * 10 + 2 * n] + c) * stride) / escala, ((kps[i * 10 + 2 * n + 1] + r) * stride) / escala])
      }
      brutos.push({ x: (cx - bw / 2) / escala, y: (cy - bh / 2) / escala, w: bw / escala, h: bh / escala, score, pontos, inclinacao: 0 })
    }
  }
  return nms(brutos, NMS_IOU.yunet)
}

/**
 * SCRFD: entrada RGB (x−127.5)/128; 2 âncoras por célula; saídas na ordem do modelo:
 * 3 de nota, 3 de caixa (distâncias l/t/r/b × stride), 3 de pontos (× stride) —
 * mesmo pós-processamento do insightface/model_zoo/scrfd.py.
 */
async function scrfdSemGiro(bytes: Buffer, largura: number, altura: number): Promise<Rosto[]> {
  const { entrada, escala } = await montarEntrada(
    bytes,
    largura,
    altura,
    (r, g, b) => [(r - 127.5) / 128, (g - 127.5) / 128, (b - 127.5) / 128],
    -127.5 / 128,
  )
  const s = await sessao('scrfd')
  const saida = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', entrada, [1, 3, LADO, LADO]) })
  const nomes = s.outputNames
  const brutos: Rosto[] = []
  STRIDES.forEach((stride, k) => {
    const notas = saida[nomes[k]].data as Float32Array
    const caixas = saida[nomes[k + 3]].data as Float32Array
    const kps = saida[nomes[k + 6]].data as Float32Array
    const cols = LADO / stride
    for (let i = 0; i < notas.length; i++) {
      const score = notas[i]
      if (score < SCORE_MIN.scrfd) continue
      const celula = Math.floor(i / 2)
      const cx = (celula % cols) * stride
      const cy = Math.floor(celula / cols) * stride
      const x1 = cx - caixas[i * 4] * stride
      const y1 = cy - caixas[i * 4 + 1] * stride
      const x2 = cx + caixas[i * 4 + 2] * stride
      const y2 = cy + caixas[i * 4 + 3] * stride
      const pontos: Array<[number, number]> = []
      for (let n = 0; n < 5; n++) {
        pontos.push([(cx + kps[i * 10 + 2 * n] * stride) / escala, (cy + kps[i * 10 + 2 * n + 1] * stride) / escala])
      }
      brutos.push({
        x: x1 / escala,
        y: y1 / escala,
        w: (x2 - x1) / escala,
        h: (y2 - y1) / escala,
        score,
        pontos,
        inclinacao: 0,
      })
    }
  })
  return nms(brutos, NMS_IOU.scrfd)
}

/**
 * Detecta rostos nos pixels CRUS da imagem (sem aplicar a orientação EXIF), que é o
 * mesmo referencial que o render-foto.ts usa pra aplicar dx/dy/rotation/width.
 * Coordenadas em pixels da imagem original; fundo transparente vira cinza.
 *
 * Testa os 4 giros e fica com o de maior confiança: os detectores às vezes "acham"
 * rosto de cabeça pra baixo com pontos trocados, e YuNet nem vê rosto deitado.
 * SCRFD já acha rosto deitado em 0° (~1 s por passada em WASM), então só tenta os
 * outros giros quando a confiança em 0° fica abaixo de SCRFD_CONFIANTE.
 */
export async function detectarRostos(bytes: Buffer, motor: Motor = 'scrfd'): Promise<Deteccao> {
  const detector = DETECTORES[motor]
  const meta = await sharp(bytes).metadata()
  const largura = meta.width ?? 0
  const altura = meta.height ?? 0
  if (!largura || !altura) return { detector, largura, altura, giro: 0, rostos: [] }

  const semGiro = motor === 'scrfd' ? scrfdSemGiro : yunetSemGiro
  let melhor: { giro: Giro; achados: Rosto[]; topo: number } | null = null
  for (const giro of [0, 90, 270, 180] as Giro[]) {
    const girada = giro === 0 ? bytes : await sharp(bytes).rotate(giro).png().toBuffer()
    const [gw, gh] = giro === 90 || giro === 270 ? [altura, largura] : [largura, altura]
    const achados = await semGiro(girada, gw, gh)
    const topo = achados.reduce((m, f) => Math.max(m, f.score), 0)
    if (achados.length > 0 && (!melhor || topo > melhor.topo + 0.01)) melhor = { giro, achados, topo }
    if (motor === 'scrfd' && giro === 0 && topo >= SCRFD_CONFIANTE) break
  }
  if (!melhor) return { detector, largura, altura, giro: 0, rostos: [] }

  const { giro, achados } = melhor
  const rostos = achados.map((f) => {
    const pontos = f.pontos.map(([px, py]) => desgirar(giro, px, py, largura, altura))
    const a = desgirar(giro, f.x, f.y, largura, altura)
    const b = desgirar(giro, f.x + f.w, f.y + f.h, largura, altura)
    const [olhoA, olhoB] = pontos
    return {
      x: r1(Math.min(a[0], b[0])),
      y: r1(Math.min(a[1], b[1])),
      w: r1(Math.abs(b[0] - a[0])),
      h: r1(Math.abs(b[1] - a[1])),
      score: Math.round(f.score * 1000) / 1000,
      pontos: pontos.map(([px, py]) => [r1(px), r1(py)] as [number, number]),
      inclinacao: r1((Math.atan2(olhoB[1] - olhoA[1], olhoB[0] - olhoA[0]) * 180) / Math.PI),
    }
  })
  return { detector, largura, altura, giro, rostos }
}
