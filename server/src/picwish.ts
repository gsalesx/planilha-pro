/**
 * APIs PicWish usadas no picker web:
 *  - remoção de fundo (modo RECORTE) — https://picwish.com/background-removal-api-doc
 *  - face cutout (modo ROSTO) — https://picwish.com/face-cutout-api-doc
 *
 * Mesma chave (`PICWISH_API_KEY`). O resultado é caro e determinístico pra uma
 * mesma foto, então quem chama deve cachear em disco — ver `routes/picker.ts`.
 */
import { env } from './env.js'

const BG_REMOVAL_URL = 'https://techhk.aoscdn.com/api/tasks/visual/segmentation'
const FACE_CUTOUT_URL = 'https://techhk.aoscdn.com/api/tasks/visual/self-face-cutout'
const TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 1_000
/** Face cutout doc: polling máximo 60s; remoção de fundo usa o mesmo teto. */
const POLL_MAX_MS = 60_000

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
}

/** Remove o fundo e devolve o PNG (com alpha). Modo RECORTE. */
export async function removerFundo(imagem: Buffer, nomeArquivo = 'foto.jpg'): Promise<Buffer> {
  return processarImagem(BG_REMOVAL_URL, imagem, nomeArquivo)
}

/**
 * Detecta o rosto/cabeça, remove o fundo e devolve PNG transparente (só o
 * rosto — sem moldura). Modo ROSTO. `crop=1` corta até a borda do alvo.
 */
export async function recortarRosto(imagem: Buffer, nomeArquivo = 'foto.jpg'): Promise<Buffer> {
  return processarImagem(FACE_CUTOUT_URL, imagem, nomeArquivo, {
    crop: '1',
    output_format: 'png',
  })
}
