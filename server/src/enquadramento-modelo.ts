/**
 * Modelo de enquadramento treinado nos ajustes do relatório (CatBoost, exportado em JSON).
 * Prevê, a partir dos rostos achados e do tamanho da foto, onde o operador deixaria o grupo
 * de rostos no quadro 900×900 (centro e largura), a inclinação fina e a largura da cápsula.
 *
 * As features e a geometria têm que bater 1:1 com `treino/treinar_enquadramento.py`.
 * Só é usado quando o arquivo existe E `IA_ENQUADRAMENTO=modelo` — senão a montagem segue
 * com as medianas do relatório.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { env } from './env.js'

export const CAMINHO_MODELO = path.join(env.dataDir, 'modelos', 'enquadramento.json')

export interface RostoModelo {
  x: number
  y: number
  w: number
  h: number
  score: number
  inclinacao?: number
}

interface ArvoreOblivia {
  splits: Array<{ float_feature_index: number; border: number }>
  leaf_values: number[]
}

interface ModeloCatboost {
  oblivious_trees: ArvoreOblivia[]
  scale_and_bias: [number, number[]]
}

export interface PacoteModelo {
  versao: number
  criadoEm: string
  features: string[]
  modelos: Record<'cx' | 'cy' | 'gw' | 'rot' | 'uw', ModeloCatboost>
  metricas: unknown
}

let cache: { mtime: number; pacote: PacoteModelo } | null = null

export function modeloAtivo(): PacoteModelo | null {
  if (process.env.IA_ENQUADRAMENTO !== 'modelo') return null
  return carregarModelo()
}

export function carregarModelo(): PacoteModelo | null {
  if (!existsSync(CAMINHO_MODELO)) return null
  const mtime = statSync(CAMINHO_MODELO).mtimeMs
  if (cache?.mtime === mtime) return cache.pacote
  try {
    const pacote = JSON.parse(readFileSync(CAMINHO_MODELO, 'utf8')) as PacoteModelo
    cache = { mtime, pacote }
    return pacote
  } catch {
    return null
  }
}

export function salvarModelo(pacote: PacoteModelo): void {
  if (!pacote?.modelos?.cx?.oblivious_trees) throw new Error('pacote de modelo inválido')
  mkdirSync(path.dirname(CAMINHO_MODELO), { recursive: true })
  writeFileSync(CAMINHO_MODELO, JSON.stringify(pacote))
  cache = null
}

function preverArvores(m: ModeloCatboost, x: number[]): number {
  let soma = 0
  for (const t of m.oblivious_trees) {
    let idx = 0
    for (let j = 0; j < t.splits.length; j++) {
      const s = t.splits[j]
      if (x[s.float_feature_index] > s.border) idx |= 1 << j
    }
    soma += t.leaf_values[idx]
  }
  const [escala, vies] = m.scale_and_bias
  return escala * soma + (vies?.[0] ?? 0)
}

/** Rostos que importam (mesma regra da montagem: descarta gente pequena no fundo). */
export function grupoModelo(rostos: RostoModelo[]): { bons: RostoModelo[]; ficam: RostoModelo[] } {
  const bons = rostos.filter((r) => r.score >= 0.6)
  if (!bons.length) return { bons, ficam: [] }
  const maior = Math.max(...bons.map((r) => r.w))
  return { bons, ficam: bons.filter((r) => r.w >= maior * 0.35) }
}

/** Vetor de features — mesma ordem de `FEATURES` no script de treino. */
export function featuresEnquadramento(coracao: boolean, W: number, H: number, rostos: RostoModelo[]): number[] | null {
  const { bons, ficam } = grupoModelo(rostos)
  if (!ficam.length || !W || !H) return null
  const x0 = Math.min(...ficam.map((r) => r.x))
  const y0 = Math.min(...ficam.map((r) => r.y))
  const x1 = Math.max(...ficam.map((r) => r.x + r.w))
  const y1 = Math.max(...ficam.map((r) => r.y + r.h))
  const p = ficam.reduce((a, b) => (b.w > a.w ? b : a))
  let inc = Number(p.inclinacao ?? 0)
  while (inc > 180) inc -= 360
  while (inc < -180) inc += 360
  return [
    coracao ? 1 : 0,
    W / H,
    ficam.length,
    bons.length,
    x0 / W,
    y0 / H,
    x1 / W,
    y1 / H,
    (x1 - x0) / W,
    (y1 - y0) / H,
    p.w / W,
    (p.x + p.w / 2) / W,
    (p.y + p.h / 2) / H,
    inc,
    p.score,
    W / 1000,
    H / 1000,
  ]
}

export interface PrevisaoEnquadramento {
  cx: number
  cy: number
  gw: number
  rot: number
  uw: number
}

export function preverEnquadramento(
  pacote: PacoteModelo,
  coracao: boolean,
  W: number,
  H: number,
  rostos: RostoModelo[],
): PrevisaoEnquadramento | null {
  const x = featuresEnquadramento(coracao, W, H, rostos)
  if (!x) return null
  return {
    cx: preverArvores(pacote.modelos.cx, x),
    cy: preverArvores(pacote.modelos.cy, x),
    gw: Math.max(20, preverArvores(pacote.modelos.gw, x)),
    rot: Math.max(-20, Math.min(20, preverArvores(pacote.modelos.rot, x))),
    uw: preverArvores(pacote.modelos.uw, x),
  }
}

/** Ponto da foto original W×H → foto girada `rot` graus (horário, com expand), como o sharp.rotate. */
export function girarComExpand(x: number, y: number, W: number, H: number, rot: number): { x: number; y: number; W2: number; H2: number } {
  const a = (rot * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const W2 = Math.abs(W * c) + Math.abs(H * s)
  const H2 = Math.abs(W * s) + Math.abs(H * c)
  const dx = x - W / 2
  const dy = y - H / 2
  return { x: dx * c - dy * s + W2 / 2, y: dx * s + dy * c + H2 / 2, W2, H2 }
}
