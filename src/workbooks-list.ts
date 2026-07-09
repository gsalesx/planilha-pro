import {
  AuthRequiredError,
  deleteWorkbook,
  duplicateWorkbook,
  listWorkbooks,
  renameWorkbook,
  type WorkbookSummary,
} from './api'
import { openConfirmDialog, openPromptDialog } from './dialog'

type OpenHandler = (workbookId: string) => void
type AuthLostHandler = () => void
type CreateFromXlsxHandler = (file: File) => Promise<void>

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

export function showWorkbooksList(opts: {
  root: HTMLElement
  onOpen: OpenHandler
  onCreateFromXlsx: CreateFromXlsxHandler
  onAuthLost: AuthLostHandler
  onLogout: () => void
}): void {
  const { root, onOpen, onCreateFromXlsx, onAuthLost, onLogout } = opts

  root.innerHTML = `
    <div class="workbooks-page">
      <header class="app-header">
        <h1>Planilha Pro</h1>
        <div class="workbooks-header-spacer"></div>
        <div class="toolbar-actions">
          <a class="btn" href="/shopee-products.html" title="Gerenciar produtos da loja Shopee">Produtos Shopee</a>
          <a class="btn" href="/emoji-catalog.html" title="Ver e editar o catálogo de emojis (mapeamentos)">Emojis</a>
          <label class="btn btn-primary" id="wb-new-btn" title="Crie uma planilha nova a partir de um XLSX">
            <input type="file" id="wb-new-file" accept=".xlsx,.xls" hidden />
            + Nova planilha (XLSX)
          </label>
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
  const newFileInput = root.querySelector<HTMLInputElement>('#wb-new-file')!
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
          <label class="btn btn-primary">
            <input type="file" id="wb-empty-new" accept=".xlsx,.xls" hidden />
            + Criar primeira planilha (XLSX)
          </label>
        </div>
      `
      const emptyInput = root.querySelector<HTMLInputElement>('#wb-empty-new')!
      emptyInput.addEventListener('change', () => {
        const file = emptyInput.files?.[0]
        emptyInput.value = ''
        if (file) void handleNewFile(file)
      })
      return
    }
    grid.innerHTML = workbooks
      .map(
        (wb) => `
        <article class="workbook-card${wb.system ? ' workbook-card--system' : ''}" data-id="${escapeHtml(wb.id)}">
          <header class="workbook-card-head">
            <h3 class="workbook-card-name" title="${escapeHtml(wb.name)}">${escapeHtml(wb.name)}</h3>
            ${wb.system ? '<span class="workbook-card-badge">Automática</span>' : ''}
            <span class="workbook-card-count">${wb.count} pedidos</span>
          </header>
          <p class="workbook-card-meta">${wb.system ? 'Sincronizada com a Shopee · ' : ''}Atualizada em ${formatTimestamp(wb.updatedAt)}</p>
          <div class="workbook-card-actions">
            <button class="btn btn-primary wb-open">Abrir</button>
            ${wb.system ? '' : '<button class="btn wb-rename" title="Renomear">Renomear</button>'}
            <button class="btn wb-duplicate" title="Duplicar (backup)">Duplicar</button>
            ${wb.system ? '' : '<button class="btn btn-danger wb-delete" title="Deletar planilha">Deletar</button>'}
          </div>
        </article>
      `,
      )
      .join('')

    grid.querySelectorAll<HTMLElement>('.workbook-card').forEach((card) => {
      const id = card.dataset.id!
      const wb = workbooks.find((w) => w.id === id)!
      card.querySelector<HTMLButtonElement>('.wb-open')!.addEventListener('click', () => onOpen(id))
      const renameBtn = card.querySelector<HTMLButtonElement>('.wb-rename')
      renameBtn?.addEventListener('click', () =>
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
      const deleteBtn = card.querySelector<HTMLButtonElement>('.wb-delete')
      deleteBtn?.addEventListener('click', () =>
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

  async function handleNewFile(file: File) {
    try {
      await onCreateFromXlsx(file)
    } catch (error) {
      handleError(error, 'Falha ao criar planilha a partir do XLSX')
    }
  }

  newFileInput.addEventListener('change', () => {
    const file = newFileInput.files?.[0]
    newFileInput.value = ''
    if (file) void handleNewFile(file)
  })
  void refresh()
}
