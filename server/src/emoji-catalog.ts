import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { db, nowMs } from './db.js'
import { env } from './env.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

/**
 * `server/assets/emojis` fica no mesmo nível de `server/src`/`server/dist` —
 * em dev (`__dirname` = server/src) e em prod (Docker, `__dirname` =
 * /app/dist) o `../assets/emojis` resolve certo nos dois casos.
 */
export const ASSETS_DIR = path.resolve(__dirname, '../assets/emojis')

/** Onde os emojis CUSTOM (upload do usuário) ficam em disco — mesmo diretório
 *  usado por routes/emoji-catalog.ts (fonte única, pra não divergir). */
export const CUSTOM_DIR = path.join(env.dataDir, 'emoji-custom')

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

const LOOKS_LIKE_EMOJI_RE =
  /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{2300}-\u{23FF}]/u

/** Recusa texto que não parece emoji unicode de verdade — protege contra colar/digitar
 * lixo (ex.: mojibake tipo "ð" de copiar emoji renderizado como sprite/imagem em algum
 * chat, em vez do caractere real) que vira alias "fantasma" sem nunca resolver nada. */
export function looksLikeEmoji(text: string): boolean {
  return LOOKS_LIKE_EMOJI_RE.test(text)
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

/**
 * Resolve `name` (o valor cru salvo em order_pieces.emoji1/2, ex "BEIJO",
 * "CORAÇÃO ROSA") pro CAMINHO DE ARQUIVO real no disco — builtin ou custom.
 *
 * Antes disso, `gerarArteDaPeca`/a rota GET /pieces/:id/emoji/:slot só
 * olhavam o diretório estático builtin (server/assets/emojis) direto pelo
 * nome do arquivo, IGNORANDO o catálogo em banco (emoji_catalog) — qualquer
 * emoji CUSTOM (cadastrado pela galeria, upload do usuário) nunca era
 * encontrado, mesmo aparecendo normalmente na tela de escolha (bug
 * reportado: william.sfe, brbaraaguenavalle — "emoji cadastrado mas não
 * puxou na prévia"). Resolver pelo catálogo do banco cobre os dois casos:
 * builtin (image_path=/emoji-assets/{arquivo} → ASSETS_DIR) e custom
 * (image_path=/api/emoji-catalog/custom/{arquivo} → CUSTOM_DIR).
 *
 * Fallback pro match direto em ASSETS_DIR (nome exato/uppercase.png) pra
 * peças antigas cujo nome não esteja (ainda) sincronizado no catálogo.
 */
export function resolverArquivoEmojiPorNome(name: string): string | null {
  const limpo = (name || '').trim()
  if (!limpo) return null

  const row = db.prepare('SELECT * FROM emoji_catalog WHERE name = ?').get(limpo) as EmojiCatalogRow | undefined
  if (row) {
    const dir = row.source === 'custom' ? CUSTOM_DIR : ASSETS_DIR
    const arquivo = path.basename(row.image_path)
    const p = path.join(dir, arquivo)
    if (existsSync(p)) return p
  }

  for (const cand of [`${limpo}.png`, `${limpo.toUpperCase()}.png`]) {
    const p = path.join(ASSETS_DIR, cand)
    if (existsSync(p)) return p
  }
  return null
}
