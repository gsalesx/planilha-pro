import './style.css'

import {
  addArtProjectPiece,
  checkAuth,
  copyPieceFrom,
  createArtProject,
  createCustomEmoji,
  deleteArtProject,
  deleteOrderPiece,
  getArtProjectPieces,
  getEmojiCatalog,
  listArtProjects,
  login,
  removePiecePhoto,
  renameArtProject,
  setPiecePhotoCrop,
  updateEmojiAliases,
  updateOrderPiece,
  uploadPiecePhoto,
  type ArtProject,
  type EmojiCatalogItem,
  type OrderPiece,
  type PecaGenero,
  type PecaTamanho,
  type PecaTipo,
  type PhotoCrop,
} from './api'
import { openConfirmDialog, openPromptDialog } from './dialog'
import { abrirPickerEditor } from './picker-editor'
import {
  carregarImagem,
  CONJUNTO_POR_MOLDE,
  labelDoMolde,
  moldeConjuntoPlaceholder,
  montarArteCanvas,
  montarConjuntoCanvas,
} from './render-molde-client'

/** Mesma paleta do picker de peças do chat Shopee (src/shopee-chat-panel.ts) — mantém as
 *  ferramentas de arte consistentes entre si. */
const SHORT_COLORS = ['#000000', '#ffffff', '#0000ff', '#ff00ff', '#ff0000']

const TIPO_OPTIONS: Array<{ value: PecaTipo; label: string }> = [
  { value: 'CAMISOLA', label: 'Camisola' },
  { value: 'SHORT', label: 'Short' },
  { value: 'CONJ', label: 'Conjunto' },
]
const TAMANHO_OPTIONS: PecaTamanho[] = [
  'P', 'M', 'G', 'GG',
  '2 ANOS', '4 ANOS', '6 ANOS', '8 ANOS', '10 ANOS', '12 ANOS',
]

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fmtDate(ms: number): string {
  try {
    return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      .format(new Date(ms))
  } catch {
    return ''
  }
}

/* ===========================================================
   Catálogo de emojis — mesma lógica de src/shopee-chat-panel.ts
   (favoritos espalhados + colar/nome + galeria)
   =========================================================== */

let emojiCatalog: EmojiCatalogItem[] = []

const LOOKS_LIKE_EMOJI_RE =
  /[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{2300}-\u{23FF}]/u

function normalizeName(text: string): string {
  return text
    .normalize('NFKD')
    .replace(new RegExp('[\\u0300-\\u036f]', 'g'), '')
    .toLowerCase()
    .trim()
}

function looksLikeEmoji(text: string): boolean {
  return LOOKS_LIKE_EMOJI_RE.test(text)
}

function resolveEmojiText(text: string): EmojiCatalogItem | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  for (const item of emojiCatalog) {
    for (const alias of item.aliases) {
      if (alias && trimmed.includes(alias)) return item
    }
  }
  return null
}

function searchEmojiByName(query: string): EmojiCatalogItem[] {
  const q = normalizeName(query)
  if (!q) return []
  return emojiCatalog.filter((item) => normalizeName(item.name).includes(q))
}

function catalogItemForCurrent(current: string): EmojiCatalogItem | null {
  if (!current) return null
  const exact = emojiCatalog.find((item) => item.name === current)
  if (exact) return exact
  return resolveEmojiText(current)
}

async function loadEmojiCatalog(): Promise<void> {
  try {
    const data = await getEmojiCatalog()
    emojiCatalog = data.items
  } catch (error) {
    console.warn('[emoji-catalog] falha ao carregar', error)
  }
}

const PRIORITY_EMOJI_NAMES = ['CORAÇÃO', 'BOCA', 'BEIJO', 'CARA APAIXONADA', 'OLHOS CORAÇÃO', 'CORAÇÃO BRANCO']

function pickFavorites(): EmojiCatalogItem[] {
  const byName = new Map(emojiCatalog.map((item) => [item.name, item]))
  return PRIORITY_EMOJI_NAMES.map((name) => byName.get(name)).filter((i): i is EmojiCatalogItem => !!i)
}

