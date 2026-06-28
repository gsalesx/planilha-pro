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

function formatPrice(value: number | null): string {
  if (value == null) return '—'
  return value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
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

function openBulkSkuDialog(
  products: CatalogProduct[],
  selectedIds: Set<number>,
  onDone: () => void,
): void {
  const selected = products.filter((p) => selectedIds.has(p.itemId))
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal modal-wide" role="dialog" aria-modal="true">
      <div class="modal-title">Editar SKU em massa (${selected.length})</div>
      <div class="modal-body">
        <p class="shopee-products-bulk-hint">
          Um SKU para todos os selecionados — aplicado ao principal e às variantes de cada produto.
          Salvamento <strong>um por vez</strong> na Shopee.
        </p>
        <div class="shopee-products-bulk-apply-all">
          <label class="shopee-products-bulk-apply-label">
            <span>Novo SKU (todos)</span>
            <input type="text" id="bulk-sku-all" maxlength="100" placeholder="Digite o SKU..." autofocus />
          </label>
          <button type="button" class="btn" id="bulk-apply-all">Aplicar a todos</button>
        </div>
        <div class="shopee-products-bulk-progress" id="bulk-progress" hidden>
          <div class="shopee-products-bulk-progress-track">
            <div class="shopee-products-bulk-progress-bar" id="bulk-progress-bar"></div>
          </div>
          <p class="shopee-products-bulk-progress-text" id="bulk-progress-text"></p>
        </div>
        <div class="shopee-products-bulk-table-wrap">
          <table class="shopee-products-bulk-table">
            <thead>
              <tr>
                <th>Produto</th>
                <th>SKU atual</th>
                <th>Novo SKU</th>
              </tr>
            </thead>
            <tbody>
              ${selected
                .map(
                  (p) => `
                <tr data-item-id="${p.itemId}">
                  <td class="shopee-products-bulk-name">${escapeHtml(p.name.slice(0, 60))}${p.name.length > 60 ? '…' : ''}</td>
                  <td><code>${escapeHtml(p.sku || '—')}</code>${p.hasModel ? ' <span class="muted">(var.)</span>' : ''}</td>
                  <td><input type="text" class="bulk-sku-input" value="" maxlength="100" placeholder="—" /></td>
                </tr>`,
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn modal-cancel">Cancelar</button>
        <button type="button" class="btn btn-primary modal-confirm">Salvar na Shopee</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  const cancelBtn = overlay.querySelector<HTMLButtonElement>('.modal-cancel')!
  const confirmBtn = overlay.querySelector<HTMLButtonElement>('.modal-confirm')!
  const applyAllInput = overlay.querySelector<HTMLInputElement>('#bulk-sku-all')!
  const applyAllBtn = overlay.querySelector<HTMLButtonElement>('#bulk-apply-all')!
  const progressWrap = overlay.querySelector<HTMLDivElement>('#bulk-progress')!
  const progressBar = overlay.querySelector<HTMLDivElement>('#bulk-progress-bar')!
  const progressText = overlay.querySelector<HTMLParagraphElement>('#bulk-progress-text')!

  function applySkuToAllRows(sku: string): void {
    overlay.querySelectorAll<HTMLInputElement>('.bulk-sku-input').forEach((input) => {
      input.value = sku
    })
  }

  function collectUpdates(): Array<{ itemId: number; sku: string }> {
    const updates: Array<{ itemId: number; sku: string }> = []
    overlay.querySelectorAll<HTMLTableRowElement>('tr[data-item-id]').forEach((tr) => {
      const itemId = Number(tr.dataset.itemId)
      const sku = tr.querySelector<HTMLInputElement>('.bulk-sku-input')?.value.trim() ?? ''
      if (itemId && sku) updates.push({ itemId, sku })
    })
    return updates
  }

  function setProgress(done: number, total: number, label?: string): void {
    progressWrap.hidden = false
    const pct = total > 0 ? Math.round((done / total) * 100) : 0
    progressBar.style.width = `${pct}%`
    progressText.textContent = label ?? `Salvando ${done} de ${total}…`
  }

  applyAllBtn.addEventListener('click', () => {
    const sku = applyAllInput.value.trim()
    if (!sku) {
      applyAllInput.focus()
      return
    }
    applySkuToAllRows(sku)
  })

  applyAllInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      applyAllBtn.click()
    }
  })

  cancelBtn.addEventListener('click', close)
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && !confirmBtn.disabled) close()
  })

  confirmBtn.addEventListener('click', async () => {
    const topSku = applyAllInput.value.trim()
    if (topSku) applySkuToAllRows(topSku)

    const updates = collectUpdates()
    if (!updates.length) {
      alert('Informe o SKU no campo de cima ou em pelo menos um produto.')
      applyAllInput.focus()
      return
    }

    confirmBtn.disabled = true
    cancelBtn.disabled = true
    applyAllBtn.disabled = true
    applyAllInput.disabled = true
    overlay.querySelectorAll<HTMLInputElement>('.bulk-sku-input').forEach((i) => {
      i.disabled = true
    })
    setProgress(0, updates.length, `Iniciando… 0 de ${updates.length}`)

    const results = await saveProductSkusSequential(updates, (done, total) => {
      setProgress(done, total, `Salvando ${done} de ${total}…`)
      confirmBtn.textContent = `${done}/${total}`
    })

    const failed = results.filter((r) => !r.ok)
    if (failed.length === 0) {
      progressText.textContent = `Concluído — ${results.length} produto(s) atualizado(s).`
      confirmBtn.textContent = 'Concluído'
      setTimeout(() => {
        close()
        onDone()
      }, 800)
      return
    }

    progressText.textContent = `${results.length - failed.length} ok, ${failed.length} falha(s).`
    confirmBtn.textContent = 'Salvar na Shopee'
    confirmBtn.disabled = false
    cancelBtn.disabled = false
    applyAllBtn.disabled = false
    applyAllInput.disabled = false
    overlay.querySelectorAll<HTMLInputElement>('.bulk-sku-input').forEach((i) => {
      i.disabled = false
    })
    const errs = failed.map((r) => `#${r.itemId}: ${r.error}`).join('\n')
    alert(`Falhas:\n\n${errs}`)
  })
}

