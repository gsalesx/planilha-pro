/**
 * Teste manual do render sem PSD (não é unit test — gera um JPG pra
 * conferência visual e comparação com a saída do Python).
 *
 * Uso:
 *   npx tsx src/render-molde.test-manual.ts <saida.jpg> <molde> <foto1.png> [foto2.png ...]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { CANVAS_POR_MOLDE, labelDoMolde, layoutLinha, renderMolde } from './render-molde.js'

async function main(): Promise<void> {
  const [saida, molde, ...fotos] = process.argv.slice(2)
  if (!saida || !molde || fotos.length === 0) {
    console.error('uso: tsx render-molde.test-manual.ts <saida.jpg> <molde> <foto1.png> ...')
    process.exit(2)
  }

  const raizArtes = process.env.CRIADOR_DE_ARTES_DIR
    ?? 'C:/Users/gsale/OneDrive/Documentos/Aplicativos/Criador de artes'
  const emoji = readFileSync(path.join(raizArtes, 'Moldes/EMOJIS/CORAÇÃO.png'))

  const canvas = CANVAS_POR_MOLDE[molde.toUpperCase()]
  const { unitW } = layoutLinha(fotos.length)
  console.log(`molde=${molde} canvas=${canvas?.w}x${canvas?.h} label="${labelDoMolde(molde)}"`)
  console.log(`fotos=${fotos.length} unidade=${unitW}px`)

  const t0 = Date.now()
  const jpg = await renderMolde({
    molde,
    cor: '#000000',
    fotos: fotos.map((f) => readFileSync(f)),
    emojis: [emoji],
  })
  writeFileSync(saida, jpg)
  console.log(`OK -> ${saida} (${(jpg.length / 1024 / 1024).toFixed(1)}MB, ${Date.now() - t0}ms)`)
}

void main()
