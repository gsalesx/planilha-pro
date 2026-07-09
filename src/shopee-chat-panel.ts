import {
  addOrderPiece,
  assignPiecePhoto,
  confirmPiecesForOrder,
  copyPieceFrom,
  createCustomEmoji,
  deleteOrderPiece,
  fetchShopeeChatHistory,
  getEmojiCatalog,
  getOrderPieces,
  patchOrderDelta,
  removePiecePhoto,
  sendShopeeChatMessage,
  setPiecePhotoCrop,
  updateEmojiAliases,
  updateOrderPiece,
  type EmojiCatalogItem,
  type OrderPiece,
  type PecaGenero,
  type PecaTamanho,
  type PecaTipo,
  type PhotoCrop,
  type ShopeeChatMessage,
} from './api'
import { openConfirmDialog } from './dialog'
import { STATUS_COLUMN_INDEX } from './status'

export interface ShopeeChatOrderInfo {
  workbookId: string
  orderKey: string
  orderId: string
  product: string
  model: string
  quantity: string
  status: string
  buyerUsername: string
  recipient: string
  sheetDate?: string
  /** Chamado depois que "Confirmar pedido" fecha o painel — main.ts usa pra selecionar
   * e rolar até a linha do cliente que acabou de ser confirmado. */
  onConfirmed?: () => void
}

/** Mesma paleta usada em Criador de artes/scripts/picker_manual.py — mantém as duas ferramentas consistentes. */
const SHORT_COLORS = ['#000000', '#ffffff', '#0000ff', '#ff00ff', '#ff0000']

/** Status (coluna F) que o "Confirmar pedido" grava — é o que dispara o pipeline do
 * Criador de artes (planilha_fila filtra por "Separado"); "Pronto" só é setado no FIM
 * do pipeline (batch_finalize.py), depois que a arte já foi gerada — não aqui. */
const CONFIRMED_STATUS = 'Separado'
const TIPO_OPTIONS: Array<{ value: PecaTipo; label: string }> = [
  { value: 'CAMISOLA', label: 'Camisola' },
  { value: 'SHORT', label: 'Short' },
  { value: 'CONJ', label: 'Conjunto' },
]
const TAMANHO_OPTIONS: PecaTamanho[] = ['P', 'M', 'G', 'GG']

function fmtMessageTime(ms: number | null): string {
  if (!ms) return ''
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ms))
  } catch {
    return ''
  }
}

function fmtDayLabel(ms: number | null): string {
  if (!ms) return 'Sem data'
  try {
    return new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long',
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    }).format(new Date(ms))
  } catch {
    return 'Sem data'
  }
}

