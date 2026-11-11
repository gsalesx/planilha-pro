#!/usr/bin/env node
/** Cria guias de tamanho ML para famílias além de CAMISOLA. */
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import XLSX from 'xlsx'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const AUTH_FILE = path.join(ROOT, 'server', 'data', 'mercadolivre-auth.json')
const OUT_FILE = path.join(ROOT, 'server', 'data', 'ml-family-charts.json')
const DOWNLOADS = process.env.SHOPEE_EXPORT_DIR || 'C:/Users/gsale/Downloads'
const SHOPEE_SHOP = process.env.SHOPEE_SHOP_ID || '326873777'
const API = 'https://api.mercadolibre.com'

function filtrableFromSize(size) {
  const m = String(size).match(/\b(P|PP|M|G|GG)\b/i)
  return m ? m[1].toUpperCase().replace('PP', 'P') : 'M'
}

function pajamaRow(size, i) {
  return {
    attributes: [
      { id: 'SIZE', values: [{ name: size }] },
      { id: 'FILTRABLE_SIZE', values: [{ name: filtrableFromSize(size) }] },
      { id: 'BUST_CIRCUMFERENCE_FROM', values: [{ name: `${80 + i} cm` }] },
      { id: 'HIP_CIRCUMFERENCE_FROM', values: [{ name: `${90 + i} cm` }] },
    ],
  }
}

function shortRow(size, i) {
  const filtrable = size.match(/^\d/)
    ? String(size).split(/\s+/)[0]
    : filtrableFromSize(size)
  return {
    attributes: [
      { id: 'SIZE', values: [{ name: size }] },
      { id: 'FILTRABLE_SIZE', values: [{ name: filtrable }] },
      { id: 'WAIST_CIRCUMFERENCE_FROM', values: [{ name: `${70 + i} cm` }] },
      { id: 'HIP_CIRCUMFERENCE_FROM', values: [{ name: `${90 + i} cm` }] },
    ],
  }
}

async function loadSalesRows() {
  const files = await readdir(DOWNLOADS)
  const salesFiles = files.filter(
    (n) => n.startsWith('mass_update_sales_info') && n.includes(SHOPEE_SHOP) && n.endsWith('.xlsx'),
  )
  const rows = []
  for (const sf of salesFiles) {
    const wb = XLSX.readFile(path.join(DOWNLOADS, sf))
    rows.push(
      ...XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' }).slice(6),
    )
  }
  return rows
}

function normCasal(name) {
  return String(name)
    .replace(/Feminino/gi, 'Fem')
    .replace(/Masculino/gi, 'Masc')
    .replace(/\s+/g, ' ')
    .trim()
}

async function createChart(token, { name, domain, gender, sizes, rowFn }) {
  const body = {
    names: { MLB: name.slice(0, 55) },
    domain_id: domain,
    site_id: 'MLB',
    attributes: [
      { id: 'GENDER', values: [{ id: gender.id, name: gender.name }] },
      { id: 'BRAND', values: [{ id: '35977846', name: 'Generic' }] },
    ],
    main_attribute: { attributes: [{ site_id: 'MLB', id: 'SIZE' }] },
    rows: sizes.map((s, i) => rowFn(s, i)),
  }
  const res = await fetch(`${API}/catalog/charts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`${name}: ${JSON.stringify(json.errors?.slice(0, 2) || json.message)}`)
  const rowBySize = {}
  for (const row of json.rows) {
    const sz = row.attributes.find((a) => a.id === 'SIZE')?.values?.[0]?.name
    rowBySize[sz] = row.id
  }
  return { id: json.id, rowBySize }
}

async function main() {
  const token = JSON.parse(await readFile(AUTH_FILE, 'utf8')).accessToken
  const basic = XLSX.readFile(
    path.join(
      DOWNLOADS,
      (await readdir(DOWNLOADS)).find((n) => n.startsWith('mass_update_basic_info') && n.includes(SHOPEE_SHOP)),
    ),
  )
  const idToFam = new Map(
    XLSX.utils
      .sheet_to_json(basic.Sheets[basic.SheetNames[0]], { header: 1, defval: '' })
      .slice(6)
      .filter((r) => r[0])
      .map((r) => [String(r[0]), String(r[1] || '').trim()]),
  )
  const salesRows = await loadSalesRows()
  const casalSizes = new Set()
  for (const r of salesRows) {
    const fam = idToFam.get(String(r[0]))
    if (fam === 'SHORT CASAL' || fam === 'CONJUNTO COMPLETO CASAL') {
      casalSizes.add(normCasal(String(r[3])))
    }
  }

  const sizes16 = [
    'P,P', 'P,M', 'P,G', 'P,GG', 'M,P', 'M,M', 'M,G', 'M,GG',
    'G,P', 'G,M', 'G,G', 'G,GG', 'GG,P', 'GG,M', 'GG,GG',
  ]
  const kidSizes = ['2 ANOS', '4 ANOS', '6 ANOS', '8 ANOS', '10 ANOS', '12 ANOS', '14 ANOS']
  const adult = ['P', 'M', 'G', 'GG']

  const tag = ' PP v3'
  const out = {
    camisolaShort: await createChart(token, {
      name: `Guia Camisola Short 16${tag}`,
      domain: 'PAJAMAS',
      gender: { id: '110461', name: 'Sem gênero' },
      sizes: sizes16,
      rowFn: pajamaRow,
    }),
    casal: await createChart(token, {
      name: `Guia Casal 64${tag}`,
      domain: 'PAJAMAS',
      gender: { id: '110461', name: 'Sem gênero' },
      sizes: [...casalSizes].sort(),
      rowFn: pajamaRow,
    }),
    shortMasc: await createChart(token, {
      name: `Guia Short Masc full${tag}`,
      domain: 'SHORTS',
      gender: { id: '339666', name: 'Masculino' },
      sizes: [...adult, ...kidSizes],
      rowFn: shortRow,
    }),
    shortFem: await createChart(token, {
      name: `Guia Short Fem full${tag}`,
      domain: 'SHORTS',
      gender: { id: '339665', name: 'Feminino' },
      sizes: [...adult, ...kidSizes],
      rowFn: shortRow,
    }),
    conjUnitMasc: await createChart(token, {
      name: `Guia Conj Unit Masc${tag}`,
      domain: 'PAJAMAS',
      gender: { id: '339666', name: 'Masculino' },
      sizes: adult,
      rowFn: pajamaRow,
    }),
    conjUnitFem: await createChart(token, {
      name: `Guia Conj Unit Fem${tag}`,
      domain: 'PAJAMAS',
      gender: { id: '339665', name: 'Feminino' },
      sizes: adult,
      rowFn: pajamaRow,
    }),
  }

  await writeFile(OUT_FILE, JSON.stringify(out, null, 2))
  console.log(JSON.stringify(Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.id])), null, 2))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
