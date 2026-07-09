import {
  addOrderPiece,
  assignPiecePhoto,
  deleteOrderPiece,
  fetchShopeeChatHistory,
  getOrderPieces,
  removePiecePhoto,
  sendShopeeChatMessage,
  updateOrderPiece,
  type OrderPiece,
  type PecaGenero,
  type PecaTamanho,
  type PecaTipo,
  type ShopeeChatMessage,
} from './api'

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
}

/** Mesmas opções da extensão Chrome que este picker substitui (Emoji 1/Emoji 2). */
const EMOJI_OPTIONS = ['-', '❤️', '🥰', '😍', '🤍', '💋', '😘']
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

  function emojiSelectHtml(name: string, current: string): string {
    const opts = EMOJI_OPTIONS.map(
      (em) => `<option value="${escapeHtml(em)}"${em === current ? ' selected' : ''}>${escapeHtml(em)}</option>`,
    ).join('')
    // valor manual (fora da lista padrão) — mostra como opção extra selecionada
    const extra =
      current && !EMOJI_OPTIONS.includes(current)
        ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}</option>`
        : ''
    return `<select class="shopee-chat-piece-emoji" data-name="${name}">${opts}${extra}</select>`
  }

  function pieceCardHtml(piece: OrderPiece): string {
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

    function slotHtml(slot: 1 | 2): string {
      const has = piece.photos[slot]
      const thumb = has
        ? `<img class="shopee-chat-piece-thumb" src="/api/pieces/${piece.id}/photo/${slot}" alt="Foto ${slot}" />`
        : `<div class="shopee-chat-piece-thumb shopee-chat-piece-thumb--empty">Foto ${slot}</div>`
      const removeBtn = has
        ? `<button type="button" class="shopee-chat-piece-photo-remove" data-piece-id="${piece.id}" data-slot="${slot}" title="Remover">×</button>`
        : ''
      return `
        <div class="shopee-chat-piece-slot">
          ${thumb}
          <button type="button" class="shopee-chat-piece-photo-pick" data-piece-id="${piece.id}" data-slot="${slot}">Escolher da conversa</button>
          ${removeBtn}
        </div>
      `
    }

    return `
      <article class="shopee-chat-piece-card" data-piece-id="${piece.id}">
        <header class="shopee-chat-piece-head">
          <span class="shopee-chat-piece-seq">Peça ${piece.seq}</span>
          <span class="shopee-chat-piece-molde">${escapeHtml(piece.molde)}</span>
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
        <div class="shopee-chat-piece-row">
          <label>Emoji 1 ${emojiSelectHtml('emoji1', piece.emoji1)}</label>
          <label>Emoji 2 ${emojiSelectHtml('emoji2', piece.emoji2)}</label>
          <label>Cor <input type="color" class="shopee-chat-piece-field" data-field="cor" value="${piece.cor || '#000000'}" /></label>
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
              : field === 'tamanho'
                ? { tamanho: value as PecaTamanho }
                : { cor: value }
        void updateOrderPiece(pieceId, patch).then(() => loadPieces())
      })
    })
    piecesEl.querySelectorAll<HTMLSelectElement>('.shopee-chat-piece-emoji').forEach((el) => {
      el.addEventListener('change', () => {
        const card = el.closest<HTMLElement>('.shopee-chat-piece-card')!
        const pieceId = Number(card.dataset.pieceId)
        const name = el.dataset.name as 'emoji1' | 'emoji2'
        const patch = name === 'emoji1' ? { emoji1: el.value } : { emoji2: el.value }
        void updateOrderPiece(pieceId, patch).then(() => loadPieces())
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

  async function loadPieces(): Promise<void> {
    try {
      const data = await getOrderPieces(order.workbookId, order.orderKey)
      const cards = data.pieces.map(pieceCardHtml).join('')
      const failedHint = data.autoFailed
        ? `<p class="shopee-chat-pieces-hint">Não deu pra montar a peça sozinho pelo SKU (${escapeHtml(data.autoFailed)}). Adicione na mão:</p>`
        : ''
      piecesEl.innerHTML = `
        <div class="shopee-chat-pieces-header">
          <button type="button" class="btn shopee-chat-piece-add" id="shopee-chat-piece-add">+ Adicionar peça</button>
        </div>
        ${failedHint}
        <div class="shopee-chat-pieces-list">${cards}</div>
      `
      overlay.querySelector('#shopee-chat-piece-add')!.addEventListener('click', async () => {
        await addOrderPiece(order.workbookId, order.orderKey)
        void loadPieces()
      })
      bindPieceCards()
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

  void loadPieces()

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
