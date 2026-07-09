/**
 * SKU → peça (Fase 1 da migração pra tirar Drive/webchat Shopee do meio — ver
 * memória `planilha-pro-migracao-sku-pecas-2026-07-08` no repo Criador de artes).
 *
 * Família é decidida por casamento de texto contra o próprio SKU (col B / SHOPEE_COL_PRODUCT
 * já sincronizado — não há coluna separada de "nome do produto" no layout wb_shopee, ver
 * shopee-columns.ts). Sem tabela/painel de mapeamento: regra hardcoded, por pedido do usuário.
 *
 * Nomes de molde alinhados com Moldes/*.psd do repo Criador de artes:
 * `{TAMANHO} {MASCULINO|FEMININO|CAMISOLA}` e `{TAMANHO} CONJ {MASC|FEM}`.
 */

import { db, nowMs } from './db.js'
import { SHOPEE_COL_MODEL, SHOPEE_COL_PRODUCT } from './shopee-columns.js'

export type Genero = 'MASCULINO' | 'FEMININO'
export type Tamanho = 'P' | 'M' | 'G' | 'GG'
export type PecaTipo = 'CAMISOLA' | 'SHORT' | 'CONJ'

export interface Peca {
  tipo: PecaTipo
  genero?: Genero
  tamanho: Tamanho
  molde: string
}

export type Family =
  | 'CAMISOLA'
  | 'CAMISOLA_SHORT'
  | 'CAMISOLA_CONJUNTO'
  | 'SHORT'
  | 'SHORT_CASAL'
  | 'CONJUNTO_UNITARIO'
  | 'CONJUNTO_COMPLETO_CASAL'

export type ParseResult = { ok: true; pieces: Peca[] } | { ok: false; reason: string }

const TAMANHOS: Tamanho[] = ['P', 'M', 'G', 'GG']

function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '')
}

function norm(s: string): string {
  return stripAccents(String(s || '')).toUpperCase().trim()
}

export function normalizeTamanho(raw: string): Tamanho | null {
  const t = norm(raw)
  return (TAMANHOS as string[]).includes(t) ? (t as Tamanho) : null
}

export function normalizeGenero(raw: string): Genero | null {
  const g = norm(raw)
  if (g === 'MASCULINO' || g === 'MASC') return 'MASCULINO'
  if (g === 'FEMININO' || g === 'FEM') return 'FEMININO'
  return null
}

export function generoAbrev(g: Genero): 'MASC' | 'FEM' {
  return g === 'MASCULINO' ? 'MASC' : 'FEM'
}

/** Recalcula o nome do molde (pasta em Moldes/*.psd) a partir de tipo+genero+tamanho — usado
 * quando o usuário faz override manual da peça (picker do chat, Fase 2). */
export function buildMolde(tipo: PecaTipo, genero: Genero | undefined | null, tamanho: Tamanho): string {
  if (tipo === 'CAMISOLA') return `${tamanho} CAMISOLA`
  if (tipo === 'CONJ') return `${tamanho} CONJ ${genero ? generoAbrev(genero) : 'MASC'}`
  return `${tamanho} ${genero ?? 'MASCULINO'}`
}

/** Casamento mais específico primeiro — evita "CAMISOLA + SHORT" cair em "CAMISOLA". */
export function resolveFamily(sku: string): Family | null {
  const s = norm(sku)
  if (!s) return null
  const hasCamisola = s.includes('CAMISOLA')
  const hasShort = s.includes('SHORT')
  const hasConjunto = s.includes('CONJUNTO') || s.includes('CONJ')
  const hasCasal = s.includes('CASAL')
  const hasCompleto = s.includes('COMPLETO')
  const hasUnitario = s.includes('UNITARIO')

  if (hasCamisola && hasConjunto) return 'CAMISOLA_CONJUNTO'
  if (hasCamisola && hasShort) return 'CAMISOLA_SHORT'
  if (hasConjunto && hasCasal && hasCompleto) return 'CONJUNTO_COMPLETO_CASAL'
  if (hasConjunto && hasUnitario) return 'CONJUNTO_UNITARIO'
  if (hasShort && hasCasal) return 'SHORT_CASAL'
  if (hasCamisola) return 'CAMISOLA'
  if (hasShort) return 'SHORT'
  return null
}

