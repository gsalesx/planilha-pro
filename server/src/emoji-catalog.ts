import { readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { db, nowMs } from './db.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * `server/assets/emojis` fica no mesmo nível de `server/src`/`server/dist` —
 * em dev (`__dirname` = server/src) e em prod (Docker, `__dirname` =
 * /app/dist) o `../assets/emojis` resolve certo nos dois casos.
 */
export const ASSETS_DIR = path.resolve(__dirname, '../assets/emojis')

export interface EmojiCatalogRow {
  id: number
  name: string
  aliases: string
  image_path: string
  source: 'builtin' | 'custom'
  created_at: number
}

export interface EmojiCatalogItem {
  id: number
  name: string
  aliases: string[]
  imageUrl: string
  source: 'builtin' | 'custom'
}

function rowToItem(row: EmojiCatalogRow): EmojiCatalogItem {
  let aliases: string[] = []
  try {
    const parsed = JSON.parse(row.aliases)
    if (Array.isArray(parsed)) aliases = parsed.filter((a): a is string => typeof a === 'string')
  } catch {
    // ignore — trata como sem aliases
  }
  return { id: row.id, name: row.name, aliases, imageUrl: row.image_path, source: row.source }
}

/**
 * Mapeamento inicial unicode→nome de alta confiança (o resto o operador
 * ensina pela galeria do picker — colar emoji sem match abre a galeria já
 * com o char pendurado, escolher a imagem salva o alias). Só aplica se o
 * catálogo ainda não tem alias nenhum pra esse nome, pra nunca sobrescrever
 * edição manual.
 */
const SEED_ALIASES: Record<string, string> = {
  // Os 6 da extensão Chrome antiga (❤️ 🥰 😍 🤍 💋 😘) — eram os mais usados,
  // por isso entram primeiro na lista de favoritos (ver PRIORITY_NAMES no
  // frontend, src/shopee-chat-panel.ts).
  'CORAÇÃO': '❤️',
  'CARA APAIXONADA': '🥰',
  'OLHOS CORAÇÃO': '😍',
  'CORAÇÃO BRANCO': '🤍',
  'BEIJO': '💋',
  'MANDANDO BEIJO': '😘',
  'FOGO': '🔥',
  'ESTRELA': '⭐',
  'COROA': '👑',
  'FLOR': '🌸',
  'GATINHO': '🐱',
  'LUA': '🌙',
  'SOL': '☀️',
  'BRILHANTE': '💎',
  'ALIANÇA': '💍',
  'BOUQUET': '💐',
  'TREVO 4 FOLHAS': '🍀',
  'INFINITO': '♾️',
  'PIZZA': '🍕',
  'GIRASSOL': '🌻',
  'ARCO-ÍRIS': '🌈',
  'URSO': '🐻',
  'ANIVERSARIO': '🎂',
  'PIPOCA': '🍿',
  'SUSHI': '🍣',
  'DENTE': '🦷',
  'ET': '👽',
  'COELHO': '🐰',
}

/**
 * Sincroniza o catálogo com os PNGs em `ASSETS_DIR` (idempotente — chamar
 * de novo com PNGs a mais só registra os novos) e semeia os aliases de alta
 * confiança. Chamar 1x no boot (ver index.ts).
 */
export function ensureEmojiCatalogSeeded(): void {
  let files: string[]
  try {
    files = readdirSync(ASSETS_DIR).filter((f) => f.toLowerCase().endsWith('.png'))
  } catch {
    console.warn(`[emoji-catalog] diretório de assets não encontrado: ${ASSETS_DIR}`)
    return
  }
  const now = nowMs()
  const insert = db.prepare(
    `INSERT OR IGNORE INTO emoji_catalog (name, aliases, image_path, source, created_at)
     VALUES (?, '[]', ?, 'builtin', ?)`,
  )
  const txn = db.transaction(() => {
    for (const file of files) {
      const name = path.basename(file, '.png')
      const imagePath = `/emoji-assets/${encodeURIComponent(file)}`
      insert.run(name, imagePath, now)
    }
    for (const [name, alias] of Object.entries(SEED_ALIASES)) {
      db.prepare(
        `UPDATE emoji_catalog SET aliases = ? WHERE name = ? AND aliases = '[]'`,
      ).run(JSON.stringify([alias]), name)
    }
  })
  txn()
}

export function listCatalog(): EmojiCatalogItem[] {
  const rows = db.prepare('SELECT * FROM emoji_catalog ORDER BY source, name').all() as EmojiCatalogRow[]
  return rows.map(rowToItem)
}

/** Um mesmo alias (emoji unicode) não pode apontar pra 2 nomes — resolução vira ambígua
 * (o picker/galeria mostrariam o mesmo emoji "grudado" em itens diferentes). Chamar antes
 * de gravar aliases novos; `excludeId` = null pra criação (ainda não existe linha própria). */
export function findAliasConflict(
  aliases: string[],
  excludeId: number | null,
): { alias: string; name: string } | null {
  const others = listCatalog().filter((item) => item.id !== excludeId)
  for (const alias of aliases) {
    const owner = others.find((item) => item.aliases.includes(alias))
    if (owner) return { alias, name: owner.name }
  }
  return null
}

function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toLowerCase()
    .trim()
}

/** Char/trecho colado -> item do catálogo, ou null. Substring match (não
 * char-a-char) pra aguentar sequências multi-codepoint (seletor de
 * variação, ZWJ, tom de pele). */
export function resolveByAlias(text: string): EmojiCatalogItem | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const items = listCatalog()
  for (const item of items) {
    for (const alias of item.aliases) {
      if (alias && trimmed.includes(alias)) return item
    }
  }
  return null
}

export function searchByName(query: string): EmojiCatalogItem[] {
  const q = normalize(query)
  if (!q) return []
  return listCatalog().filter((item) => normalize(item.name).includes(q))
}

export { normalize as normalizeEmojiName }
