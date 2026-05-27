import {
  AuthRequiredError,
  createWorkbook,
  deleteWorkbook,
  duplicateWorkbook,
  listWorkbooks,
  renameWorkbook,
  type WorkbookSummary,
} from './api'

type OpenHandler = (workbookId: string) => void
type AuthLostHandler = () => void

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function formatTimestamp(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
}

function openConfirmDialog(opts: {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<void> | void
}) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">${opts.title}</div>
      <div class="modal-body">${opts.body}</div>
      <div class="modal-actions">
        <button type="button" class="btn modal-cancel">Cancelar</button>
        <button type="button" class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'} modal-confirm">${opts.confirmLabel}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  overlay.querySelector('.modal-cancel')!.addEventListener('click', close)
  const confirmBtn = overlay.querySelector<HTMLButtonElement>('.modal-confirm')!
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true
    try {
      await opts.onConfirm()
    } finally {
      close()
    }
  })
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close()
      document.removeEventListener('keydown', onKey)
    }
  }
  document.addEventListener('keydown', onKey)
  confirmBtn.focus()
}

function openPromptDialog(opts: {
  title: string
  label: string
  defaultValue?: string
  confirmLabel: string
  onConfirm: (value: string) => Promise<void> | void
}) {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">${opts.title}</div>
      <div class="modal-body">
        <label class="modal-prompt-label">
          <span>${opts.label}</span>
          <input type="text" class="modal-prompt-input" />
        </label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn modal-cancel">Cancelar</button>
        <button type="button" class="btn btn-primary modal-confirm">${opts.confirmLabel}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  const input = overlay.querySelector<HTMLInputElement>('.modal-prompt-input')!
  input.value = opts.defaultValue ?? ''
  const close = () => overlay.remove()
  const confirmBtn = overlay.querySelector<HTMLButtonElement>('.modal-confirm')!
  const submit = async () => {
    const value = input.value.trim()
    if (!value) {
      input.focus()
      return
    }
    confirmBtn.disabled = true
    try {
      await opts.onConfirm(value)
    } finally {
      close()
    }
  }
  overlay.querySelector('.modal-cancel')!.addEventListener('click', close)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  confirmBtn.addEventListener('click', () => void submit())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  input.focus()
  input.select()
}

export function showWorkbooksList(opts: {
  root: HTMLElement
  onOpen: OpenHandler
  onAuthLost: AuthLostHandler
  onLogout: () => void
}): void {
  const { root, onOpen, onAuthLost, onLogout } = opts

  root.innerHTML = `
    <div class="workbooks-page">
      <header class="app-header">
        <h1>Planilha Pro</h1>
        <div class="workbooks-header-spacer"></div>
        <div class="toolbar-actions">
          <button class="btn btn-primary" id="wb-new-btn">+ Nova planilha</button>
          <button class="btn" id="wb-logout-btn" title="Sair">Sair</button>
        </div>
      </header>
      <main class="workbooks-main">
        <h2 class="workbooks-title">Minhas planilhas</h2>
        <div class="workbooks-grid" id="wb-grid">
          <div class="workbooks-loading">Carregando...</div>
        </div>
      </main>
    </div>
  `

  const grid = root.querySelector<HTMLDivElement>('#wb-grid')!
  const newBtn = root.querySelector<HTMLButtonElement>('#wb-new-btn')!
  const logoutBtn = root.querySelector<HTMLButtonElement>('#wb-logout-btn')!

  logoutBtn.addEventListener('click', () => {
    onLogout()
  })

  function handleError(error: unknown, fallback: string) {
    if (error instanceof AuthRequiredError) {
      onAuthLost()
      return
    }
    console.error(error)
    alert(`${fallback}: ${(error as Error).message ?? 'erro desconhecido'}`)
  }

  async function refresh() {
    try {
      const workbooks = await listWorkbooks()
      renderGrid(workbooks)
    } catch (error) {
      handleError(error, 'Falha ao carregar planilhas')
    }
  }

  function renderGrid(workbooks: WorkbookSummary[]) {
    if (workbooks.length === 0) {
      grid.innerHTML = `
        <div class="workbooks-empty">
          <p>Você ainda não tem planilhas.</p>
          <button class="btn btn-primary" id="wb-empty-new">+ Criar primeira planilha</button>
        </div>
      `
      root.querySelector<HTMLButtonElement>('#wb-empty-new')?.addEventListener('click', promptNew)
      return
    }
    grid.innerHTML = workbooks
      .map(
        (wb) => `
        <article class="workbook-card" data-id="${escapeHtml(wb.id)}">
          <header class="workbook-card-head">
            <h3 class="workbook-card-name" title="${escapeHtml(wb.name)}">${escapeHtml(wb.name)}</h3>
            <span class="workbook-card-count">${wb.count} pedidos</span>
          </header>
          <p class="workbook-card-meta">Atualizada em ${formatTimestamp(wb.updatedAt)}</p>
          <div class="workbook-card-actions">
            <button class="btn btn-primary wb-open">Abrir</button>
            <button class="btn wb-rename" title="Renomear">Renomear</button>
            <button class="btn wb-duplicate" title="Duplicar (backup)">Duplicar</button>
            <button class="btn btn-danger wb-delete" title="Deletar planilha">Deletar</button>
          </div>
        </article>
      `,
      )
      .join('')

    grid.querySelectorAll<HTMLElement>('.workbook-card').forEach((card) => {
      const id = card.dataset.id!
      const wb = workbooks.find((w) => w.id === id)!
      card.querySelector<HTMLButtonElement>('.wb-open')!.addEventListener('click', () => onOpen(id))
      card.querySelector<HTMLButtonElement>('.wb-rename')!.addEventListener('click', () =>
        openPromptDialog({
          title: 'Renomear planilha',
          label: 'Novo nome',
          defaultValue: wb.name,
          confirmLabel: 'Renomear',
          onConfirm: async (name) => {
            try {
              await renameWorkbook(id, name)
              await refresh()
            } catch (error) {
              handleError(error, 'Falha ao renomear')
            }
          },
        }),
      )
      card.querySelector<HTMLButtonElement>('.wb-duplicate')!.addEventListener('click', () =>
        openPromptDialog({
          title: 'Duplicar planilha',
          label: 'Nome da cópia',
          defaultValue: `${wb.name} (cópia)`,
          confirmLabel: 'Duplicar',
          onConfirm: async (name) => {
            try {
              await duplicateWorkbook(id, name)
              await refresh()
            } catch (error) {
              handleError(error, 'Falha ao duplicar')
            }
          },
        }),
      )
      card.querySelector<HTMLButtonElement>('.wb-delete')!.addEventListener('click', () =>
        openConfirmDialog({
          title: `Deletar "${wb.name}"?`,
          body: `Vai apagar <strong>${wb.count} pedidos</strong>, etiquetas e fotos desta planilha. Esta ação não pode ser desfeita.`,
          confirmLabel: 'Deletar',
          danger: true,
          onConfirm: async () => {
            try {
              await deleteWorkbook(id)
              await refresh()
            } catch (error) {
              handleError(error, 'Falha ao deletar')
            }
          },
        }),
      )
    })
  }

  function promptNew() {
    openPromptDialog({
      title: 'Nova planilha',
      label: 'Nome',
      defaultValue: '',
      confirmLabel: 'Criar',
      onConfirm: async (name) => {
        try {
          const wb = await createWorkbook(name)
          await refresh()
          onOpen(wb.id)
        } catch (error) {
          handleError(error, 'Falha ao criar planilha')
        }
      },
    })
  }

  newBtn.addEventListener('click', promptNew)
  void refresh()
}