function emojiPickerHtml(pieceId: number, slot: 1 | 2, current: string): string {
  const favorites = pickFavorites()
  const resolved = catalogItemForCurrent(current)
  const currentThumb = resolved
    ? `<img class="emoji-picker-current-img" src="${escapeHtml(resolved.imageUrl)}" alt="${escapeHtml(resolved.name)}" title="${escapeHtml(resolved.name)}" />`
    : current
      ? `<span class="emoji-picker-current-raw" title="valor salvo não reconhecido: ${escapeHtml(current)}">${escapeHtml(current)}</span>`
      : `<span class="emoji-picker-current-empty">—</span>`
  const favHtml = favorites
    .map(
      (item) => `
      <button type="button" class="emoji-picker-fav${item.name === current ? ' is-selected' : ''}"
              data-piece-id="${pieceId}" data-slot="${slot}" data-name="${escapeHtml(item.name)}"
              title="${escapeHtml(item.name)}">
        <img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" />
      </button>`,
    )
    .join('')
  return `
    <div class="emoji-picker" data-piece-id="${pieceId}" data-slot="${slot}">
      <div class="emoji-picker-head">
        <span class="emoji-picker-label">Emoji ${slot}</span>
        <span class="emoji-picker-current">${currentThumb}</span>
      </div>
      <div class="emoji-picker-favorites">
        ${favHtml}
        <button type="button" class="emoji-picker-fav emoji-picker-fav--none${current ? '' : ' is-selected'}"
                data-piece-id="${pieceId}" data-slot="${slot}" data-name="" title="Sem emoji">–</button>
        <button type="button" class="emoji-picker-gallery-btn" data-piece-id="${pieceId}" data-slot="${slot}"
                title="Ver todos os emojis">🖼</button>
      </div>
      <input type="text" class="emoji-picker-input" data-piece-id="${pieceId}" data-slot="${slot}"
             placeholder="colar emoji ou nome ↵" />
    </div>
  `
}

function colorPickerHtml(pieceId: number, current: string): string {
  const cur = (current || '#000000').toLowerCase()
  const swatches = SHORT_COLORS.map(
    (c) => `<button type="button" class="color-swatch${c === cur ? ' is-selected' : ''}"
                    style="background:${c}" data-piece-id="${pieceId}" data-color="${c}" title="${c}"></button>`,
  ).join('')
  const isCustom = !SHORT_COLORS.includes(cur)
  return `
    <div class="color-picker" data-piece-id="${pieceId}">
      <span class="color-picker-label">Cor</span>
      <div class="color-picker-swatches">${swatches}</div>
      <label class="color-custom${isCustom ? ' is-selected' : ''}" style="${isCustom ? `background:${cur}` : ''}"
             title="Cor personalizada">
        🎨<input type="color" class="color-custom-input" data-piece-id="${pieceId}" value="${cur}" />
      </label>
    </div>
  `
}

/* ===========================================================
   Página
   =========================================================== */