async function boot(): Promise<void> {
  const root = document.querySelector('#app')!
  root.innerHTML = `
    <div class="shopee-products-page">
      <header class="app-header">
        <a href="/" class="shopee-test-back">← Planilhas</a>
        <h1>Produtos Shopee</h1>
        <div class="shopee-products-toolbar">
          <label class="shopee-products-select-all">
            <input type="checkbox" id="select-all" /> Selecionar todos
          </label>
          <button type="button" class="btn" id="btn-refresh">Atualizar</button>
          <button type="button" class="btn btn-primary" id="btn-bulk" disabled>Editar em massa</button>
        </div>
      </header>
      <main class="shopee-products-main">
        <p class="shopee-products-status" id="status">Carregando produtos…</p>
        <div class="shopee-products-grid" id="grid"></div>
      </main>
    </div>
  `

  const statusEl = root.querySelector('#status') as HTMLParagraphElement
  const gridEl = root.querySelector('#grid') as HTMLDivElement
  const selectAllEl = root.querySelector('#select-all') as HTMLInputElement
  const bulkBtn = root.querySelector('#btn-bulk') as HTMLButtonElement
  const selected = new Set<number>()
  let products: CatalogProduct[] = []

  function updateBulkButton(): void {
    bulkBtn.disabled = selected.size === 0
    bulkBtn.textContent = selected.size ? `Editar em massa (${selected.size})` : 'Editar em massa'
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
            <span class="shopee-product-price">${formatPrice(p.price)}</span>
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
        updateBulkButton()
        selectAllEl.checked = selected.size === products.length && products.length > 0
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
            await loadCatalog()
          },
        })
      })
    })
  }

  async function loadCatalog(): Promise<void> {
    statusEl.textContent = 'Carregando produtos da Shopee…'
    gridEl.innerHTML = ''
    selected.clear()
    selectAllEl.checked = false
    updateBulkButton()
    try {
      const data = await api<{ products: CatalogProduct[]; count: number }>('/shopee/products/catalog')
      products = data.products
      statusEl.textContent = `${products.length} produto(s) · NORMAL e UNLIST`
      gridEl.innerHTML = products.map(renderCard).join('')
      bindGrid()
    } catch (error) {
      statusEl.textContent = `Erro: ${(error as Error).message}`
    }
  }

  selectAllEl.addEventListener('change', () => {
    if (selectAllEl.checked) {
      for (const p of products) selected.add(p.itemId)
    } else {
      selected.clear()
    }
    gridEl.querySelectorAll<HTMLInputElement>('.product-select').forEach((cb) => {
      cb.checked = selectAllEl.checked
    })
    updateBulkButton()
  })

  bulkBtn.addEventListener('click', () => {
    openBulkSkuDialog(products, selected, () => void loadCatalog())
  })

  root.querySelector('#btn-refresh')!.addEventListener('click', () => void loadCatalog())

  await loadCatalog()
}

void checkAuth().then((ok) => {
  if (ok) void boot()
  else showLogin(() => void boot())
})
