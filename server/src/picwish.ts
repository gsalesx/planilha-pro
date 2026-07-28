/**
 * Remoção de fundo via PicWish — usado no modo RECORTE do picker.
 *
 * Porte de `scripts/picwish.py` do repo "Criador de artes" (mesma API e
 * mesma chave). Doc: https://picwish.com/background-removal-api-doc
 *
 * O resultado é caro (chamada externa, alguns segundos) e determinístico pra
 * uma mesma foto, então quem chama deve cachear em disco — ver
 * `routes/picker.ts`.
 */
import { env } from './env.js'

const API_URL = 'https://techhk.aoscdn.com/api/tasks/visual/segmentation'
const TIMEOUT_MS = 60_000
const POLL_INTERVAL_MS = 1_000
const POLL_MAX_MS = 30_000

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
async function aguardarTarefa(taskId: string): Promise<string> {
  const limite = Date.now() + POLL_MAX_MS
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
    const r = await fetch(`${API_URL}/${taskId}`, {
      headers: { 'X-API-KEY': env.picwishApiKey },
    })
    if (!r.ok) continue
    const body = (await r.json()) as RespostaTarefa
    const img = body.data?.image
    if (img) return img
  }
  throw new Error('picwish: tarefa não concluiu no tempo esperado')
}

/**
 * Remove o fundo e devolve o PNG (com alpha).
 * Tenta o modo síncrono; se a API responder com task_id, faz polling.
 */
export async function removerFundo(imagem: Buffer, nomeArquivo = 'foto.jpg'): Promise<Buffer> {
  if (!env.picwishApiKey) throw new Error('picwish: PICWISH_API_KEY não configurada')

  const form = new FormData()
  form.append('image_file', new Blob([new Uint8Array(imagem)]), nomeArquivo)
  form.append('sync', '1')

  const resp = await comTimeout(
    fetch(API_URL, { method: 'POST', headers: { 'X-API-KEY': env.picwishApiKey }, body: form }),
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
    urlImagem = await aguardarTarefa(taskId)
  }

  const img = await comTimeout(fetch(urlImagem), TIMEOUT_MS, 'picwish download')
  if (!img.ok) throw new Error(`picwish: download HTTP ${img.status}`)
  return Buffer.from(await img.arrayBuffer())
}
