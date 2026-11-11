import { readFile } from 'node:fs/promises'

const token = JSON.parse(await readFile('server/data/mercadolivre-auth.json', 'utf8')).accessToken
const itemId = process.argv[2] || 'MLB7574446550'

const query = `query getFiscalInformationsByItem($itemId: String!, $allVariations: Boolean) {
  getFiscalInformationsByItem(itemId: $itemId, allVariations: $allVariations) {
    itemId variationId type
    components { sku quantity percentageShare
      fiscalInformation { ... on FiscalInformationMLB { sku ncm cest csosn originType originDetail measurementUnit taxRuleId } }
    }
  }
}`

const res = await fetch('https://api.mercadolibre.com/fiscal_information/graphql', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ query, variables: { itemId, allVariations: true } }),
})
console.log(JSON.stringify(await res.json(), null, 2))