function splitTokens(modelName: string, expected: number): string[] | null {
  const tokens = String(modelName || '')
    .split(',')
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  return tokens.length === expected ? tokens : null
}

function parseCamisola(modelName: string): ParseResult {
  const tokens = splitTokens(modelName, 1)
  const tamanho = tokens && normalizeTamanho(tokens[0])
  if (!tokens || !tamanho) {
    return { ok: false, reason: `CAMISOLA: esperado 1 tamanho (ex. "P"), veio "${modelName}"` }
  }
  return { ok: true, pieces: [{ tipo: 'CAMISOLA', tamanho, molde: `${tamanho} CAMISOLA` }] }
}

function parseCamisolaShort(modelName: string): ParseResult {
  const tokens = splitTokens(modelName, 2)
  const t1 = tokens && normalizeTamanho(tokens[0])
  const t2 = tokens && normalizeTamanho(tokens[1])
  if (!tokens || !t1 || !t2) {
    return {
      ok: false,
      reason: `CAMISOLA + SHORT: esperado 2 tamanhos separados por vírgula (ex. "G,P"), veio "${modelName}"`,
    }
  }
  return {
    ok: true,
    pieces: [
      { tipo: 'CAMISOLA', tamanho: t1, molde: `${t1} CAMISOLA` },
      { tipo: 'SHORT', genero: 'MASCULINO', tamanho: t2, molde: `${t2} MASCULINO` },
    ],
  }
}

function parseCamisolaConjunto(modelName: string): ParseResult {
  const tokens = splitTokens(modelName, 2)
  const t1 = tokens && normalizeTamanho(tokens[0])
  const t2 = tokens && normalizeTamanho(tokens[1])
  if (!tokens || !t1 || !t2) {
    return {
      ok: false,
      reason: `CAMISOLA + CONJUNTO: esperado 2 tamanhos separados por vírgula (ex. "G,P"), veio "${modelName}"`,
    }
  }
  return {
    ok: true,
    pieces: [
      { tipo: 'CAMISOLA', tamanho: t1, molde: `${t1} CAMISOLA` },
      { tipo: 'CONJ', genero: 'MASCULINO', tamanho: t2, molde: `${t2} CONJ MASC` },
    ],
  }
}

function parseShort(modelName: string): ParseResult {
  const tokens = splitTokens(modelName, 2)
  const tamanho = tokens && normalizeTamanho(tokens[0])
  const genero = tokens && normalizeGenero(tokens[1])
  if (!tokens || !tamanho || !genero) {
    return {
      ok: false,
      reason: `SHORT: esperado "tamanho,genero" (ex. "GG,Masculino"), veio "${modelName}"`,
    }
  }
  return { ok: true, pieces: [{ tipo: 'SHORT', genero, tamanho, molde: `${tamanho} ${genero}` }] }
}

function parseConjuntoUnitario(modelName: string): ParseResult {
  const tokens = splitTokens(modelName, 2)
  const tamanho = tokens && normalizeTamanho(tokens[0])
  const genero = tokens && normalizeGenero(tokens[1])
  if (!tokens || !tamanho || !genero) {
    return {
      ok: false,
      reason: `CONJUNTO UNITARIO: esperado "tamanho,genero" (ex. "GG,Masculino"), veio "${modelName}"`,
    }
  }
  return {
    ok: true,
    pieces: [{ tipo: 'CONJ', genero, tamanho, molde: `${tamanho} CONJ ${generoAbrev(genero)}` }],
  }
}

