/**
 * Thread separada do relatório de ajustes: mede a foto (sharp) e roda os detectores de
 * rosto (onnxruntime-web/WASM). A inferência WASM é síncrona — rodando na thread principal
 * ela travava o Express ~1 s por passada e deixava a planilha lenta pros operadores.
 * Aqui ela só ocupa esta thread; as requisições seguem livres.
 */
import crypto from 'node:crypto'
import { parentPort } from 'node:worker_threads'

import sharp from 'sharp'

import { detectarRostos, motorDisponivel, type Deteccao, type Motor } from './detectar-rostos.js'

// Um núcleo só pro libvips desta thread: o resto da máquina fica pra planilha.
sharp.concurrency(1)

export interface PedidoAnalise {
  id: number
  bytes: Uint8Array
  motores: Motor[]
}

export interface ResultadoAnalise {
  medidas: Record<string, unknown>
  deteccao: Record<string, unknown>
  nRostos: number
}

async function medirImagem(bytes: Buffer): Promise<Record<string, unknown>> {
  const meta = await sharp(bytes).metadata()
  const stats = await sharp(bytes).flatten({ background: '#808080' }).stats()
  const [r, g, b] = stats.channels.map((c) => c.mean)
  return {
    hash: crypto.createHash('sha256').update(bytes).digest('hex'),
    largura: meta.width ?? 0,
    altura: meta.height ?? 0,
    formato: meta.format ?? '',
    bytes: bytes.length,
    orientacao_exif: meta.orientation ?? null,
    tem_transparencia: Boolean(meta.hasAlpha),
    brilho: Math.round(0.299 * r + 0.587 * g + 0.114 * b),
    nitidez: Math.round(stats.sharpness * 100) / 100,
    cor_media: [Math.round(r), Math.round(g), Math.round(b)],
    cor_dominante: [stats.dominant.r, stats.dominant.g, stats.dominant.b],
  }
}

/** SCRFD principal, YuNet 2ª opinião. Motor sem modelo no disco fica fora. */
async function analisar(bytes: Buffer, motores: Motor[]): Promise<ResultadoAnalise> {
  const medidas = await medirImagem(bytes)
  const deteccao: Record<string, unknown> = {}
  let principal: Deteccao | null = null
  for (const motor of motores) {
    if (!motorDisponivel(motor)) continue
    const d = await detectarRostos(bytes, motor)
    deteccao[motor] = { detector: d.detector, giro: d.giro, rostos: d.rostos }
    principal ??= d
  }
  return { medidas, deteccao, nRostos: principal?.rostos.length ?? 0 }
}

parentPort?.on('message', (msg: PedidoAnalise) => {
  analisar(Buffer.from(msg.bytes.buffer, msg.bytes.byteOffset, msg.bytes.byteLength), msg.motores).then(
    (resultado) => parentPort!.postMessage({ id: msg.id, resultado }),
    (e: unknown) => parentPort!.postMessage({ id: msg.id, erro: (e as Error)?.message ?? String(e) }),
  )
})
