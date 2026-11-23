/**
 * Ponte pra thread de análise (analise-worker.ts). A thread nasce na 1ª foto e é
 * encerrada no fim de cada leitura, pra não segurar memória (modelos ONNX) o dia todo.
 */
import { Worker } from 'node:worker_threads'

import type { Motor } from './detectar-rostos.js'
import type { ResultadoAnalise } from './analise-worker.js'

let worker: Worker | null = null
let proximoId = 1
const pendentes = new Map<number, { ok: (r: ResultadoAnalise) => void; falha: (e: Error) => void }>()

function falharTodos(e: Error): void {
  for (const p of pendentes.values()) p.falha(e)
  pendentes.clear()
}

function garantirWorker(): Worker {
  if (worker) return worker
  // Em produção roda o .js compilado; no `tsx watch` o próprio .ts.
  const ext = import.meta.url.endsWith('.ts') ? '.ts' : '.js'
  const w = new Worker(new URL(`./analise-worker${ext}`, import.meta.url))
  w.on('message', (msg: { id: number; resultado?: ResultadoAnalise; erro?: string }) => {
    const p = pendentes.get(msg.id)
    if (!p) return
    pendentes.delete(msg.id)
    if (msg.erro !== undefined) p.falha(new Error(msg.erro))
    else p.ok(msg.resultado!)
  })
  w.on('error', (e) => {
    worker = null
    falharTodos(e)
  })
  w.on('exit', () => {
    worker = null
    falharTodos(new Error('thread de análise encerrou'))
  })
  worker = w
  return w
}

export function analisarFoto(bytes: Buffer, motores: Motor[]): Promise<ResultadoAnalise> {
  const w = garantirWorker()
  const id = proximoId++
  return new Promise((ok, falha) => {
    pendentes.set(id, { ok, falha })
    w.postMessage({ id, bytes: new Uint8Array(bytes), motores })
  })
}

export async function encerrarAnalise(): Promise<void> {
  const w = worker
  worker = null
  if (w) await w.terminate()
}
