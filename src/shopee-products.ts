import './style.css'

import { checkAuth, login } from './api'
import { openPromptDialog } from './dialog'

export interface CatalogProduct {
  itemId: number
  name: string
  imageUrl: string
  price: number | null
  stock: number | null
  sku: string
  hasModel: boolean
  models: Array<{ modelId: number; modelSku: string }>
  status: string
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'include', ...init })
  if (response.status === 401) throw new Error('Login necessário')
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; ok?: boolean }
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data
}

async function saveProductSku(itemId: number, sku: string): Promise<void> {
  await api<{ ok: boolean }>('/shopee/products/sku', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId, sku }),
  })
}

async function saveProductSkusSequential(
  updates: Array<{ itemId: number; sku: string }>,
  onProgress: (done: number, total: number) => void,
): Promise<Array<{ itemId: number; ok: boolean; error?: string }>> {
  const results: Array<{ itemId: number; ok: boolean; error?: string }> = []
  for (let i = 0; i < updates.length; i++) {
    const { itemId, sku } = updates[i]
    try {
      await saveProductSku(itemId, sku)
      results.push({ itemId, ok: true })
    } catch (error) {
      results.push({ itemId, ok: false, error: (error as Error).message })
    }
    onProgress(i + 1, updates.length)
  }
  return results
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** hasModel=true => value é o menor preço entre as variantes (agregado no backend). */
function formatPrice(value: number | null, hasModel: boolean): string {
  if (value == null) return '—'
  const formatted = value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
  return hasModel ? `A partir de ${formatted}` : formatted
}

function formatStock(value: number | null): string {
  if (value == null) return '—'
  if (value >= 1000) return `Estoque ${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `Estoque ${value}`
}

function showLogin(onSuccess: () => void): void {
  const overlay = document.createElement('div')
  overlay.className = 'login-overlay'
  overlay.innerHTML = `
    <form class="login-card">
      <h2>Planilha Pro — Produtos</h2>
      <label><span>Usuário</span><input id="u" type="text" required autofocus /></label>
      <label><span>Senha</span><input id="p" type="password" required /></label>
      <button type="submit">Entrar</button>
      <div class="login-error" id="err" hidden></div>
    </form>
  `
  const form = overlay.querySelector('form')!
  const err = overlay.querySelector('#err') as HTMLDivElement
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    err.hidden = true
    try {
      await login(
        (overlay.querySelector('#u') as HTMLInputElement).value.trim(),
        (overlay.querySelector('#p') as HTMLInputElement).value,
      )
      overlay.remove()
      onSuccess()
    } catch (error) {
      err.hidden = false
      err.textContent = (error as Error).message
    }
  })
  document.body.appendChild(overlay)
}

async function runBulkSkuSave(
  itemIds: number[],
  sku: string,
  ui: {
    setBusy: (busy: boolean) => void
    setProgress: (done: number, total: number, label?: string) => void
    onSaveBtnLabel: (text: string) => void
  },
): Promise<{ ok: boolean; failed: Array<{ itemId: number; error?: string }> }> {
  const updates = itemIds.map((itemId) => ({ itemId, sku }))
  ui.setBusy(true)
  ui.setProgress(0, updates.length, `Iniciando… 0 de ${updates.length}`)
  ui.onSaveBtnLabel(`0/${updates.length}`)

  const results = await saveProductSkusSequential(updates, (done, total) => {
    ui.setProgress(done, total, `Salvando ${done} de ${total}…`)
    ui.onSaveBtnLabel(`${done}/${total}`)
  })

  const failed = results.filter((r) => !r.ok)
  ui.setBusy(false)
  return { ok: failed.length === 0, failed }
}

async function boot(): Promise<void> {
  const root = document.querySelector('#app')!
  root.innerHTML = `
    <div class="shopee-products-page">
      <div class="shopee-products-sticky-top">
      <header class="app-header">
        <a href="/" class="shopee-test-back">← Planilhas</a>
        <h1>Produtos Shopee</h1>
        <div class="shopee-products-toolbar">
          <input type="search" class="shopee-products-search" id="product-search" placeholder="Buscar por nome…" />
          <select class="shopee-products-sort" id="product-sort">
            <option value="default">Ordem padrão</option>
            <option value="price-asc">Preço: menor → maior</option>
            <option value="price-desc">Preço: maior → menor</option>
          </select>
          <label class="shopee-products-select-all">
            <input type="checkbox" id="select-all" /> Selecionar todos
          </label>
          <button type="button" class="btn" id="btn-refresh">Atualizar</button>
        </div>
      </header>
      <section class="shopee-products-bulk-bar" id="bulk-bar" hidden>
        <p class="shopee-products-bulk-hint">
          <strong id="bulk-count">0</strong> produto(s) selecionado(s) — digite um SKU e salve em todos de uma vez (principal + variantes).
        </p>
        <div class="shopee-products-bulk-bar-row">
          <label class="shopee-products-bulk-apply-label">
            <span>Novo SKU (todos os selecionados)</span>
            <input type="text" id="bulk-sku-input" maxlength="100" placeholder="Ex.: CAMISETA-AZUL-M" />
          </label>
          <button type="button" class="btn btn-primary" id="btn-bulk-save">Salvar na Shopee</button>
        </div>
        <div class="shopee-products-bulk-progress" id="bulk-progress" hidden>
          <div class="shopee-products-bulk-progress-track">
            <div class="shopee-products-bulk-progress-bar" id="bulk-progress-bar"></div>
          </div>
          <p class="shopee-products-bulk-progress-text" id="bulk-progress-text"></p>
        </div>
      </section>
      </div>
      <main class="shopee-products-main">
        <p class="shopee-products-status" id="status">Carregando produtos…</p>
        <div class="shopee-products-grid" id="grid"></div>
      </main>
    </div>
  `

  const statusEl = root.querySelector('#status') as HTMLParagraphElement
  const gridEl = root.querySelector('#grid') as HTMLDivElement
  const searchInput = root.querySelector('#product-search') as HTMLInputElement
  const sortSelect = root.querySelector('#product-sort') as HTMLSelectElement
  const selectAllEl = root.querySelector('#select-all') as HTMLInputElement
  const bulkBar = root.querySelector('#bulk-bar') as HTMLElement
  const bulkCountEl = root.querySelector('#bulk-count') as HTMLElement
  const bulkSkuInput = root.querySelector('#bulk-sku-input') as HTMLInputElement
  const bulkSaveBtn = root.querySelector('#btn-bulk-save') as HTMLButtonElement
  const progressWrap = root.querySelector('#bulk-progress') as HTMLDivElement
  const progressBar = root.querySelector('#bulk-progress-bar') as HTMLDivElement
  const progressText = root.querySelector('#bulk-progress-text') as HTMLParagraphElement
  const selected = new Set<number>()
  let products: CatalogProduct[] = []
  /** Produtos visíveis após busca/ordenação — "Selecionar todos" e as checagens usam esta lista. */
  let visibleProducts: CatalogProduct[] = []
  let bulkBusy = false

  function setBulkProgress(done: number, total: number, label?: string): void {
    progressWrap.hidden = false
    const pct = total > 0 ? Math.round((done / total) * 100) : 0
    progressBar.style.width = `${pct}%`
    progressText.textContent = label ?? `Salvando ${done} de ${total}…`
  }

  function updateBulkBar(): void {
    const n = selected.size
    bulkBar.hidden = n === 0
    bulkCountEl.textContent = String(n)
    bulkSaveBtn.textContent = n ? `Salvar SKU em ${n} produto(s)` : 'Salvar na Shopee'
    bulkSaveBtn.disabled = bulkBusy || n === 0
    if (n === 0) {
      progressWrap.hidden = true
      progressBar.style.width = '0%'
      progressText.textContent = ''
    }
  }

  function renderCard(p: CatalogProduct): string {
    const checked = selected.has(p.itemId) ? ' checked' : ''
    const img = p.imageUrl
      ? `<img src="${escapeHtml(p.imageUrl)}" alt="" loading="lazy" />`
      : '<div class="shopee-product-no-img">Sem foto</div>'
    return `
      <article class="shopee-product-card" data-id="${p.itemId}">
        <label class="shopee-product-check">
          <input type="checkbox" class="product-select" data-id="${p.itemId}"${checked} />
        </label>
        <div class="shopee-product-image">${img}</div>
        <div class="shopee-product-body">
          <h3 class="shopee-product-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</h3>
          <div class="shopee-product-meta">
            <span class="shopee-product-price">${formatPrice(p.price, p.hasModel)}</span>
            <span class="shopee-product-stock">${formatStock(p.stock)}</span>
          </div>
          <div class="shopee-product-sku">SKU: <code>${escapeHtml(p.sku || '—')}</code></div>
        </div>
        <footer class="shopee-product-footer">
          <button type="button" class="btn shopee-product-edit" data-id="${p.itemId}" title="Editar SKU">✎ SKU</button>
        </footer>
      </article>
    `
  }

  function bindGrid(): void {
    gridEl.querySelectorAll<HTMLInputElement>('.product-select').forEach((cb) => {
      cb.addEventListener('change', () => {
        const id = Number(cb.dataset.id)
        if (cb.checked) selected.add(id)
        else selected.delete(id)
        updateBulkBar()
        selectAllEl.checked = visibleProducts.length > 0 && visibleProducts.every((p) => selected.has(p.itemId))
      })
    })
    gridEl.querySelectorAll<HTMLButtonElement>('.shopee-product-edit').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id)
        const product = products.find((p) => p.itemId === id)
        if (!product) return
        openPromptDialog({
          title: 'Editar SKU',
          label: `Novo SKU (principal + ${product.hasModel ? 'variantes' : 'sem variantes'})`,
          defaultValue: product.sku,
          confirmLabel: 'Salvar',
          onConfirm: async (sku) => {
            await saveProductSku(id, sku)
            // Só atualiza o card salvo — sem recarregar o catálogo inteiro da Shopee.
            // "Atualizar" continua disponível pra buscar tudo de novo quando o usuário quiser.
            product.sku = sku
            applyFilters()
          },
        })
      })
    })
  }

  function renderGrid(): void {
    gridEl.innerHTML = visibleProducts.map(renderCard).join('')
    bindGrid()
  }

  /** Filtra por nome (busca) e ordena por preço — roda sobre `products` sem tocar na seleção. */
  function applyFilters(): void {
    const query = searchInput.value.trim().toLowerCase()
    let list = query ? products.filter((p) => p.name.toLowerCase().includes(query)) : [...products]

    const sortMode = sortSelect.value
    if (sortMode === 'price-asc' || sortMode === 'price-desc') {
      const dir = sortMode === 'price-asc' ? 1 : -1
      list = [...list].sort((a, b) => {
        if (a.price == null && b.price == null) return 0
        if (a.price == null) return 1 // sem preço sempre por último
        if (b.price == null) return -1
        return (a.price - b.price) * dir
      })
    }

    visibleProducts = list
    statusEl.textContent =
      list.length === products.length
        ? `${products.length} produto(s) · NORMAL e UNLIST`
        : `${list.length} de ${products.length} produto(s)`
    renderGrid()
    selectAllEl.checked = visibleProducts.length > 0 && visibleProducts.every((p) => selected.has(p.itemId))
  }

  async function loadCatalog(): Promise<void> {
    statusEl.textContent = 'Carregando produtos da Shopee…'
    gridEl.innerHTML = ''
    selected.clear()
    selectAllEl.checked = false
    updateBulkBar()
    try {
      const data = await api<{ products: CatalogProduct[]; count: number }>('/shopee/products/catalog')
      products = data.products
      applyFilters()
    } catch (error) {
      statusEl.textContent = `Erro: ${(error as Error).message}`
    }
  }

  selectAllEl.addEventListener('change', () => {
    // Afeta só os produtos visíveis (após busca/ordenação) — não mexe na seleção de itens filtrados fora da lista.
    if (selectAllEl.checked) {
      for (const p of visibleProducts) selected.add(p.itemId)
    } else {
      for (const p of visibleProducts) selected.delete(p.itemId)
    }
    gridEl.querySelectorAll<HTMLInputElement>('.product-select').forEach((cb) => {
      cb.checked = selectAllEl.checked
    })
    updateBulkBar()
  })

  searchInput.addEventListener('input', () => applyFilters())
  sortSelect.addEventListener('change', () => applyFilters())

  bulkSkuInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !bulkSaveBtn.disabled) {
      e.preventDefault()
      bulkSaveBtn.click()
    }
  })

  bulkSaveBtn.addEventListener('click', async () => {
    const sku = bulkSkuInput.value.trim()
    if (!sku) {
      alert('Digite o SKU no campo acima.')
      bulkSkuInput.focus()
      return
    }
    if (selected.size === 0) return

    const itemIds = [...selected]
    const { ok, failed } = await runBulkSkuSave(itemIds, sku, {
      setBusy: (busy) => {
        bulkBusy = busy
        bulkSaveBtn.disabled = busy
        bulkSkuInput.disabled = busy
        selectAllEl.disabled = busy
        gridEl.querySelectorAll<HTMLInputElement>('.product-select').forEach((cb) => {
          cb.disabled = busy
        })
      },
      setProgress: setBulkProgress,
      onSaveBtnLabel: (text) => {
        bulkSaveBtn.textContent = text
      },
    })

    bulkSaveBtn.textContent = `Salvar SKU em ${itemIds.length} produto(s)`

    // Atualiza só quem salvou com sucesso — sem recarregar o catálogo inteiro da Shopee.
    const failedIds = new Set(failed.map((f) => f.itemId))
    for (const itemId of itemIds) {
      if (failedIds.has(itemId)) continue
      const product = products.find((p) => p.itemId === itemId)
      if (product) product.sku = sku
    }
    applyFilters()

    if (ok) {
      progressText.textContent = `Concluído — ${itemIds.length} produto(s) atualizado(s).`
      bulkSkuInput.value = ''
      return
    }

    progressText.textContent = `${itemIds.length - failed.length} ok, ${failed.length} falha(s).`
    const errs = failed.map((r) => `#${r.itemId}: ${r.error}`).join('\n')
    alert(`Falhas:\n\n${errs}`)
  })

  root.querySelector('#btn-refresh')!.addEventListener('click', () => void loadCatalog())

  await loadCatalog()
}

void checkAuth().then((ok) => {
  if (ok) void boot()
  else showLogin(() => void boot())
})