function parseConjuntoCompletoCasal(modelName: string): ParseResult {
  const tokens = splitTokens(modelName, 2)
  if (!tokens) {
    return {
      ok: false,
      reason: `CONJUNTO COMPLETO CASAL: esperado 2 valores separados por vírgula (ex. "M Feminino,G Masculino"), veio "${modelName}"`,
    }
  }
  const pieces: Peca[] = []
  for (const token of tokens) {
    const parts = token.split(/\s+/).filter(Boolean)
    const tamanho = parts.length === 2 ? normalizeTamanho(parts[0]) : null
    const genero = parts.length === 2 ? normalizeGenero(parts[1]) : null
    if (!tamanho || !genero) {
      return {
        ok: false,
        reason: `CONJUNTO COMPLETO CASAL: token "${token}" não é "tamanho genero" (ex. "M Feminino"), veio "${modelName}"`,
      }
    }
    pieces.push({ tipo: 'CONJ', genero, tamanho, molde: `${tamanho} CONJ ${generoAbrev(genero)}` })
  }
  return { ok: true, pieces }
}

/** Ainda não padronizado pelo usuário — sempre vira pendência até ele mandar o formato. */
function parseShortCasal(): ParseResult {
  return {
    ok: false,
    reason: 'Família SHORT CASAL ainda não tem formato padronizado — aguardando definição do usuário',
  }
}

export function parseOrderPieces(sku: string, modelName: string): ParseResult {
  const family = resolveFamily(sku)
  if (!family) {
    return { ok: false, reason: `SKU "${sku}" não corresponde a nenhuma família conhecida` }
  }
  switch (family) {
    case 'CAMISOLA':
      return parseCamisola(modelName)
    case 'CAMISOLA_SHORT':
      return parseCamisolaShort(modelName)
    case 'CAMISOLA_CONJUNTO':
      return parseCamisolaConjunto(modelName)
    case 'SHORT':
      return parseShort(modelName)
    case 'CONJUNTO_UNITARIO':
      return parseConjuntoUnitario(modelName)
    case 'CONJUNTO_COMPLETO_CASAL':
      return parseConjuntoCompletoCasal(modelName)
    case 'SHORT_CASAL':
      return parseShortCasal()
  }
}

interface OrderRowForScan {
  order_key: string
  id: string
  row_json: string
}

function hasOpenIssue(workbookId: string, orderKey: string, sku: string, modelName: string): boolean {
  const row = db
    .prepare(
      'SELECT id FROM parse_issues WHERE workbook_id = ? AND order_key = ? AND sku = ? AND model_name = ? AND resolved = 0',
    )
    .get(workbookId, orderKey, sku, modelName)
  return Boolean(row)
}

/** Grava 1 pendência se o parse falhar e ainda não houver uma igual aberta pra esse pedido. */
export function recordParseIssueIfNeeded(
  workbookId: string,
  orderKey: string,
  orderId: string,
  sku: string,
  modelName: string,
): boolean {
  const result = parseOrderPieces(sku, modelName)
  if (result.ok) return false
  if (hasOpenIssue(workbookId, orderKey, sku, modelName)) return false
  db.prepare(
    `INSERT INTO parse_issues (workbook_id, order_key, order_id, sku, model_name, reason, resolved, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(workbookId, orderKey, orderId, sku, modelName, result.reason, nowMs())
  return true
}

/** Varre todas as linhas do workbook e registra pendências novas. Retorna quantas foram criadas. */
export function scanOrdersForParseIssues(workbookId: string): number {
  const rows = db
    .prepare('SELECT order_key, id, row_json FROM orders WHERE workbook_id = ?')
    .all(workbookId) as OrderRowForScan[]

  let created = 0
  for (const row of rows) {
    let cells: string[]
    try {
      cells = JSON.parse(row.row_json) as string[]
    } catch {
      continue
    }
    const sku = (cells[SHOPEE_COL_PRODUCT] || '').trim()
    const modelName = (cells[SHOPEE_COL_MODEL] || '').trim()
    if (!sku || !modelName) continue
    if (recordParseIssueIfNeeded(workbookId, row.order_key, row.id, sku, modelName)) created++
  }
  return created
}
