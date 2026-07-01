import { fetchShopeeChatHistory, sendShopeeChatMessage, type ShopeeChatMessage } from './api'

export interface ShopeeChatOrderInfo {
  orderId: string
  product: string
  model: string
  quantity: string
  status: string
  buyerUsername: string
  recipient: string
  sheetDate?: string
}

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
    </aside>
  `
  document.body.appendChild(overlay)
  activePanel = overlay

  const messagesEl = overlay.querySelector<HTMLElement>('#shopee-chat-messages')!
  const inputEl = overlay.querySelector<HTMLTextAreaElement>('.shopee-chat-input')!
  const sendBtn = overlay.querySelector<HTMLButtonElement>('.shopee-chat-send')!

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
