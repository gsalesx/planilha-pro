/**
 * Teste manual do compositor de foto (coração/recorte) — gera o PNG pra
 * comparar com a saída do Python.
 *
 * Uso:
 *   npx tsx src/render-foto.test-manual.ts coracao <saida.png> <foto.jpg> <width> <dx> <dy> <rot>
 *   npx tsx src/render-foto.test-manual.ts recorte <saida.png> <semfundo.png> <width> <dx> <dy> <rot> <uWidth>
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { renderCoracao, renderRecorte } from './render-foto.js'

async function main(): Promise<void> {
  const [modo, saida, entrada, width, dx, dy, rot, uWidth] = process.argv.slice(2)
  if (!modo || !saida || !entrada) {
    console.error('uso: tsx render-foto.test-manual.ts <coracao|recorte> <saida> <foto> [w dx dy rot uW]')
    process.exit(2)
  }
  const params = {
    width: width ? Number(width) : undefined,
    dx: dx ? Number(dx) : 0,
    dy: dy ? Number(dy) : 0,
    rotation: rot ? Number(rot) : 0,
  }
  const foto = readFileSync(entrada)
  const t0 = Date.now()
  const png = modo === 'recorte'
    ? await renderRecorte(foto, params, uWidth ? Number(uWidth) : 600)
    : await renderCoracao(foto, params)
  writeFileSync(saida, png)
  console.log(`OK ${modo} -> ${saida} (${(png.length / 1024).toFixed(0)}KB, ${Date.now() - t0}ms)`)
}

void main()
