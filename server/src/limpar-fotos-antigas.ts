import { readdirSync, statSync, unlinkSync } from 'node:fs'
import path from 'node:path'

import { recordAudit } from './audit.js'
import { db } from './db.js'
import { env } from './env.js'

/** Pedido com data da planilha anterior a este prazo perde foto e arte. A linha fica. */
export const RETENCAO_FOTOS_DIAS = 15

/**
 * Chave YYYYMMDD do primeiro dia que AINDA fica.
 * Hoje 14/10 e prazo 15 → 29/09 fica; 28/09 já tem mais de 15 dias e sai.
 */
export function limiteFotosYmd(agora = new Date(), dias = RETENCAO_FOTOS_DIAS): string {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(agora)
  const [ano, mes, dia] = partes.split('-').map(Number)
  const data = new Date(Date.UTC(ano, mes - 1, dia))
  data.setUTCDate(data.getUTCDate() - dias)
  const y = data.getUTCFullYear()
  const m = String(data.getUTCMonth() + 1).padStart(2, '0')
  const d = String(data.getUTCDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

function sheetDateYmd(sheetDate: string): string | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(sheetDate.trim())
  if (!m) return null
  const dia = Number(m[1])
  const mes = Number(m[2])
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null
  return `${m[3]}${m[2]}${m[1]}`
}

function raizImagens(): string {
  return path.resolve(env.dataDir, 'images')
}

/** Só apaga arquivo dentro de /data/images. Catálogo de emoji e o resto do disco ficam. */
function arquivoDeImagem(candidato: string): string | null {
  if (!candidato) return null
  const raiz = raizImagens()
  const abs = path.resolve(candidato)
  if (abs === raiz || abs === path.join(raiz, '_thumbs')) return null
  if (!abs.startsWith(raiz + path.sep)) return null
  return abs
}

function apagarThumbs(arquivo: string, nomes: string[]): number {
  const base = path.basename(arquivo, path.extname(arquivo))
  const prefixo = `${base}_t`
  const dir = path.join(raizImagens(), '_thumbs')
  let bytes = 0
  for (const nome of nomes) {
    if (!nome.startsWith(prefixo)) continue
    const alvo = path.join(dir, nome)
    try {
      bytes += statSync(alvo).size
      unlinkSync(alvo)
    } catch {
      // miniatura já sumiu
    }
  }
  return bytes
}

export interface LimpezaFotos {
  pedidos: number
  arquivos: number
  bytes: number
  limite: string
}

/**
 * Apaga foto da planilha, foto da peça, recorte, composta e arte final
 * de pedido com `sheet_date` mais antigo que 15 dias.
 * Número do pedido, cliente, status e o texto da peça continuam na linha.
 * Pedido sem data de envio não entra.
 */
export function limparFotosAntigas(agora = new Date()): LimpezaFotos {
  const limite = limiteFotosYmd(agora)
  const candidatos = db
    .prepare(`SELECT workbook_id, order_key, sheet_date FROM orders WHERE sheet_date != ''`)
    .all() as Array<{ workbook_id: string; order_key: string; sheet_date: string }>

  const velhos = candidatos.filter((o) => {
    const ymd = sheetDateYmd(o.sheet_date)
    return ymd != null && ymd < limite
  })

  if (velhos.length === 0) {
    return { pedidos: 0, arquivos: 0, bytes: 0, limite }
  }

  const fotosPlanilha = db.prepare(
    'SELECT storage_path FROM images WHERE workbook_id = ? AND order_id = ?',
  )
  const fotosPeca = db.prepare(
    `SELECT pi.storage_path, pi.sem_fundo_path, pi.composta_path
       FROM piece_images pi
       INNER JOIN order_pieces p ON p.id = pi.piece_id
      WHERE p.workbook_id = ? AND p.order_key = ?`,
  )
  const artes = db.prepare(
    `SELECT c.jpg_path
       FROM piece_arte_cache c
       INNER JOIN order_pieces p ON p.id = c.piece_id
      WHERE p.workbook_id = ? AND p.order_key = ?`,
  )
  const apagaImagens = db.prepare('DELETE FROM images WHERE workbook_id = ? AND order_id = ?')
  const apagaPendentes = db.prepare(
    `DELETE FROM piece_pending_photos
      WHERE piece_id IN (SELECT id FROM order_pieces WHERE workbook_id = ? AND order_key = ?)`,
  )
  const apagaPecas = db.prepare(
    `DELETE FROM piece_images
      WHERE piece_id IN (SELECT id FROM order_pieces WHERE workbook_id = ? AND order_key = ?)`,
  )
  const apagaArtes = db.prepare(
    `DELETE FROM piece_arte_cache
      WHERE piece_id IN (SELECT id FROM order_pieces WHERE workbook_id = ? AND order_key = ?)`,
  )

  const caminhos = new Set<string>()
  const txn = db.transaction(() => {
    for (const pedido of velhos) {
      const args = [pedido.workbook_id, pedido.order_key] as const
      for (const row of fotosPlanilha.all(...args) as Array<{ storage_path: string }>) {
        const abs = arquivoDeImagem(row.storage_path)
        if (abs) caminhos.add(abs)
      }
      for (const row of fotosPeca.all(...args) as Array<{
        storage_path: string
        sem_fundo_path: string
        composta_path: string
      }>) {
        for (const p of [row.storage_path, row.sem_fundo_path, row.composta_path]) {
          const abs = arquivoDeImagem(p)
          if (abs) caminhos.add(abs)
        }
      }
      for (const row of artes.all(...args) as Array<{ jpg_path: string }>) {
        const abs = arquivoDeImagem(row.jpg_path)
        if (abs) caminhos.add(abs)
      }
      apagaImagens.run(...args)
      apagaPendentes.run(...args)
      apagaPecas.run(...args)
      apagaArtes.run(...args)
    }
  })
  txn()

  const aindaUsado = new Set<string>()
  const guardar = (p: string) => {
    const abs = arquivoDeImagem(p)
    if (abs) aindaUsado.add(abs)
  }
  for (const row of db.prepare('SELECT storage_path FROM images').all() as Array<{ storage_path: string }>) {
    guardar(row.storage_path)
  }
  for (const row of db.prepare(
    'SELECT storage_path, sem_fundo_path, composta_path FROM piece_images',
  ).all() as Array<{ storage_path: string; sem_fundo_path: string; composta_path: string }>) {
    guardar(row.storage_path)
    guardar(row.sem_fundo_path)
    guardar(row.composta_path)
  }
  for (const row of db.prepare('SELECT jpg_path FROM piece_arte_cache').all() as Array<{ jpg_path: string }>) {
    guardar(row.jpg_path)
  }

  let nomesThumbs: string[] = []
  try {
    nomesThumbs = readdirSync(path.join(raizImagens(), '_thumbs'))
  } catch {
    nomesThumbs = []
  }

  let arquivos = 0
  let bytes = 0
  for (const abs of caminhos) {
    if (aindaUsado.has(abs)) continue
    try {
      bytes += statSync(abs).size
      unlinkSync(abs)
      arquivos++
    } catch {
      // arquivo já sumiu
    }
    const thumbs = apagarThumbs(abs, nomesThumbs)
    if (thumbs > 0) {
      bytes += thumbs
      arquivos++
    }
  }

  recordAudit({
    source: 'boot',
    event: 'fotos.antigas.limpas',
    detail: { pedidos: velhos.length, arquivos, bytes, limite, dias: RETENCAO_FOTOS_DIAS },
  })

  return { pedidos: velhos.length, arquivos, bytes, limite }
}
