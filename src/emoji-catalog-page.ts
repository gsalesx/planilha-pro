import './style.css'

import {
  checkAuth,
  createCustomEmoji,
  deleteCustomEmoji,
  getEmojiCatalog,
  login,
  updateEmojiAliases,
  type EmojiCatalogItem,
} from './api'
import { openConfirmDialog, openPromptDialog } from './dialog'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function normalizeName(text: string): string {
  return text
    .normalize('NFKD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toLowerCase()
    .trim()
}

function showLogin(onSuccess: () => void): void {
  const overlay = document.createElement('div')
  overlay.className = 'login-overlay'
  overlay.innerHTML = `
    <form class="login-card">
      <h2>Planilha Pro — Catálogo de emojis</h2>
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

async function boot(): Promise<void> {
  const root = document.querySelector('#app')!
  root.innerHTML = `
    <div class="emoji-catalog-page">
      <header class="app-header">
        <a href="/" class="shopee-test-back">← Planilhas</a>
        <h1>Catálogo de emojis</h1>
        <div class="emoji-catalog-toolbar">
          <input type="text" class="emoji-catalog-search" id="search" placeholder="buscar por nome…" />
          <label class="emoji-catalog-filter">
            <input type="checkbox" id="filter-unmapped" /> só sem atalho
          </label>
        </div>
      </header>
      <main class="emoji-catalog-main">
        <p class="emoji-catalog-status" id="status">Carregando…</p>

        <section class="emoji-catalog-upload">
          <h2>+ Subir emoji customizado</h2>
          <form class="emoji-catalog-upload-form" id="upload-form">
            <input type="text" id="upload-name" placeholder="nome (ex: UNICÓRNIO)" required />
            <input type="text" id="upload-alias" placeholder="atalho inicial (emoji, opcional)" />
            <input type="file" id="upload-file" accept="image/*" required />
            <button type="submit" class="btn btn-primary">Adicionar</button>
          </form>
          <p class="emoji-catalog-upload-status" id="upload-status" hidden></p>
        </section>

        <div class="emoji-catalog-grid" id="grid"></div>
      </main>
    </div>
  `

  const statusEl = root.querySelector('#status') as HTMLParagraphElement
  const gridEl = root.querySelector('#grid') as HTMLDivElement
  const searchEl = root.querySelector('#search') as HTMLInputElement
  const filterUnmappedEl = root.querySelector('#filter-unmapped') as HTMLInputElement
  const uploadForm = root.querySelector('#upload-form') as HTMLFormElement
  const uploadNameEl = root.querySelector('#upload-name') as HTMLInputElement
  const uploadAliasEl = root.querySelector('#upload-alias') as HTMLInputElement
  const uploadFileEl = root.querySelector('#upload-file') as HTMLInputElement
  const uploadStatusEl = root.querySelector('#upload-status') as HTMLParagraphElement

  let catalog: EmojiCatalogItem[] = []

  function renderCard(item: EmojiCatalogItem): string {
    const chips = item.aliases
      .map(
        (alias) => `
        <span class="emoji-catalog-chip" data-id="${item.id}" data-alias="${escapeHtml(alias)}">
          ${escapeHtml(alias)}
          <button type="button" class="emoji-catalog-chip-remove" data-id="${item.id}" data-alias="${escapeHtml(alias)}" title="Remover atalho">×</button>
        </span>`,
      )
      .join('')
    const hasAliases = item.aliases.length > 0
    const inlineMap = hasAliases
      ? ''
      : `
        <form class="emoji-catalog-inline-map" data-id="${item.id}">
          <input type="text" class="emoji-catalog-inline-input" placeholder="colar emoji…" />
          <button type="submit" class="btn btn-primary">mapear</button>
        </form>
      `
    return `
      <article class="emoji-catalog-card" data-id="${item.id}">
        <img class="emoji-catalog-card-img" src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" />
        <div class="emoji-catalog-card-name">${escapeHtml(item.name)}</div>
        <span class="emoji-catalog-card-source emoji-catalog-card-source--${item.source}">${item.source === 'builtin' ? 'padrão' : 'customizado'}</span>
        <div class="emoji-catalog-card-aliases">
          ${chips || '<span class="emoji-catalog-card-empty">sem atalho mapeado</span>'}
        </div>
        ${inlineMap}
        <div class="emoji-catalog-card-actions">
          ${hasAliases ? `<button type="button" class="btn emoji-catalog-add-alias" data-id="${item.id}">+ atalho</button>` : ''}
          ${item.source === 'custom' ? `<button type="button" class="btn btn-danger emoji-catalog-delete" data-id="${item.id}">Excluir</button>` : ''}
        </div>
      </article>
    `
  }

  function applyFilter(): void {
    const q = normalizeName(searchEl.value)
    const onlyUnmapped = filterUnmappedEl.checked
    const filtered = catalog.filter((item) => {
      if (onlyUnmapped && item.aliases.length > 0) return false
      if (q && !normalizeName(item.name).includes(q)) return false
      return true
    })
    gridEl.innerHTML = filtered.length
      ? filtered.map(renderCard).join('')
      : '<p class="emoji-catalog-empty">nenhum emoji encontrado</p>'
    bindCards()
    const mapped = catalog.filter((i) => i.aliases.length > 0).length
    statusEl.textContent = `${catalog.length} emoji(s) no catálogo — ${mapped} com atalho mapeado, ${catalog.length - mapped} sem atalho ainda`
  }

  function bindCards(): void {
    gridEl.querySelectorAll<HTMLButtonElement>('.emoji-catalog-add-alias').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id)
        const item = catalog.find((i) => i.id === id)
        if (!item) return
        openPromptDialog({
          title: `Novo atalho — ${item.name}`,
          label: 'Cole o emoji que o cliente costuma mandar no chat',
          confirmLabel: 'Salvar',
          onConfirm: async (value) => {
            try {
              const aliases = [...item.aliases, value.trim()]
              const { item: updated } = await updateEmojiAliases(id, aliases)
              catalog = catalog.map((i) => (i.id === id ? updated : i))
              applyFilter()
            } catch (error) {
              alert((error as Error).message)
            }
          },
        })
      })
    })
    gridEl.querySelectorAll<HTMLFormElement>('.emoji-catalog-inline-map').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault()
        const id = Number(form.dataset.id)
        const item = catalog.find((i) => i.id === id)
        const input = form.querySelector<HTMLInputElement>('.emoji-catalog-inline-input')!
        const value = input.value.trim()
        if (!item || !value) return
        const btn = form.querySelector<HTMLButtonElement>('button[type=submit]')!
        input.disabled = true
        btn.disabled = true
        try {
          const aliases = [...item.aliases, value]
          const { item: updated } = await updateEmojiAliases(id, aliases)
          catalog = catalog.map((i) => (i.id === id ? updated : i))
          applyFilter()
        } catch (error) {
          alert((error as Error).message)
          input.disabled = false
          btn.disabled = false
        }
      })
    })
    gridEl.querySelectorAll<HTMLButtonElement>('.emoji-catalog-chip-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = Number(btn.dataset.id)
        const alias = btn.dataset.alias!
        const item = catalog.find((i) => i.id === id)
        if (!item) return
        btn.disabled = true
        try {
          const aliases = item.aliases.filter((a) => a !== alias)
          const { item: updated } = await updateEmojiAliases(id, aliases)
          catalog = catalog.map((i) => (i.id === id ? updated : i))
          applyFilter()
        } catch (error) {
          alert((error as Error).message)
          btn.disabled = false
        }
      })
    })
    gridEl.querySelectorAll<HTMLButtonElement>('.emoji-catalog-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        const id = Number(btn.dataset.id)
        const item = catalog.find((i) => i.id === id)
        if (!item) return
        openConfirmDialog({
          title: 'Excluir emoji customizado',
          body: `Remover "${escapeHtml(item.name)}" do catálogo? Peças que já usam esse emoji não são alteradas.`,
          confirmLabel: 'Excluir',
          danger: true,
          onConfirm: async () => {
            await deleteCustomEmoji(id)
            catalog = catalog.filter((i) => i.id !== id)
            applyFilter()
          },
        })
      })
    })
  }

  async function loadCatalog(): Promise<void> {
    statusEl.textContent = 'Carregando…'
    try {
      const data = await getEmojiCatalog()
      catalog = data.items
      applyFilter()
    } catch (error) {
      statusEl.textContent = `Erro: ${(error as Error).message}`
    }
  }

  searchEl.addEventListener('input', applyFilter)
  filterUnmappedEl.addEventListener('change', applyFilter)

  uploadForm.addEventListener('submit', async (e) => {
    e.preventDefault()
    const file = uploadFileEl.files?.[0]
    const name = uploadNameEl.value.trim().toUpperCase()
    const alias = uploadAliasEl.value.trim()
    if (!file || !name) return
    const submitBtn = uploadForm.querySelector<HTMLButtonElement>('button[type=submit]')!
    submitBtn.disabled = true
    uploadStatusEl.hidden = true
    try {
      const { item } = await createCustomEmoji(file, name, alias ? [alias] : undefined)
      catalog = [...catalog, item]
      uploadForm.reset()
      applyFilter()
    } catch (error) {
      uploadStatusEl.hidden = false
      uploadStatusEl.textContent = `Erro: ${(error as Error).message}`
    } finally {
      submitBtn.disabled = false
    }
  })

  await loadCatalog()
}

void checkAuth().then((ok) => {
  if (ok) void boot()
  else showLogin(() => void boot())
})