function dayKey(ms: number | null): string {
  if (!ms) return 'unknown'
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/* ===========================================================
   Catálogo de emojis — favoritos espalhados + colar/nome + galeria
   (substitui o <select> de 6 opções fixas que veio da extensão Chrome)
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

/** Char/trecho colado -> item do catálogo, ou null. Substring match (não char-a-char) pra
 * aguentar sequências multi-codepoint (seletor de variação, ZWJ, tom de pele). */
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

/** Nome já salvo na peça -> item do catálogo pra exibir a miniatura. Aceita tanto o nome
 * canônico quanto (fallback de exibição) um emoji unicode legado salvo antes dessa mudança. */
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

/** Os 6 favoritos fixos da seleção rápida — curados manualmente pelo user (ajustado
 * 2026-07-15: MANDANDO BEIJO trocado por BOCA). */
const PRIORITY_EMOJI_NAMES = ['CORAÇÃO', 'BOCA', 'BEIJO', 'CARA APAIXONADA', 'OLHOS CORAÇÃO', 'CORAÇÃO BRANCO']

/** Lista FIXA — só esses 6, não cresce com o que for mapeado depois pela galeria.
 * Emoji fora dessa lista só aparece via colar/nome ou 🖼 todos. */
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
             placeholder="colar emoji do chat ou nome ↵" />
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

function renderMessageBody(msg: ShopeeChatMessage): string {
  if (msg.imageUrl) {
    const url = escapeHtml(msg.imageUrl)
    return `<a class="shopee-chat-image-link" href="${url}" target="_blank" rel="noopener noreferrer"><img class="shopee-chat-image" src="${url}" alt="Imagem enviada no chat" loading="lazy" /></a>`
  }
  return escapeHtml(msg.text)
}

function renderMessages(messages: ShopeeChatMessage[], buyerUsername: string): string {
  if (messages.length === 0) {
    return `<div class="shopee-chat-empty">Nenhuma mensagem nesta conversa.</div>`
  }
  let lastDay = ''
  const parts: string[] = []
  for (const msg of messages) {
    const dk = dayKey(msg.createdAt)
    if (dk !== lastDay) {
      lastDay = dk
      parts.push(`<div class="shopee-chat-day">${escapeHtml(fmtDayLabel(msg.createdAt))}</div>`)
    }
    const side = msg.fromBuyer ? 'buyer' : 'seller'
    const label = msg.fromBuyer ? buyerUsername : 'Loja'
    parts.push(`
      <div class="shopee-chat-bubble-wrap ${side}">
        <div class="shopee-chat-bubble-meta">${escapeHtml(label)} · ${escapeHtml(fmtMessageTime(msg.createdAt))}</div>
        <div class="shopee-chat-bubble ${side}">${renderMessageBody(msg)}</div>
      </div>
    `)
  }
  return parts.join('')
}

let activePanel: HTMLElement | null = null

export function closeShopeeChatPanel(): void {
  activePanel?.remove()
  activePanel = null
  document.body.classList.remove('shopee-chat-open')
  document.getElementById('emoji-gallery-modal')?.remove()
}

export async function openShopeeChatPanel(order: ShopeeChatOrderInfo): Promise<void> {
  closeShopeeChatPanel()
  document.body.classList.add('shopee-chat-open')

  const overlay = document.createElement('div')
  overlay.className = 'shopee-chat-backdrop'
  overlay.innerHTML = `
    <aside class="shopee-chat-panel" role="dialog" aria-label="Chat Shopee">
      <header class="shopee-chat-header">
        <div class="shopee-chat-header-main">
          <div class="shopee-chat-avatar" aria-hidden="true">${escapeHtml(order.buyerUsername.slice(0, 1).toUpperCase() || '?')}</div>
          <div class="shopee-chat-header-text">
            <h2 class="shopee-chat-title">${escapeHtml(order.buyerUsername)}</h2>
            <p class="shopee-chat-subtitle">${escapeHtml(order.recipient || 'Destinatário')}</p>
          </div>
        </div>
        <button type="button" class="shopee-chat-close" title="Fechar" aria-label="Fechar chat">×</button>
      </header>
      <section class="shopee-chat-order-card">
        <div class="shopee-chat-order-head">
          <span class="shopee-chat-order-badge">Pedido</span>
          <span class="shopee-chat-order-id">#${escapeHtml(order.orderId)}</span>
          ${order.sheetDate ? `<span class="shopee-chat-order-date">${escapeHtml(order.sheetDate)}</span>` : ''}
        </div>
        <div class="shopee-chat-order-grid">
          <div class="shopee-chat-order-field">
            <span class="label">Produto</span>
            <span class="value">${escapeHtml(order.product || '—')}</span>
          </div>
          <div class="shopee-chat-order-field">
            <span class="label">Modelo</span>
            <span class="value">${escapeHtml(order.model || '—')}</span>
          </div>
          <div class="shopee-chat-order-field compact">
            <span class="label">Qtd.</span>
            <span class="value">${escapeHtml(order.quantity || '—')}</span>
          </div>
          <div class="shopee-chat-order-field compact">
            <span class="label">Status</span>
            <span class="value shopee-chat-status">${escapeHtml(order.status || '—')}</span>
          </div>
        </div>
      </section>
      <button type="button" class="shopee-chat-pieces-toggle" id="shopee-chat-pieces-toggle">
        <span aria-hidden="true">🧩</span>
        <span id="shopee-chat-pieces-toggle-label">Carregando peças…</span>
        <span class="shopee-chat-pieces-toggle-chevron" aria-hidden="true">›</span>
      </button>
      <div class="shopee-chat-messages" id="shopee-chat-messages">
        <div class="shopee-chat-loading">
          <div class="shopee-chat-spinner"></div>
          <span>Carregando mensagens…</span>
        </div>
      </div>
      <footer class="shopee-chat-compose">
        <textarea class="shopee-chat-input" rows="2" placeholder="Escreva uma mensagem…" maxlength="2000"></textarea>
        <button type="button" class="btn btn-primary shopee-chat-send" disabled>Enviar</button>
      </footer>
      <div class="shopee-chat-pieces-overlay" id="shopee-chat-pieces-overlay">
        <header class="shopee-chat-pieces-overlay-header">
          <span>🧩 Peças da arte</span>
          <button type="button" class="shopee-chat-pieces-close" id="shopee-chat-pieces-close" aria-label="Fechar">×</button>
        </header>
        <div class="shopee-chat-pieces-overlay-body" id="shopee-chat-pieces">
          <div class="shopee-chat-pieces-loading">Carregando peças…</div>
        </div>
      </div>
    </aside>
  `
  document.body.appendChild(overlay)
  activePanel = overlay

  const messagesEl = overlay.querySelector<HTMLElement>('#shopee-chat-messages')!
  const inputEl = overlay.querySelector<HTMLTextAreaElement>('.shopee-chat-input')!
  const sendBtn = overlay.querySelector<HTMLButtonElement>('.shopee-chat-send')!
  const piecesEl = overlay.querySelector<HTMLElement>('#shopee-chat-pieces')!
  const piecesOverlayEl = overlay.querySelector<HTMLElement>('#shopee-chat-pieces-overlay')!
  const piecesToggleBtn = overlay.querySelector<HTMLButtonElement>('#shopee-chat-pieces-toggle')!
  const piecesToggleLabel = overlay.querySelector<HTMLElement>('#shopee-chat-pieces-toggle-label')!
  const piecesCloseBtn = overlay.querySelector<HTMLButtonElement>('#shopee-chat-pieces-close')!

  piecesToggleBtn.addEventListener('click', () => piecesOverlayEl.classList.add('open'))
  piecesCloseBtn.addEventListener('click', () => {
    armed = null
    messagesEl.classList.remove('shopee-chat-picking')
    piecesOverlayEl.classList.remove('open')
  })

  let armed: { pieceId: number; slot: 1 | 2 } | null = null

  function armSlot(pieceId: number, slot: 1 | 2): void {
    armed = armed && armed.pieceId === pieceId && armed.slot === slot ? null : { pieceId, slot }
    messagesEl.classList.toggle('shopee-chat-picking', armed != null)
    // Fecha a gaveta de peças pra liberar o chat na hora de clicar na foto certa.
    if (armed) piecesOverlayEl.classList.remove('open')
    renderPieceButtons()
  }

  function renderPieceButtons(): void {
    piecesEl.querySelectorAll<HTMLButtonElement>('.shopee-chat-piece-photo-pick').forEach((btn) => {
      const pieceId = Number(btn.dataset.pieceId)
      const slot = Number(btn.dataset.slot)
      const isArmed = armed?.pieceId === pieceId && armed?.slot === slot
      btn.classList.toggle('is-armed', isArmed)
      btn.textContent = isArmed ? 'Clique numa foto do chat…' : 'Escolher da conversa'
    })
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
        <div class="shopee-chat-piece-crop" role="radiogroup" aria-label="Recorte">
          ${opt('rosto', 'Recorte')}
          ${opt('coracao', 'Coração')}
        </div>
      `
    }

    function slotHtml(slot: 1 | 2): string {
      const has = piece.photos[slot]
      const pendingUrl = piece.pendingUrls[slot]
      const src = pendingUrl ? escapeHtml(pendingUrl) : `/api/pieces/${piece.id}/photo/${slot}`
      const thumb = has
        ? `<img class="shopee-chat-piece-thumb" src="${src}" alt="Foto ${slot}" referrerpolicy="no-referrer" />`
        : `<div class="shopee-chat-piece-thumb shopee-chat-piece-thumb--empty">Foto ${slot}</div>`
      const removeBtn = has
        ? `<button type="button" class="shopee-chat-piece-photo-remove" data-piece-id="${piece.id}" data-slot="${slot}" title="Remover">×</button>`
        : ''
      return `
        <div class="shopee-chat-piece-slot">
          ${thumb}
          <button type="button" class="shopee-chat-piece-photo-pick" data-piece-id="${piece.id}" data-slot="${slot}">Escolher da conversa</button>
          ${has ? cropToggleHtml(slot) : ''}
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
        ${colorPickerHtml(piece.id, piece.cor || '#000000')}
        <div class="shopee-chat-piece-nota">
          <label for="nota-${piece.id}">📝 Observação da peça</label>
          <textarea id="nota-${piece.id}" class="shopee-chat-piece-nota-input" data-piece-id="${piece.id}"
                    rows="2" placeholder="ex.: usar só a parte de cima dessa foto, cliente pediu…"
          >${escapeHtml(piece.nota || '')}</textarea>
        </div>
      </article>
    `
  }

  function bindPieceCards(): void {
    piecesEl.querySelectorAll<HTMLSelectElement | HTMLInputElement>('.shopee-chat-piece-field').forEach((el) => {
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
        void updateOrderPiece(pieceId, patch).then(() => loadPieces())
      })
    })
    piecesEl.querySelectorAll<HTMLButtonElement>('.emoji-picker-fav').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pieceId = Number(btn.dataset.pieceId)
        const slot = btn.dataset.slot === '1' ? 'emoji1' : 'emoji2'
        const name = btn.dataset.name || ''
        void updateOrderPiece(pieceId, { [slot]: name }).then(() => loadPieces())
      })
    })
    piecesEl.querySelectorAll<HTMLButtonElement>('.emoji-picker-gallery-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        openEmojiGallery(Number(btn.dataset.pieceId), (btn.dataset.slot === '1' ? 1 : 2) as 1 | 2)
      })
    })
    piecesEl.querySelectorAll<HTMLInputElement>('.emoji-picker-input').forEach((inp) => {
      inp.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter') return
        e.preventDefault()
        const pieceId = Number(inp.dataset.pieceId)
        const slot = (inp.dataset.slot === '1' ? 1 : 2) as 1 | 2
        const text = inp.value
        inp.value = ''
        void resolveAndApplyEmoji(pieceId, slot, text)
      })
    })
    piecesEl.querySelectorAll<HTMLButtonElement>('.color-swatch').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pieceId = Number(btn.dataset.pieceId)
        const color = btn.dataset.color!
        void updateOrderPiece(pieceId, { cor: color }).then(() => loadPieces())
      })
    })
    piecesEl.querySelectorAll<HTMLInputElement>('.color-custom-input').forEach((inp) => {
      inp.addEventListener('change', () => {
        const pieceId = Number(inp.dataset.pieceId)
        void updateOrderPiece(pieceId, { cor: inp.value }).then(() => loadPieces())
      })
    })
    piecesEl.querySelectorAll<HTMLTextAreaElement>('.shopee-chat-piece-nota-input').forEach((ta) => {
      // 'change' (não 'input') = só salva ao perder o foco/valor mudar, sem request a cada tecla
      ta.addEventListener('change', () => {
        const pieceId = Number(ta.dataset.pieceId)
        void updateOrderPiece(pieceId, { nota: ta.value })
      })
    })
    piecesEl.querySelectorAll<HTMLButtonElement>('.shopee-chat-piece-photo-pick').forEach((btn) => {
      btn.addEventListener('click', () => {
        armSlot(Number(btn.dataset.pieceId), Number(btn.dataset.slot) as 1 | 2)
      })
    })
    piecesEl.querySelectorAll<HTMLButtonElement>('.shopee-chat-piece-photo-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await removePiecePhoto(Number(btn.dataset.pieceId), Number(btn.dataset.slot) as 1 | 2)
        void loadPieces()
      })
    })
    piecesEl.querySelectorAll<HTMLInputElement>('.shopee-chat-piece-crop input[type=radio]').forEach((radio) => {
      radio.addEventListener('change', async () => {
        const pieceId = Number(radio.dataset.pieceId)
        const slot = Number(radio.dataset.slot) as 1 | 2
        // só troca a classe visual localmente — loadPieces() reconstruiria o card
        // inteiro (inclusive o <img>), fazendo a foto "recarregar"/piscar à toa.
        const group = radio.closest('.shopee-chat-piece-crop')
        group?.querySelectorAll('.shopee-chat-piece-crop-opt').forEach((el) => el.classList.remove('is-selected'))
        radio.closest('.shopee-chat-piece-crop-opt')?.classList.add('is-selected')
        try {
          await setPiecePhotoCrop(pieceId, slot, radio.value as PhotoCrop)
        } catch (error) {
          alert((error as Error).message)
        }
      })
    })
    piecesEl.querySelectorAll<HTMLButtonElement>('.shopee-chat-piece-copy-first').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const pieceId = Number(btn.dataset.pieceId)
        const sourceId = Number(btn.dataset.sourceId)
        btn.disabled = true
        try {
          await copyPieceFrom(pieceId, sourceId)
          void loadPieces()
        } catch (error) {
          alert((error as Error).message)
          btn.disabled = false
        }
      })
    })
    piecesEl.querySelectorAll<HTMLButtonElement>('.shopee-chat-piece-delete').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remover esta peça?')) return
        await deleteOrderPiece(Number(btn.dataset.pieceId))
        if (armed?.pieceId === Number(btn.dataset.pieceId)) {
          armed = null
          messagesEl.classList.remove('shopee-chat-picking')
        }
        void loadPieces()
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
      void loadPieces()
      return
    }
    if (looksLikeEmoji(trimmed)) {
      openEmojiGallery(pieceId, slot, { pendingChar: trimmed })
      return
    }
    const matches = searchEmojiByName(trimmed)
    if (matches.length === 1) {
      await updateOrderPiece(pieceId, { [field]: matches[0].name })
      void loadPieces()
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
          // não bloqueia a escolha do emoji pra peça — só avisa que o atalho não foi salvo
          alert(`Não salvei o atalho "${opts.pendingChar}": ${(error as Error).message}`)
        }
      }
      await updateOrderPiece(pieceId, { [field]: item.name })
      closeEmojiGallery()
      void loadPieces()
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

  function updatePiecesToggleLabel(data: { pieces: OrderPiece[]; autoFailed?: string }): void {
    const missingPhotos = data.pieces.filter((p) => !p.photos[1] && !p.photos[2]).length
    if (data.autoFailed && data.pieces.length === 0) {
      piecesToggleLabel.textContent = 'Peça pendente — ajustar na mão'
      piecesToggleBtn.classList.add('shopee-chat-pieces-toggle--warn')
    } else if (missingPhotos > 0) {
      piecesToggleLabel.textContent = `${data.pieces.length} peça(s) — ${missingPhotos} sem foto`
      piecesToggleBtn.classList.add('shopee-chat-pieces-toggle--warn')
    } else {
      piecesToggleLabel.textContent = `${data.pieces.length} peça(s) montada(s)`
      piecesToggleBtn.classList.remove('shopee-chat-pieces-toggle--warn')
    }
  }

  function confirmBarHtml(pieces: OrderPiece[]): string {
    if (order.status === CONFIRMED_STATUS) {
      return `<div class="shopee-chat-pieces-confirmed">✓ Pedido confirmado — status "Separado"</div>`
    }
    const missing = pieces.filter((p) => !p.photos[1]).length
    const label = missing > 0 ? `✅ Confirmar pedido (${missing} peça(s) sem foto)` : '✅ Confirmar pedido'
    return `
      <button type="button" class="btn btn-primary shopee-chat-confirm-order" id="shopee-chat-confirm-order"
              ${pieces.length === 0 ? 'disabled' : ''}>${label}</button>
    `
  }

  function bindConfirmBar(pieces: OrderPiece[]): void {
    const btn = overlay.querySelector<HTMLButtonElement>('#shopee-chat-confirm-order')
    if (!btn) return
    btn.addEventListener('click', () => {
      const missing = pieces.filter((p) => !p.photos[1]).length
      const doConfirm = async () => {
        btn.disabled = true
        btn.textContent = 'Confirmando…'
        try {
          // baixa/salva de verdade as fotos pendentes (até aqui eram só hotlink do
          // CDN da Shopee) ANTES de marcar "Separado".
          await confirmPiecesForOrder(order.workbookId, order.orderKey)
          await patchOrderDelta(order.workbookId, order.orderKey, {
            cells: [{ col: STATUS_COLUMN_INDEX, value: CONFIRMED_STATUS }],
          })
          order.status = CONFIRMED_STATUS
          closeShopeeChatPanel()
          order.onConfirmed?.()
        } catch (error) {
          alert(`Falha ao confirmar: ${(error as Error).message}`)
          btn.disabled = false
          btn.textContent = '✅ Confirmar pedido'
        }
      }
      openConfirmDialog({
        title: 'Confirmar pedido',
        body:
          missing > 0
            ? `${missing} peça(s) ainda sem Foto 1. Confirmar mesmo assim? O pedido vai pro Criador de artes com o que já tem.`
            : 'Marca o pedido como "Separado" — o Criador de artes vai puxar da fila e montar a arte a partir daqui. As fotos/emojis/cor já escolhidos ficam salvos como estão.',
        confirmLabel: 'Confirmar pedido',
        danger: missing > 0,
        onConfirm: doConfirm,
      })
    })
  }

  async function loadPieces(): Promise<void> {
    try {
      const data = await getOrderPieces(order.workbookId, order.orderKey)
      const firstId = data.pieces[0]?.id ?? null
      const cards = data.pieces.map((p, i) => pieceCardHtml(p, i === 0 ? null : firstId)).join('')
      const failedHint = data.autoFailed
        ? `<p class="shopee-chat-pieces-hint">Não deu pra montar a peça sozinho pelo SKU (${escapeHtml(data.autoFailed)}). Adicione na mão:</p>`
        : ''
      piecesEl.innerHTML = `
        <div class="shopee-chat-pieces-header">
          <button type="button" class="btn shopee-chat-piece-add" id="shopee-chat-piece-add">+ Adicionar peça</button>
        </div>
        ${failedHint}
        <div class="shopee-chat-pieces-list">${cards}</div>
        <div class="shopee-chat-pieces-confirm-bar">${confirmBarHtml(data.pieces)}</div>
      `
      overlay.querySelector('#shopee-chat-piece-add')!.addEventListener('click', async () => {
        await addOrderPiece(order.workbookId, order.orderKey)
        void loadPieces()
      })
      bindPieceCards()
      bindConfirmBar(data.pieces)
      renderPieceButtons()
      updatePiecesToggleLabel(data)
    } catch (error) {
      piecesEl.innerHTML = `<div class="shopee-chat-error-inline">Falha ao carregar peças: ${escapeHtml((error as Error).message)}</div>`
      piecesToggleLabel.textContent = 'Peças da arte'
    }
  }

  messagesEl.addEventListener('click', (e) => {
    if (!armed) return
    const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('.shopee-chat-image-link')
    if (!link) return
    e.preventDefault()
    const url = link.getAttribute('href') || ''
    if (!url) return
    const { pieceId, slot } = armed
    armed = null
    messagesEl.classList.remove('shopee-chat-picking')
    void assignPiecePhoto(pieceId, slot, url)
      .then(() => loadPieces())
      .then(() => piecesOverlayEl.classList.add('open'))
      .catch((error) => {
        alert(`Falha ao usar essa foto: ${(error as Error).message}`)
      })
  })

  void loadEmojiCatalog().then(() => loadPieces())

  const close = () => closeShopeeChatPanel()
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close()
  })
  overlay.querySelector('.shopee-chat-close')!.addEventListener('click', close)

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      close()
      document.removeEventListener('keydown', onKey)
    }
  }
  document.addEventListener('keydown', onKey)

  let chatMeta: { conversationId: string; toId: number } | null = null

  const syncSendState = () => {
    sendBtn.disabled = !chatMeta || !inputEl.value.trim()
  }
  inputEl.addEventListener('input', syncSendState)

  sendBtn.addEventListener('click', async () => {
    if (!chatMeta) return
    const text = inputEl.value.trim()
    if (!text) return
    sendBtn.disabled = true
    inputEl.disabled = true
    try {
      await sendShopeeChatMessage({
        toId: chatMeta.toId,
        conversationId: chatMeta.conversationId,
        text,
      })
      inputEl.value = ''
      const history = await fetchShopeeChatHistory(order.buyerUsername)
      chatMeta = { conversationId: history.chat.conversationId, toId: history.chat.toId }
      messagesEl.innerHTML = renderMessages(history.messages, order.buyerUsername)
      messagesEl.scrollTop = messagesEl.scrollHeight
    } catch (error) {
      messagesEl.insertAdjacentHTML(
        'beforeend',
        `<div class="shopee-chat-error-inline">Falha ao enviar: ${escapeHtml((error as Error).message)}</div>`,
      )
    } finally {
      inputEl.disabled = false
      syncSendState()
      inputEl.focus()
    }
  })

  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!sendBtn.disabled) sendBtn.click()
    }
  })

  try {
    const history = await fetchShopeeChatHistory(order.buyerUsername)
    chatMeta = { conversationId: history.chat.conversationId, toId: history.chat.toId }
    messagesEl.innerHTML = renderMessages(history.messages, order.buyerUsername)
    if (history.truncated) {
      messagesEl.insertAdjacentHTML(
        'afterbegin',
        `<div class="shopee-chat-warn">Histórico truncado (${history.pages} páginas). Mensagens mais antigas podem não aparecer.</div>`,
      )
    }
    messagesEl.scrollTop = messagesEl.scrollHeight
    syncSendState()
    inputEl.focus()
  } catch (error) {
    messagesEl.innerHTML = `<div class="shopee-chat-error">${escapeHtml((error as Error).message)}</div>`
    sendBtn.disabled = true
    inputEl.disabled = true
  }
}
