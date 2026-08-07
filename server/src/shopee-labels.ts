import { mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { env } from './env.js'

/** Etiquetas ficam guardadas no volume persistente (`/data`) por este prazo: reimprimir
 *  dentro da janela devolve o MESMO papel já impresso, sem gastar chamada na Shopee (que
 *  ainda por cima recusa reorganizar envio de pedido já despachado). */
export const LABEL_RETENTION_DAYS = 10
const RETENTION_MS = LABEL_RETENTION_DAYS * 24 * 60 * 60 * 1000

function labelsDir(): string {
  const dir = path.join(env.dataDir, 'etiquetas')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** orderSn e documentType vêm da URL/query — sanitizados pra não escapar do diretório. */
function fileNameFor(orderSn: string, documentType: string, ext: string): string {
  const slug = `${orderSn}__${documentType}`.replace(/[^A-Za-z0-9_-]/g, '_')
  return `${slug}.${ext}`
}

function isLabelOf(fileName: string, orderSn: string, documentType: string): boolean {
  const prefix = fileNameFor(orderSn, documentType, '')
  return fileName.startsWith(prefix)
}

export interface CachedLabel {
  buffer: Buffer
  /** 'pdf' | 'zip' — o formato varia conforme o tipo de documento da Shopee. */
  ext: string
  savedAt: number
}

/** Apaga o que passou dos 10 dias. Roda junto de cada impressão (o diretório tem poucas
 *  dezenas de arquivos) — sem agendador só pra isso. */
export function pruneExpiredLabels(): number {
  const dir = labelsDir()
  const limite = Date.now() - RETENTION_MS
  let apagadas = 0
  for (const fileName of readdirSync(dir)) {
    const file = path.join(dir, fileName)
    try {
      if (statSync(file).mtimeMs >= limite) continue
      unlinkSync(file)
      apagadas++
    } catch {
      // arquivo sumiu no meio do caminho (outra request) — nada a fazer
    }
  }
  return apagadas
}

export function readCachedLabel(orderSn: string, documentType: string): CachedLabel | null {
  const dir = labelsDir()
  const limite = Date.now() - RETENTION_MS
  for (const fileName of readdirSync(dir)) {
    if (!isLabelOf(fileName, orderSn, documentType)) continue
    const file = path.join(dir, fileName)
    try {
      const savedAt = statSync(file).mtimeMs
      if (savedAt < limite) continue
      return { buffer: readFileSync(file), ext: path.extname(fileName).replace('.', ''), savedAt }
    } catch {
      return null
    }
  }
  return null
}

export function saveLabel(orderSn: string, documentType: string, buffer: Buffer, ext: string): void {
  try {
    writeFileSync(path.join(labelsDir(), fileNameFor(orderSn, documentType, ext)), buffer)
  } catch (error) {
    // guardar é otimização, não requisito: falha de disco não pode impedir a impressão
    console.warn('[shopee] falha ao guardar etiqueta', orderSn, error instanceof Error ? error.message : error)
  }
}