function showLogin(onSuccess: () => void): void {
  const overlay = document.createElement('div')
  overlay.className = 'login-overlay'
  overlay.innerHTML = `
    <form class="login-card">
      <h2>Planilha Pro — Criador de Artes</h2>
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
    <div class="artes-page">
      <header class="app-header">
        <a href="/" class="shopee-test-back">← Planilhas</a>
        <h1>🎨 Criador de Artes</h1>
        <div class="artes-header-spacer"></div>
        <button type="button" class="btn btn-primary" id="artes-new-btn">+ Nova arte</button>
      </header>
      <div class="artes-body">
        <aside class="artes-sidebar">
          <h2>Histórico</h2>
          <div class="artes-projects-list" id="artes-projects-list">
            <div class="artes-loading">Carregando…</div>
          </div>
        </aside>
        <main class="artes-main" id="artes-main">
          <div class="artes-empty">Crie uma arte nova ou selecione uma do histórico ao lado.</div>
        </main>
      </div>
    </div>
  `

  const projectsListEl = root.querySelector<HTMLDivElement>('#artes-projects-list')!
  const mainEl = root.querySelector<HTMLDivElement>('#artes-main')!
  const newBtn = root.querySelector<HTMLButtonElement>('#artes-new-btn')!

  let projects: ArtProject[] = []
  let currentProjectId: string | null = null
  let currentPieces: OrderPiece[] = []

  async function loadProjects(): Promise<void> {
    const data = await listArtProjects()
    projects = data.projects
    renderSidebar()
  }

  function renderSidebar(): void {
    if (projects.length === 0) {
      projectsListEl.innerHTML = '<div class="artes-empty-sidebar">Nenhuma arte criada ainda.</div>'
      return
    }
    projectsListEl.innerHTML = projects
      .map(
        (p) => `
        <button type="button" class="artes-project-item${p.id === currentProjectId ? ' is-selected' : ''}" data-id="${p.id}">
          <span class="artes-project-nome">${escapeHtml(p.nome || 'Sem nome')}</span>
          <span class="artes-project-meta">${p.pieces} peça(s) · ${fmtDate(p.updated_at)}</span>
        </button>
      `,
      )
      .join('')
    projectsListEl.querySelectorAll<HTMLButtonElement>('.artes-project-item').forEach((btn) => {
      btn.addEventListener('click', () => void selectProject(btn.dataset.id!))
    })
  }

  async function selectProject(id: string): Promise<void> {
    currentProjectId = id
    renderSidebar()
    mainEl.innerHTML = '<div class="artes-loading">Carregando peças…</div>'
    const data = await getArtProjectPieces(id)
    currentPieces = data.pieces
    renderMain()
  }

  function currentProject(): ArtProject | undefined {
    return projects.find((p) => p.id === currentProjectId)
  }

  async function refreshCurrent(): Promise<void> {
    if (currentProjectId) await selectProject(currentProjectId)
  }

  function renderMain(): void {
    const project = currentProject()
    if (!project || !currentProjectId) {
      mainEl.innerHTML = '<div class="artes-empty">Crie uma arte nova ou selecione uma do histórico ao lado.</div>'
      return
    }
    mainEl.innerHTML = `
      <div class="artes-project-header">
        <h2 class="artes-project-title">${escapeHtml(project.nome || 'Sem nome')}</h2>
        <div class="artes-project-actions">
          <button type="button" class="btn" id="artes-rename-btn">✎ Renomear</button>
          <button type="button" class="btn" id="artes-delete-btn">🗑 Excluir</button>
          <button type="button" class="btn" id="artes-add-piece-btn">+ Peça</button>
          <button type="button" class="btn btn-primary" id="artes-download-all-btn" ${currentPieces.length === 0 ? 'disabled' : ''}>⬇ Baixar arte(s)</button>
        </div>
      </div>
      <div class="shopee-chat-pieces-list artes-pieces-list" id="artes-pieces-list">
        ${
          currentPieces.length === 0
            ? '<div class="artes-empty-sidebar">Nenhuma peça ainda — clique em "+ Peça".</div>'
            : currentPieces
                .map((p) => pieceCardHtml(p, p.id === currentPieces[0].id ? null : currentPieces[0].id))
                .join('')
        }
      </div>
    `
    bindMainActions()
    bindPieceCards()
  }

  function bindMainActions(): void {
    mainEl.querySelector<HTMLButtonElement>('#artes-rename-btn')?.addEventListener('click', () => {
      const project = currentProject()
      if (!project) return
      openPromptDialog({
        title: 'Renomear arte',
        label: 'Nome',
        defaultValue: project.nome,
        confirmLabel: 'Salvar',
        onConfirm: async (nome) => {
          await renameArtProject(project.id, nome)
          await loadProjects()
          renderMain()
        },
      })
    })
    mainEl.querySelector<HTMLButtonElement>('#artes-delete-btn')?.addEventListener('click', () => {
      const project = currentProject()
      if (!project) return
      openConfirmDialog({
        title: 'Excluir arte',
        body: `Excluir "${escapeHtml(project.nome || 'Sem nome')}" e todas as peças/fotos dela? Não dá pra desfazer.`,
        confirmLabel: 'Excluir',
        danger: true,
        onConfirm: async () => {
          await deleteArtProject(project.id)
          currentProjectId = null
          await loadProjects()
          renderMain()
        },
      })
    })
    mainEl.querySelector<HTMLButtonElement>('#artes-add-piece-btn')?.addEventListener('click', () => {
      void (async () => {
        if (!currentProjectId) return
        await addArtProjectPiece(currentProjectId)
        await loadProjects()
        await selectProject(currentProjectId)
      })()
    })
    mainEl.querySelector<HTMLButtonElement>('#artes-download-all-btn')?.addEventListener('click', (ev) => {
      const btn = ev.currentTarget as HTMLButtonElement
      void acionarBotaoAssincrono(btn, '⏳ Montando…', async () => {
        const project = currentProject()
        if (!project || currentPieces.length === 0) throw new Error('Nenhuma peça montada ainda')
        const geradas: Array<{ nome: string; blob: Blob }> = []
        const falhas: string[] = []
        for (const p of currentPieces) {
          try {
            geradas.push(await montarArtePecaNoNavegador(p, project))
          } catch (e) {
            falhas.push((e as Error).message)
          }
        }
        if (geradas.length === 0) throw new Error(falhas[0] ?? 'nenhuma arte pôde ser montada')
        if (geradas.length === 1) {
          baixarBlob(geradas[0].nome, geradas[0].blob)
          return
        }
        const { default: JSZip } = await import('jszip')
        const zip = new JSZip()
        geradas.forEach((g, i) => zip.file(`${i + 1} - ${g.nome}`, g.blob))
        if (falhas.length) zip.file('_FALHAS.txt', falhas.join('\n'))
        const buf = await zip.generateAsync({ type: 'blob' })
        baixarBlob(`${project.nome || 'artes'}.zip`, buf)
      })
    })
  }

  async function acionarBotaoAssincrono(
    btn: HTMLButtonElement,
    rotuloCarregando: string,
    acao: () => Promise<void>,
  ): Promise<void> {
    const rotulo = btn.textContent
    btn.disabled = true
    btn.textContent = rotuloCarregando
    try {
      await acao()
    } catch (error) {
      alert(`Falha: ${(error as Error).message}`)
    } finally {
      btn.disabled = false
      btn.textContent = rotulo
    }
  }

  function pieceCardHtml(piece: OrderPiece, firstPieceId: number | null): string {
    const showGenero = piece.tipo !== 'CAMISOLA'
    const generoOpts = (['MASCULINO', 'FEMININO'] as PecaGenero[])
      .map((g) => `<option value="${g}"${piece.genero === g ? ' selected' : ''}>${g === 'MASCULINO' ? 'Masculino' : 'Feminino'}</option>`)
      .join('')
    const tipoOpts = TIPO_OPTIONS.map(
      (t) => `<option value="${t.value}"${piece.tipo === t.value ? ' selected' : ''}>${t.label}</option>`,
    ).join('')
    const tamanhoOpts = TAMANHO_OPTIONS.map(
      (t) => `<option value="${t}"${piece.tamanho === t ? ' selected' : ''}>${t}</option>`,
    ).join('')

    function cropToggleHtml(slot: 1 | 2): string {
      const crop = piece.crops[slot] ?? 'rosto'
      const opt = (value: PhotoCrop, label: string) => `
        <label class="shopee-chat-piece-crop-opt${crop === value ? ' is-selected' : ''}">
          <input type="radio" name="crop-${piece.id}-${slot}" value="${value}"
                 data-piece-id="${piece.id}" data-slot="${slot}" ${crop === value ? 'checked' : ''} />
          ${label}
        </label>`
      return `
        <div class="shopee-chat-piece-crop" role="radiogroup" aria-label="Formato">
          ${opt('rosto', 'Recorte')}
          ${opt('coracao', 'Coração')}
          ${opt('face', 'Rosto')}
        </div>
      `
    }

    function slotHtml(slot: 1 | 2): string {
      const has = piece.photos[slot]
      const ajustadoEm = piece.compostas?.[slot] ?? null
      const fotoEm = piece.fotosUpdatedAt?.[slot] ?? null
      const src = ajustadoEm
        ? `/api/pieces/${piece.id}/photo/${slot}/composta?v=${ajustadoEm}`
        : `/api/pieces/${piece.id}/photo/${slot}${fotoEm ? `?v=${fotoEm}` : ''}`
      const thumb = has
        ? `<img class="shopee-chat-piece-thumb${ajustadoEm ? ' is-ajustada' : ''}" src="${src}" alt="Foto ${slot}" referrerpolicy="no-referrer" />`
        : `<div class="shopee-chat-piece-thumb shopee-chat-piece-thumb--empty">Foto ${slot}</div>`
      const removeBtn = has
        ? `<button type="button" class="shopee-chat-piece-photo-remove" data-piece-id="${piece.id}" data-slot="${slot}" title="Remover">×</button>`
        : ''
      return `
        <div class="shopee-chat-piece-slot">
          ${thumb}
          <div class="shopee-chat-piece-photo-actions">
            <label class="shopee-chat-piece-photo-upload" title="Subir foto do computador">
              📤 Enviar foto
              <input type="file" accept="image/*" class="shopee-chat-piece-photo-upload-input" data-piece-id="${piece.id}" data-slot="${slot}" hidden />
            </label>
          </div>
          ${has ? cropToggleHtml(slot) : ''}
          ${
            has
              ? `<button type="button" class="shopee-chat-piece-ajustar" data-piece-id="${piece.id}" data-slot="${slot}" data-molde="${escapeHtml(piece.molde)}" title="Ajustar enquadramento (coração/recorte/rosto)">✎ Ajustar</button>`
              : ''
          }
          ${removeBtn}
        </div>
      `
    }

    return `
      <article class="shopee-chat-piece-card" data-piece-id="${piece.id}">
        <header class="shopee-chat-piece-head">
          <span class="shopee-chat-piece-seq">Peça ${piece.seq}</span>
          <span class="shopee-chat-piece-molde">${escapeHtml(piece.molde)}</span>
          ${
            firstPieceId != null
              ? `<button type="button" class="shopee-chat-piece-copy-first" data-piece-id="${piece.id}" data-source-id="${firstPieceId}" title="Copiar fotos e emojis da 1ª peça">📋 copiar da 1ª</button>`
              : ''
          }
          <button type="button" class="shopee-chat-piece-delete" data-piece-id="${piece.id}" title="Remover peça">🗑</button>
        </header>
        <div class="shopee-chat-piece-row">
          <label>Tipo <select class="shopee-chat-piece-field" data-field="tipo">${tipoOpts}</select></label>
          ${showGenero ? `<label>Gênero <select class="shopee-chat-piece-field" data-field="genero">${generoOpts}</select></label>` : ''}
          <label>Tamanho <select class="shopee-chat-piece-field" data-field="tamanho">${tamanhoOpts}</select></label>
        </div>
        <div class="shopee-chat-piece-photos">
          ${slotHtml(1)}
          ${slotHtml(2)}
        </div>
        <div class="shopee-chat-piece-emojis">
          ${emojiPickerHtml(piece.id, 1, piece.emoji1)}
          ${emojiPickerHtml(piece.id, 2, piece.emoji2)}
        </div>
        <div class="shopee-chat-piece-bottom-row">
          ${colorPickerHtml(piece.id, piece.cor || '#000000')}
          <button type="button" class="btn artes-piece-download" data-piece-id="${piece.id}" title="Baixar só esta peça">⬇ Baixar</button>
        </div>
      </article>
    `
  }

  function bindPieceCards(): void {
    const listEl = mainEl.querySelector<HTMLDivElement>('#artes-pieces-list')!

    listEl.querySelectorAll<HTMLSelectElement>('.shopee-chat-piece-field').forEach((el) => {
      el.addEventListener('change', () => {
        const card = el.closest<HTMLElement>('.shopee-chat-piece-card')!
        const pieceId = Number(card.dataset.pieceId)
        const field = el.dataset.field!
        const value = el.value
        const patch =
          field === 'tipo'
            ? { tipo: value as PecaTipo }
            : field === 'genero'
              ? { genero: value as PecaGenero }
              : { tamanho: value as PecaTamanho }
        void updateOrderPiece(pieceId, patch).then(() => refreshCurrent())
      })
    })

    listEl.querySelectorAll<HTMLButtonElement>('.shopee-chat-piece-copy-first').forEach((btn) => {
      btn.addEventListener('click', () => {
        void acionarBotaoAssincrono(btn, '⏳…', async () => {
          await copyPieceFrom(Number(btn.dataset.pieceId), Number(btn.dataset.sourceId))
          await refreshCurrent()
        })
      })
    })

    listEl.querySelectorAll<HTMLButtonElement>('.shopee-chat-piece-delete').forEach((btn) => {
      btn.addEventListener('click', () => {
        openConfirmDialog({
          title: 'Remover peça',
          body: 'Remove esta peça (tipo/fotos/emojis). Não dá pra desfazer.',
          confirmLabel: 'Remover',
          danger: true,
          onConfirm: async () => {
            await deleteOrderPiece(Number(btn.dataset.pieceId))
            await loadProjects()
            if (currentProjectId) await selectProject(currentProjectId)
          },
        })
      })
    })

    listEl.querySelectorAll<HTMLInputElement>('.shopee-chat-piece-photo-upload-input').forEach((input) => {
      input.addEventListener('change', () => {
        void (async () => {
          const file = input.files?.[0]
          if (!file) return
          const pieceId = Number(input.dataset.pieceId)
          const slot = Number(input.dataset.slot) as 1 | 2
          try {
            await uploadPiecePhoto(pieceId, slot, file)
          } catch (error) {
            alert(`Falha ao subir foto: ${(error as Error).message}`)
          }
          input.value = ''
          if (currentProjectId) await selectProject(currentProjectId)
        })()
      })
    })

    listEl.querySelectorAll<HTMLButtonElement>('.shopee-chat-piece-photo-remove').forEach((btn) => {
      btn.addEventListener('click', () => {
        void removePiecePhoto(Number(btn.dataset.pieceId), Number(btn.dataset.slot) as 1 | 2).then(
          () => refreshCurrent(),
        )
      })
    })

    listEl.querySelectorAll<HTMLInputElement>('input[name^="crop-"]').forEach((input) => {
      input.addEventListener('change', () => {
        void setPiecePhotoCrop(
          Number(input.dataset.pieceId),
          Number(input.dataset.slot) as 1 | 2,
          input.value as PhotoCrop,
        ).then(() => refreshCurrent())
      })
    })

    listEl.querySelectorAll<HTMLButtonElement>('.shopee-chat-piece-ajustar').forEach((btn) => {
      btn.addEventListener('click', () => {
        void abrirPickerEditor({
          pieceId: Number(btn.dataset.pieceId),
          slot: Number(btn.dataset.slot) as 1 | 2,
          titulo: `${btn.dataset.molde ?? ''} — Foto ${btn.dataset.slot}`,
          onSalvo: () => {
            if (currentProjectId) void selectProject(currentProjectId)
          },
        })
      })
    })

    listEl.querySelectorAll<HTMLButtonElement>('.emoji-picker-fav').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pieceId = Number(btn.dataset.pieceId)
        const slot = btn.dataset.slot === '1' ? 'emoji1' : 'emoji2'
        const name = btn.dataset.name || ''
        void updateOrderPiece(pieceId, { [slot]: name }).then(() => refreshCurrent())
      })
    })
    listEl.querySelectorAll<HTMLButtonElement>('.emoji-picker-gallery-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        openEmojiGallery(Number(btn.dataset.pieceId), (btn.dataset.slot === '1' ? 1 : 2) as 1 | 2)
      })
    })
    listEl.querySelectorAll<HTMLInputElement>('.emoji-picker-input').forEach((inp) => {
      inp.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter') return
        ev.preventDefault()
        void resolveAndApplyEmoji(Number(inp.dataset.pieceId), (inp.dataset.slot === '1' ? 1 : 2) as 1 | 2, inp.value).then(
          () => {
            inp.value = ''
          },
        )
      })
    })

    listEl.querySelectorAll<HTMLButtonElement>('.color-swatch').forEach((btn) => {
      btn.addEventListener('click', () => {
        void updateOrderPiece(Number(btn.dataset.pieceId), { cor: btn.dataset.color! }).then(
          () => refreshCurrent(),
        )
      })
    })
    listEl.querySelectorAll<HTMLInputElement>('.color-custom-input').forEach((inp) => {
      inp.addEventListener('change', () => {
        void updateOrderPiece(Number(inp.dataset.pieceId), { cor: inp.value }).then(
          () => refreshCurrent(),
        )
      })
    })

    listEl.querySelectorAll<HTMLButtonElement>('.artes-piece-download').forEach((btn) => {
      btn.addEventListener('click', () => {
        void acionarBotaoAssincrono(btn, '⏳…', async () => {
          const piece = currentPieces.find((p) => p.id === Number(btn.dataset.pieceId))
          const project = currentProject()
          if (!piece || !project) return
          const { nome, blob } = await montarArtePecaNoNavegador(piece, project)
          baixarBlob(nome, blob)
        })
      })
    })
  }

  /** Enter no campo "colar emoji/nome": resolve por alias, por nome único, ou abre a galeria. */
  async function resolveAndApplyEmoji(pieceId: number, slot: 1 | 2, text: string): Promise<void> {
    const trimmed = text.trim()
    if (!trimmed) return
    const field = slot === 1 ? 'emoji1' : 'emoji2'
    const resolved = resolveEmojiText(trimmed)
    if (resolved) {
      await updateOrderPiece(pieceId, { [field]: resolved.name })
      if (currentProjectId) await selectProject(currentProjectId)
      return
    }
    if (looksLikeEmoji(trimmed)) {
      openEmojiGallery(pieceId, slot, { pendingChar: trimmed })
      return
    }
    const matches = searchEmojiByName(trimmed)
    if (matches.length === 1) {
      await updateOrderPiece(pieceId, { [field]: matches[0].name })
      if (currentProjectId) await selectProject(currentProjectId)
      return
    }
    openEmojiGallery(pieceId, slot, { query: trimmed })
  }

  function closeEmojiGallery(): void {
    document.getElementById('emoji-gallery-modal')?.remove()
  }

  function openEmojiGallery(
    pieceId: number,
    slot: 1 | 2,
    opts: { pendingChar?: string; query?: string } = {},
  ): void {
    closeEmojiGallery()
    const field = slot === 1 ? 'emoji1' : 'emoji2'
    const modal = document.createElement('div')
    modal.id = 'emoji-gallery-modal'
    modal.className = 'emoji-gallery-backdrop'
    modal.innerHTML = `
      <div class="emoji-gallery-modal" role="dialog" aria-label="Galeria de emojis">
        <header class="emoji-gallery-header">
          <span>Galeria de emojis</span>
          <button type="button" class="emoji-gallery-close" aria-label="Fechar">×</button>
        </header>
        ${
          opts.pendingChar
            ? `<p class="emoji-gallery-hint">escolha a imagem pra "${escapeHtml(opts.pendingChar)}" (salva o atalho pra próxima vez)</p>`
            : ''
        }
        <div class="emoji-gallery-search-row">
          <input type="text" class="emoji-gallery-search" placeholder="buscar por nome…" value="${escapeHtml(opts.query ?? '')}" />
        </div>
        <div class="emoji-gallery-grid"></div>
        <footer class="emoji-gallery-footer">
          <input type="text" class="emoji-gallery-upload-name" placeholder="nome do emoji customizado" />
          <label class="emoji-gallery-upload">
            + subir imagem
            <input type="file" accept="image/*" class="emoji-gallery-upload-input" hidden />
          </label>
        </footer>
      </div>
    `
    document.body.appendChild(modal)

    const gridEl = modal.querySelector<HTMLElement>('.emoji-gallery-grid')!
    const searchEl = modal.querySelector<HTMLInputElement>('.emoji-gallery-search')!
    const closeBtn = modal.querySelector<HTMLButtonElement>('.emoji-gallery-close')!
    const uploadInput = modal.querySelector<HTMLInputElement>('.emoji-gallery-upload-input')!
    const uploadNameInput = modal.querySelector<HTMLInputElement>('.emoji-gallery-upload-name')!

    async function escolher(item: EmojiCatalogItem): Promise<void> {
      if (opts.pendingChar && !item.aliases.includes(opts.pendingChar)) {
        try {
          const { item: updated } = await updateEmojiAliases(item.id, [...item.aliases, opts.pendingChar])
          emojiCatalog = emojiCatalog.map((i) => (i.id === updated.id ? updated : i))
        } catch (error) {
          alert(`Não salvei o atalho "${opts.pendingChar}": ${(error as Error).message}`)
        }
      }
      await updateOrderPiece(pieceId, { [field]: item.name })
      closeEmojiGallery()
      if (currentProjectId) await selectProject(currentProjectId)
    }

    function render(items: EmojiCatalogItem[]): void {
      gridEl.innerHTML = items.length
        ? items
            .map(
              (item) => `
              <button type="button" class="emoji-gallery-item" data-id="${item.id}" title="${escapeHtml(item.name)}">
                <img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name)}" />
                <span>${escapeHtml(item.name)}</span>
              </button>`,
            )
            .join('')
        : `<div class="emoji-gallery-empty">nenhum emoji encontrado</div>`
      gridEl.querySelectorAll<HTMLButtonElement>('.emoji-gallery-item').forEach((btn) => {
        btn.addEventListener('click', () => {
          const item = items.find((i) => i.id === Number(btn.dataset.id))
          if (item) void escolher(item)
        })
      })
    }

    function applyFilter(): void {
      const q = searchEl.value.trim()
      render(q ? searchEmojiByName(q) : emojiCatalog)
    }
    searchEl.addEventListener('input', applyFilter)
    applyFilter()
    searchEl.focus()

    closeBtn.addEventListener('click', closeEmojiGallery)
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeEmojiGallery()
    })

    uploadInput.addEventListener('change', () => {
      void (async () => {
        const file = uploadInput.files?.[0]
        if (!file) return
        const name = uploadNameInput.value.trim().toUpperCase()
        if (!name) {
          alert('Digite o nome do emoji customizado antes de escolher o arquivo.')
          uploadInput.value = ''
          return
        }
        try {
          const { item } = await createCustomEmoji(file, name, opts.pendingChar ? [opts.pendingChar] : undefined)
          emojiCatalog = [...emojiCatalog, item]
          await escolher(item)
        } catch (error) {
          alert(`Falha ao subir emoji: ${(error as Error).message}`)
        }
      })()
    })
  }

  /**
   * Monta a arte de UMA peça inteiramente no NAVEGADOR — mesma lógica de
   * src/shopee-chat-panel.ts (montarArtePecaNoNavegador), sem depender de pedido: o
   * "cliente" no nome do arquivo vira o nome da arte (projeto).
   */
  async function montarArtePecaNoNavegador(
    p: OrderPiece,
    project: ArtProject,
  ): Promise<{ nome: string; blob: Blob }> {
    const fotoUrl = (slot: 1 | 2) => `/api/pieces/${p.id}/photo/${slot}/composta`
    const emojiUrl = (slot: 1 | 2) => `/api/pieces/${p.id}/emoji/${slot}?v=${p.updated_at}`

    const fotos: HTMLImageElement[] = []
    for (const slot of [1, 2] as const) {
      if (p.photos[slot]) {
        try {
          fotos.push(await carregarImagem(fotoUrl(slot)))
        } catch {
          // slot sem composta — ignora, mesma regra do servidor (foto única repete)
        }
      }
    }
    if (fotos.length === 0) throw new Error(`${p.molde}: nenhuma foto composta — ajuste as fotos antes`)
    if (fotos.length === 1) fotos.push(fotos[0])

    const emojis: HTMLImageElement[] = []
    const emojiFalhas: string[] = []
    for (const slot of [1, 2] as const) {
      const resp = await fetch(emojiUrl(slot), { credentials: 'include' })
      if (resp.ok) {
        emojis.push(await carregarImagem(URL.createObjectURL(await resp.blob())))
        continue
      }
      const corpo = (await resp.json().catch(() => ({}))) as { error?: string; semEmoji?: boolean }
      if (!corpo.semEmoji) emojiFalhas.push(`slot ${slot}: ${corpo.error ?? `HTTP ${resp.status}`}`)
    }
    if (emojiFalhas.length > 0) throw new Error(`${p.molde}: ${emojiFalhas.join('; ')}`)

    const molde = p.molde.trim().toUpperCase()
    const nomeBase = project.nome.trim() || labelDoMolde(molde)

    if (CONJUNTO_POR_MOLDE[moldeConjuntoPlaceholder(molde)]) {
      const paineis = await montarConjuntoCanvas({ molde, cor: p.cor || '#000000', fotos, emojis })
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      for (const { painel, blob } of paineis) zip.file(`${nomeBase} ${labelDoMolde(molde)} ${painel}.jpg`, blob)
      const buf = await zip.generateAsync({ type: 'blob' })
      return { nome: `${nomeBase} ${labelDoMolde(molde)}.zip`, blob: buf }
    }

    const blob = await montarArteCanvas({ molde, cor: p.cor || '#000000', fotos, emojis })
    return { nome: `${nomeBase} ${labelDoMolde(molde)}.jpg`, blob }
  }

  function baixarBlob(nome: string, blob: Blob): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = nome
    a.click()
    URL.revokeObjectURL(url)
  }

  newBtn.addEventListener('click', () => {
    openPromptDialog({
      title: 'Nova arte',
      label: 'Nome (cliente, referência etc.)',
      defaultValue: `Arte ${new Date().toLocaleDateString('pt-BR')}`,
      confirmLabel: 'Criar',
      onConfirm: async (nome) => {
        const { project } = await createArtProject(nome)
        await loadProjects()
        await selectProject(project.id)
      },
    })
  })

  await loadEmojiCatalog()
  await loadProjects()
}

async function start(): Promise<void> {
  const ok = await checkAuth()
  if (ok) {
    await boot()
    return
  }
  showLogin(() => void boot())
}

void start()
