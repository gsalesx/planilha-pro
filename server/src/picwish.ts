/**
 * APIs PicWish usadas no picker web:
 *  - remoção de fundo (modo RECORTE) — https://picwish.com/background-removal-api-doc
 *  - face cutout (modo ROSTO) — https://picwish.com/face-cutout-api-doc
 *
 * Mesma chave (`PICWISH_API_KEY`). O resultado é caro e determinístico pra uma
 * mesma foto, então quem chama deve cachear em disco — ver `routes/picker.ts`.
 */
import sharp from 'sharp'

import { env } from './env.js'

/** PicWish aceita até 4096px, mas retrato >1600px só aumenta upload/processamento
 *  sem ganho no picker (a composta final é 900×900). */
const LADO_MAX = 1600

const BG_REMOVAL_URL = 'https://techhk.aoscdn.com/api/tasks/visual/segmentation'
const FACE_CUTOUT_URL = 'https://techhk.aoscdn.com/api/tasks/visual/self-face-cutout'
const TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 500
/** Face cutout doc: polling máximo 60s; remoção de fundo usa o mesmo teto. */
const POLL_MAX_MS = 60_000
/** PicWish responde 429 acima de 2 req/s. Sem fila, dois cliques de "remover
 *  fundo" ao mesmo tempo falhavam ou iam pra retry mais lento. */
const PICWISH_QPS = 2

let picwishEmVoo = 0
const picwishEspera: Array<() => void> = []

async function comQps<T>(fn: () => Promise<T>): Promise<T> {
  if (picwishEmVoo >= PICWISH_QPS) {
    await new Promise<void>((resolve) => picwishEspera.push(resolve))
  }
  picwishEmVoo++
  try {
    return await fn()
  } finally {
    picwishEmVoo--
    picwishEspera.shift()?.()
  }
}

interface RespostaTarefa {
  status?: number
  data?: { task_id?: string; image?: string; progress?: number; state?: number }
  message?: string
}

async function comTimeout<T>(p: Promise<T>, ms: number, oque: string): Promise<T> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    return await p
  } catch (e) {
    if (ac.signal.aborted) throw new Error(`${oque}: timeout após ${ms}ms`)
    throw e
  } finally {
    clearTimeout(timer)
  }
}

/** Aguarda a tarefa assíncrona terminar e devolve a URL da imagem pronta. */
async function aguardarTarefa(apiUrl: string, taskId: string): Promise<string> {
  const limite = Date.now() + POLL_MAX_MS
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const r = await fetch(`${apiUrl}/${taskId}`, {
      headers: { 'X-API-KEY': env.picwishApiKey },
    })
    if (!r.ok) continue
    const body = (await r.json()) as RespostaTarefa
    const state = body.data?.state
    if (typeof state === 'number' && state < 0) {
      throw new Error(`picwish: tarefa falhou (state=${state})`)
    }
    const img = body.data?.image
    if (img) return img
  }
  throw new Error('picwish: tarefa não concluiu no tempo esperado')
}

/**
 * Envia a imagem pra um endpoint PicWish (sync preferido; cai em polling se
 * a API devolver só o task_id) e devolve o PNG/JPG resultante.
 */
async function processarImagem(
  apiUrl: string,
  imagem: Buffer,
  nomeArquivo: string,
  extraFields: Record<string, string> = {},
): Promise<Buffer> {
  if (!env.picwishApiKey) throw new Error('picwish: PICWISH_API_KEY não configurada')
  return comQps(async () => {
    const form = new FormData()
    form.append('image_file', new Blob([new Uint8Array(imagem)]), nomeArquivo)
    form.append('sync', '1')
    for (const [k, v] of Object.entries(extraFields)) form.append(k, v)

    const resp = await comTimeout(
      fetch(apiUrl, { method: 'POST', headers: { 'X-API-KEY': env.picwishApiKey }, body: form }),
      TIMEOUT_MS,
      'picwish upload',
    )
    if (!resp.ok) {
      throw new Error(`picwish: HTTP ${resp.status} ${(await resp.text()).slice(0, 200)}`)
    }

    const body = (await resp.json()) as RespostaTarefa
    let urlImagem = body.data?.image
    if (!urlImagem) {
      const taskId = body.data?.task_id
      if (!taskId) {
        throw new Error(`picwish: resposta sem imagem nem task_id — ${JSON.stringify(body).slice(0, 200)}`)
      }
      urlImagem = await aguardarTarefa(apiUrl, taskId)
    }

    const img = await comTimeout(fetch(urlImagem), TIMEOUT_MS, 'picwish download')
    if (!img.ok) throw new Error(`picwish: download HTTP ${img.status}`)
    return Buffer.from(await img.arrayBuffer())
  })
}

/** Reduz foto grande antes do upload — mesma qualidade no recorte, bem menos tempo de API. */
async function reduzirPraPicwish(imagem: Buffer, nomeArquivo: string): Promise<{ buf: Buffer; nome: string }> {
  const meta = await sharp(imagem, { failOn: 'none' }).metadata()
  const w = meta.width ?? 0
  const h = meta.height ?? 0
  if (w > 0 && h > 0 && w <= LADO_MAX && h <= LADO_MAX) {
    return { buf: imagem, nome: nomeArquivo }
  }
  const buf = await sharp(imagem, { failOn: 'none' })
    .rotate()
    .resize({
      width: LADO_MAX,
      height: LADO_MAX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: 88 })
    .toBuffer()
  return { buf, nome: 'foto.jpg' }
}

/** Remove o fundo e devolve o PNG (com alpha). Modo RECORTE. */
export async function removerFundo(imagem: Buffer, nomeArquivo = 'foto.jpg'): Promise<Buffer> {
  const { buf, nome } = await reduzirPraPicwish(imagem, nomeArquivo)
  return processarImagem(BG_REMOVAL_URL, buf, nome, { format: 'png', type: 'person' })
}

/**
 * Detecta o rosto/cabeça, remove o fundo e devolve PNG transparente (só o
 * rosto — sem moldura). Modo ROSTO. `crop=1` corta até a borda do alvo.
 */
export async function recortarRosto(imagem: Buffer, nomeArquivo = 'foto.jpg'): Promise<Buffer> {
  const { buf, nome } = await reduzirPraPicwish(imagem, nomeArquivo)
  return processarImagem(FACE_CUTOUT_URL, buf, nome, {
    crop: '1',
    output_format: 'png',
  })
}
