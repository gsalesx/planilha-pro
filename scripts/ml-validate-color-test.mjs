#!/usr/bin/env node
/** Teste pontual: COLOR no item + variação via POST /items/validate */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const AUTH_FILE = path.join(__dirname, '..', 'server', 'data', 'mercadolivre-auth.json')
const API = 'https://api.mercadolibre.com'
const PIJAMAS = 'MLB278112'
const CAMISOLA = 'MLB278114'

const raw = JSON.parse(await readFile(AUTH_FILE, 'utf8'))
const token = raw.accessToken

async function api(method, urlPath, body) {
  const res = await fetch(`${API}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json()
  return { status: res.status, ok: res.ok, json }
}

function buildPayload({ categoryId, chartId, rowId, pictureId, mode, gender, model }) {
  const attrs = [
    { id: 'BRAND', value_id: '35977846', value_name: 'Generic' },
    { id: 'MODEL', value_name: model },
    { id: 'GENDER', value_id: gender.id, value_name: gender.name },
    { id: 'SIZE_GRID_ID', value_name: chartId },
  ]
  if (categoryId === PIJAMAS) {
    attrs.push({ id: 'SEASON', value_id: '994283', value_name: 'Primavera/Verão' })
  }
  if (mode === 'both' || mode === 'item') {
    attrs.push({ id: 'COLOR', value_name: 'Personalizado' })
  }

  const combos = []
  if (mode === 'both' || mode === 'variation') {
    combos.push({ id: 'COLOR', value_name: 'Personalizado' })
  }
  combos.push({ id: 'SIZE', value_name: 'M' })

  return {
    title: 'Teste Cor Dupla Validate',
    category_id: categoryId,
    price: 69.9,
    currency_id: 'BRL',
    available_quantity: 1,
    buying_mode: 'buy_it_now',
    condition: 'new',
    listing_type_id: 'gold_special',
    shipping: { mode: 'me2', local_pick_up: false, free_shipping: true },
    pictures: [{ id: pictureId }],
    sale_terms: [
      { id: 'WARRANTY_TYPE', value_name: 'Garantia do vendedor' },
      { id: 'WARRANTY_TIME', value_name: '90 dias' },
      { id: 'MANUFACTURING_TIME', value_name: '5 dias' },
    ],
    attributes: attrs,
    variations: [
      {
        attribute_combinations: combos,
        price: 69.9,
        available_quantity: 10,
        attributes: [{ id: 'SIZE_GRID_ROW_ID', value_name: rowId }],
        picture_ids: [pictureId],
      },
    ],
  }
}

function colorCauses(causes) {
  return causes.filter(
    (c) =>
      String(c.message || '').includes('Same attributes') ||
      String(c.code || '').includes('attributes') ||
      c.code === 'item.attributes.invalid',
  )
}

// Item de referência SHORT
const short = await api('GET', '/items/MLB5178227105?include_attributes=all')
console.log('=== MLB5178227105 (SHORT working) ===')
console.log('category:', short.json.category_id)
console.log('item COLOR:', short.json.attributes?.find((a) => a.id === 'COLOR')?.value_name || '(none)')
const v0 = short.json.variations?.[0]
console.log(
  'var COLOR combo:',
  v0?.attribute_combinations?.find((a) => a.id === 'COLOR')?.value_name || '(none)',
)

const GENDER = {
  FEM: { id: '339665', name: 'Feminino' },
  MASC: { id: '339666', name: 'Masculino' },
}

const tests = [
  [
    'PIJAMAS both',
    buildPayload({
      categoryId: PIJAMAS,
      chartId: '7653201',
      rowId: '7653201:2',
      pictureId: '782129-MLB115631992836_092026',
      mode: 'both',
      gender: GENDER.MASC,
      model: 'Short pijama personalizado',
    }),
  ],
  [
    'PIJAMAS variation-only',
    buildPayload({
      categoryId: PIJAMAS,
      chartId: '7653201',
      rowId: '7653201:2',
      pictureId: '782129-MLB115631992836_092026',
      mode: 'variation',
      gender: GENDER.MASC,
      model: 'Short pijama personalizado',
    }),
  ],
  [
    'PIJAMAS item-only',
    buildPayload({
      categoryId: PIJAMAS,
      chartId: '7653201',
      rowId: '7653201:2',
      pictureId: '782129-MLB115631992836_092026',
      mode: 'item',
      gender: GENDER.MASC,
      model: 'Short pijama personalizado',
    }),
  ],
  [
    'CAMISOLA both',
    buildPayload({
      categoryId: CAMISOLA,
      chartId: '7650233',
      rowId: '7650233:2',
      pictureId: '773317-MLB115631986552_092026',
      mode: 'both',
      gender: GENDER.FEM,
      model: 'Camisola personalizada',
    }),
  ],
  [
    'CAMISOLA variation-only',
    buildPayload({
      categoryId: CAMISOLA,
      chartId: '7650233',
      rowId: '7650233:2',
      pictureId: '773317-MLB115631986552_092026',
      mode: 'variation',
      gender: GENDER.FEM,
      model: 'Camisola personalizada',
    }),
  ],
  [
    'CAMISOLA item-only',
    buildPayload({
      categoryId: CAMISOLA,
      chartId: '7650233',
      rowId: '7650233:2',
      pictureId: '773317-MLB115631986552_092026',
      mode: 'item',
      gender: GENDER.FEM,
      model: 'Camisola personalizada',
    }),
  ],
]

for (const [name, payload] of tests) {
  const r = await api('POST', '/items/validate', payload)
  const allCauses = r.json.cause || []
  const colorErr = colorCauses(allCauses)
  const other = allCauses.filter((c) => !colorCauses([c]).length)
  console.log(`\n=== ${name} (${payload.category_id}) status=${r.status} ===`)
  if (colorErr.length) {
    console.log('ERRO COR (146):', colorErr.map((c) => c.message).join(' | '))
  } else if (r.ok) {
    console.log('OK — validate passou (inclui COR em ambos se mode=both)')
  } else {
    console.log('Sem erro 146 de COR')
  }
  if (other.length) {
    console.log('Outros:', other.map((c) => `${c.code}: ${c.message}`).join(' | '))
  }
}
