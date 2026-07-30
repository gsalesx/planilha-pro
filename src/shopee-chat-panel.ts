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
  sendShopeePreview,
  setPiecePhotoCrop,
  updateEmojiAliases,
  updateOrderPiece,
  uploadPiecePhoto,
  type EmojiCatalogItem,
  type OrderPiece,
  type PecaGenero,
  type PecaTamanho,
  type PecaTipo,
  type PhotoCrop,
  type ShopeeChatMessage,
  type ShopeeQuotedMessage,
} from './api'
import { openConfirmDialog, openPreviewPickerDialog } from './dialog'
import { PREVIEW_SENT_STATUS, STATUS_COLUMN_INDEX } from './status'
import { openImageLightbox } from './lightbox'
import { abrirPickerEditor, abrirPickerFila, type ItemFila } from './picker-editor'
import {
  carregarImagem,
  CONJUNTO_POR_MOLDE,
  cortarPrintCanvas,
  labelDoMolde,
  moldeConjuntoPlaceholder,
  montarArteCanvas,
  montarConjuntoCanvas,
} from './render-molde-client'

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
  /** Foto do anúncio/produto (Shopee) — pra conferir "o que o cliente comprou de fato"
   * sem precisar entrar na Shopee (ex. quando ele pede "quero igual do anúncio" e a
   * loja tem vários anúncios parecidos). */
  productImageUrl?: string
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
const TAMANHO_OPTIONS: PecaTamanho[] = [
  'P', 'M', 'G', 'GG',
  '2 ANOS', '4 ANOS', '6 ANOS', '8 ANOS', '10 ANOS', '12 ANOS',
]

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
  // Lista (nomes/atalhos) sempre busca fresca — cachear isso arrisca mostrar
  // mapeamento desatualizado/conflitante se outra sessão mudou algo nesse meio-tempo.
  // As IMAGENS em si (bytes dos PNGs) são cacheadas pelo navegador via cache-control
  // (ver /emoji-assets e /api/emoji-catalog/custom no servidor).
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

/**
 * Faixa de contexto acima da bolha quando a mensagem é RESPOSTA a outra (`quoted_msg` da
 * Shopee — o app oficial mostra como um anexo pequeno acima do texto). Sem isso, uma
 * resposta como "Essa quero recordada em volta" ficava sem explicar A QUAL foto/mensagem
 * ela se referia, e o operador precisava abrir o app da Shopee só pra ver.
 */
function renderQuotedMessage(quoted: ShopeeQuotedMessage): string {
  const quemQuotou = quoted.fromBuyer ? 'Cliente' : 'Loja'
  // data-quoted-id: se a mensagem original estiver carregada na página, o clique rola
  // até ela (igual clicar numa resposta no WhatsApp). Se não estiver (página ainda
  // carregando mais histórico, por ex.), o clique simplesmente não faz nada — sem erro.
  const attrId = quoted.id ? ` data-quoted-id="${escapeHtml(quoted.id)}"` : ''
  const clicavel = quoted.id ? ' is-clickable' : ''
  if (quoted.imageUrl) {
    const url = escapeHtml(quoted.imageUrl)
    return `
      <div class="shopee-chat-quoted${clicavel}"${attrId}>
        <img class="shopee-chat-quoted-thumb" src="${url}" alt="Foto respondida" loading="lazy" referrerpolicy="no-referrer" />
        <span class="shopee-chat-quoted-label">${escapeHtml(quemQuotou)} enviou uma foto</span>
      </div>
    `
  }
  const isPlaceholder = /^\[\w+\]$/.test(quoted.text ?? '')
  const texto = isPlaceholder ? quemQuotou + ' enviou algo aqui' : quoted.text
  return `
    <div class="shopee-chat-quoted${clicavel}"${attrId}>
      <span class="shopee-chat-quoted-bar"></span>
      <span class="shopee-chat-quoted-text">${escapeHtml(texto)}</span>
    </div>
  `
}

function renderMessageBody(msg: ShopeeChatMessage): string {
  if (msg.imageUrl) {
    const url = escapeHtml(msg.imageUrl)
    // referrerpolicy=no-referrer: CDN da Shopee às vezes bloqueia hotlink com
    // Referer do nosso domínio — a foto some até fechar/abrir o chat. Retry
    // automático + botão ↻ cobrem falha intermitente (rede/429 no browser).
    const img = `<div class="shopee-chat-image-wrap">
      <a class="shopee-chat-image-link" href="${url}" target="_blank" rel="noopener noreferrer">
        <img class="shopee-chat-image" src="${url}" data-src="${url}" alt="Imagem enviada no chat"
             loading="lazy" referrerpolicy="no-referrer" data-retries="0" />
      </a>
    </div>`
    // Mensagens tipo "image_with_text" (ex.: "Esse no vestido" junto da foto)
    // vêm com imageUrl E text preenchidos — sem a legenda o operador precisa
    // abrir o app da Shopee só pra ver qual peça a foto se refere. Mas
    // imagem "simples" (sem legenda de verdade) também cai nesse ramo com
    // `text` = placeholder "[image]" OU a própria URL da imagem (fallback
    // do backend quando a Shopee não manda content.text) — nesses casos não
    // é legenda, não mostra nada.
    const isPlaceholder = /^\[\w+\]$/.test(msg.text ?? '')
    const isUrl = /^https?:\/\//i.test(msg.text ?? '')
    const caption = msg.text && !isPlaceholder && !isUrl
      ? `<div class="shopee-chat-image-caption">${escapeHtml(msg.text)}</div>`
      : ''
    return img + caption
  }
  return escapeHtml(msg.text)
}

const CHAT_IMAGE_MAX_AUTO_RETRIES = 3

function reloadChatImage(img: HTMLImageElement, bumpRetry = false): void {
  const src = img.getAttribute('data-src') || ''
  if (!src) return
  if (bumpRetry) {
    img.dataset.retries = String(Number(img.dataset.retries || '0') + 1)
  } else {
    img.dataset.retries = '0'
  }
  img.classList.remove('is-broken')
  img.classList.add('is-loading-retry')
  img.closest('.shopee-chat-image-wrap')?.classList.remove('is-broken')
  // Fragmento (#) força o browser a pedir de novo sem alterar a URL que o CDN vê
  // (query ?_r= quebraria URLs assinadas da Shopee).
  img.removeAttribute('src')
  img.src = `${src}#r=${Date.now()}`
}

function wireChatImages(root: HTMLElement): void {
  root.querySelectorAll<HTMLImageElement>('img.shopee-chat-image').forEach((img) => {
    if (img.dataset.wired === '1') return
    img.dataset.wired = '1'
    img.addEventListener('error', () => {
      const n = Number(img.dataset.retries || '0')
      if (n < CHAT_IMAGE_MAX_AUTO_RETRIES) {
        window.setTimeout(() => reloadChatImage(img, true), 400 * 2 ** n)
        return
      }
      img.classList.add('is-broken')
      img.classList.remove('is-loading-retry')
      img.closest('.shopee-chat-image-wrap')?.classList.add('is-broken')
    })
    img.addEventListener('load', () => {
      img.classList.remove('is-loading-retry', 'is-broken')
      img.closest('.shopee-chat-image-wrap')?.classList.remove('is-broken')
      img.dataset.retries = '0'
    })
  })
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
    const bolha = `<div class="shopee-chat-bubble ${side}">${msg.quotedMessage ? renderQuotedMessage(msg.quotedMessage) : ''}${renderMessageBody(msg)}</div>`
    // Botão de recarregar fica FORA do card, flutuando ao lado — igual o ícone de
    // encaminhar do WhatsApp. Um <button> DENTRO do card (mesmo como item de linha,
    // não sobreposto) ainda empurrava o tamanho do balão; ficando de fora, o card não
    // muda em nada e o botão só aparece quando a mensagem tem foto.
    const linha = msg.imageUrl
      ? `<div class="shopee-chat-image-linha ${side}">${bolha}<button type="button" class="shopee-chat-image-retry" title="Recarregar imagem" aria-label="Recarregar imagem">↻</button></div>`
      : bolha
    parts.push(`
      <div class="shopee-chat-bubble-wrap ${side}" data-message-id="${escapeHtml(msg.id)}">
        <div class="shopee-chat-bubble-meta">${escapeHtml(label)} · ${escapeHtml(fmtMessageTime(msg.createdAt))}</div>
        ${linha}
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
        <div class="shopee-chat-order-body">
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
          ${
            order.productImageUrl
              ? `<button type="button" class="shopee-chat-order-product-photo" id="shopee-chat-product-photo" title="Ver foto do anúncio em tamanho real">
                   <img src="${escapeHtml(order.productImageUrl)}" alt="Foto do anúncio" loading="lazy" />
                 </button>`
              : `<div class="shopee-chat-order-product-photo empty" title="Sem foto do anúncio">🛍️</div>`
          }
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
          <span>🧩 Criação da arte</span>
          <button type="button" class="btn shopee-chat-piece-add" id="shopee-chat-piece-add">+ Adicionar peça</button>
          <button type="button" class="shopee-chat-ajustar-todas" id="shopee-chat-ajustar-todas" hidden
                  title="Passa por todas as fotos deste pedido, uma a uma, pra ajustar o enquadramento">✎ Ajustar todas</button>
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
  const piecesAddBtn = overlay.querySelector<HTMLButtonElement>('#shopee-chat-piece-add')!
  const productPhotoBtn = overlay.querySelector<HTMLButtonElement>('#shopee-chat-product-photo')

  productPhotoBtn?.addEventListener('click', () => {
    if (order.productImageUrl) openImageLightbox(order.productImageUrl, `Anúncio — ${order.product || order.orderId}`)
  })

  // Fixo no header do overlay (junto do "Ajustar todas") — ligado 1x aqui, não a cada
  // loadPieces(), já que o botão não é recriado a cada render da lista.
  piecesAddBtn.addEventListener('click', async () => {
    await addOrderPiece(order.workbookId, order.orderKey)
    void loadPieces()
  })

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

  function pieceCardHtml(piece: OrderPiece, firstPieceId: number | null, rotuloLocal?: string): string {
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
      const ajustadoEm = piece.compostas?.[slot] ?? null
      // Já ajustado no picker → miniatura mostra o RESULTADO (o timestamp
      // evita cache velho depois de re-salvar). Senão, a foto crua.
      const fotoEm = piece.fotosUpdatedAt?.[slot] ?? null
      const src = ajustadoEm
        ? `/api/pieces/${piece.id}/photo/${slot}/composta?v=${ajustadoEm}`
        : pendingUrl
          ? escapeHtml(pendingUrl)
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
            <button type="button" class="shopee-chat-piece-photo-pick" data-piece-id="${piece.id}" data-slot="${slot}">Escolher da conversa</button>
            <label class="shopee-chat-piece-photo-upload" title="Subir foto de arquivo (ex.: cliente mandou link do Drive)">
              📤
              <input type="file" accept="image/*" class="shopee-chat-piece-photo-upload-input" data-piece-id="${piece.id}" data-slot="${slot}" hidden />
            </label>
          </div>
          ${has ? cropToggleHtml(slot) : ''}
          ${
            has
              ? `<button type="button" class="shopee-chat-piece-ajustar" data-piece-id="${piece.id}" data-slot="${slot}" data-molde="${escapeHtml(piece.molde)}" title="Ajustar enquadramento (coração/recorte)">✎ Ajustar</button>`
              : ''
          }
          ${removeBtn}
        </div>
      `
    }

    return `
      <article class="shopee-chat-piece-card" data-piece-id="${piece.id}">
        <header class="shopee-chat-piece-head">
          <span class="shopee-chat-piece-seq" title="A prévia desta peça vai pra linha dela na planilha">${escapeHtml(rotuloLocal ?? piece.rotulo ?? `Peça ${piece.seq}`)}</span>
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
          <button type="button" class="shopee-chat-piece-nota-toggle${piece.nota?.trim() ? ' has-nota' : ''}"
                  data-piece-id="${piece.id}"
                  title="${piece.nota?.trim() ? 'Ver/editar observação' : 'Adicionar observação (raro)'}">📝</button>
        </div>
        <div class="shopee-chat-piece-nota${piece.nota?.trim() ? ' is-open' : ''}" data-piece-id="${piece.id}">
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
    piecesEl.querySelectorAll<HTMLButtonElement>('.shopee-chat-piece-nota-toggle').forEach((btn) => {
      btn.addEventListener('click', () => {
        const pieceId = btn.dataset.pieceId
        const box = piecesEl.querySelector<HTMLElement>(`.shopee-chat-piece-nota[data-piece-id="${pieceId}"]`)
        if (!box) return
        box.classList.toggle('is-open')
        if (box.classList.contains('is-open')) box.querySelector('textarea')?.focus()
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
    piecesEl.querySelectorAll<HTMLInputElement>('.shopee-chat-piece-photo-upload-input').forEach((input) => {
      input.addEventListener('change', () => {
        void (async () => {
          const file = input.files?.[0]
          if (!file) return
          const pieceId = Number(input.dataset.pieceId)
          const slot = Number(input.dataset.slot) as 1 | 2
          try {
            await uploadPiecePhoto(pieceId, slot, file)
            void loadPieces()
          } catch (error) {
            alert(`Falha ao subir foto: ${(error as Error).message}`)
            input.value = ''
          }
        })()
      })
    })
    piecesEl.querySelectorAll<HTMLButtonElement>('.shopee-chat-piece-photo-remove').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await removePiecePhoto(Number(btn.dataset.pieceId), Number(btn.dataset.slot) as 1 | 2)
        void loadPieces()
      })
    })
    piecesEl.querySelectorAll<HTMLButtonElement>('.shopee-chat-piece-ajustar').forEach((btn) => {
      btn.addEventListener('click', () => {
        void abrirPickerEditor({
          pieceId: Number(btn.dataset.pieceId),
          slot: Number(btn.dataset.slot) as 1 | 2,
          titulo: `${btn.dataset.molde ?? ''} — Foto ${btn.dataset.slot}`,
          onSalvo: () => void loadPieces(),
        })
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
          <button type="button" class="btn emoji-gallery-mold-btn" title="Abre o Molde.psd no Photopea pra criar emoji novo">
            Criar emoji no Photopea
          </button>
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
    const moldBtn = modal.querySelector<HTMLButtonElement>('.emoji-gallery-mold-btn')!
    const uploadInput = modal.querySelector<HTMLInputElement>('.emoji-gallery-upload-input')!
    const uploadNameInput = modal.querySelector<HTMLInputElement>('.emoji-gallery-upload-name')!

    moldBtn.addEventListener('click', () => {
      const moldUrl = `${window.location.origin}/emoji-mold/Molde.psd`
      const config = encodeURIComponent(JSON.stringify({ files: [moldUrl] }))
      window.open(`https://www.photopea.com#${config}`, '_blank', 'noopener,noreferrer')
    })

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

  function acoesExtraBtnHtml(pieces: OrderPiece[]): string {
    return `
      <button type="button" class="btn shopee-chat-gerar-previa" id="shopee-chat-gerar-previa"
              ${pieces.length === 0 ? 'disabled' : ''}
              title="Monta a arte de cada peça e grava o print 4x4 na coluna de foto — pedido vira Pronto quando todas as peças tiverem prévia">🖨 Gerar prévia</button>
      <button type="button" class="btn shopee-chat-baixar-artes" id="shopee-chat-baixar-artes"
              ${pieces.length === 0 ? 'disabled' : ''}
              title="Monta e baixa a(s) arte(s) deste pedido agora, sem esperar virar Aprovado">⬇ Baixar arte(s)</button>
    `
  }

  function confirmBarHtml(pieces: OrderPiece[]): string {
    if (order.status === CONFIRMED_STATUS) {
      return `
        <div class="shopee-chat-pieces-confirmed">✓ Pedido confirmado</div>
        ${acoesExtraBtnHtml(pieces)}
      `
    }
    const missing = pieces.filter((p) => !p.photos[1]).length
    const label = missing > 0 ? `✅ Confirmar pedido (${missing} peça(s) sem foto)` : '✅ Confirmar pedido'
    return `
      <button type="button" class="btn btn-primary shopee-chat-confirm-order" id="shopee-chat-confirm-order"
              ${pieces.length === 0 ? 'disabled' : ''}>${label}</button>
      ${acoesExtraBtnHtml(pieces)}
    `
  }

  /** Chama uma rota que baixa um blob (arte) ou devolve JSON (prévia), com o mesmo
   *  padrão de rótulo "carregando"/erro — evita repetir o try/finally 2x. */
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

  /**
   * Monta a arte de UMA peça inteiramente no NAVEGADOR — busca as 2 fotos já
   * compostas (900×900, prontas há tempos, sem processamento nenhum aqui) e
   * os 2 emojis (350×350) e desenha no canvas (render-molde-client.ts). O
   * servidor só serve arquivos estáticos nessa parte; quem monta é a aba de
   * quem clicou. Peça sem foto composta ainda lança erro (mesma regra do
   * servidor: "ajuste as fotos no picker antes").
   */
  /** Molde CONJ (conjunto multi-painel Frente/Manga/Short) devolve um .zip com
   *  os 3 JPGs — mesmo padrão do servidor (gerarArteDaPeca) e do pipeline
   *  Python (`_export_conjunto`). `painelPreview`, quando pedido, é o Blob do
   *  painel "Frente" isolado (usado pra recortar o print — não faz sentido
   *  recortar print de um zip). */
  async function montarArtePecaNoNavegador(
    p: OrderPiece,
    opts?: { painelPreview?: boolean },
  ): Promise<{ nome: string; blob: Blob; painelPreview?: Blob }> {
    const fotoUrl = (slot: 1 | 2) => `/api/pieces/${p.id}/photo/${slot}/composta`
    // ?v=updated_at: a rota é cacheada 1h (URL fixa por peça/slot) — sem esse
    // cache-buster, trocar o emoji na peça (emoji1/emoji2) continua servindo o
    // PNG antigo do navegador até o cache expirar, mesmo o servidor já
    // resolvendo o novo nome corretamente (bug: carol0595fm — cor mudava na
    // hora, emoji continuava saindo o de antes até trocar de novo bem depois).
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
    if (fotos.length === 0) throw new Error(`${p.molde}: nenhuma foto composta — ajuste as fotos no picker antes`)
    if (fotos.length === 1) fotos.push(fotos[0])

    // 404 da rota tem 2 causas bem diferentes, distinguidas pelo campo
    // `semEmoji` no corpo JSON (ver GET /pieces/:id/emoji/:slot no servidor):
    //   semEmoji=true  → peça sem emoji nesse slot DE PROPÓSITO (vazio/"SEM
    //                    EMOJI") — não é erro, só não desenha a camada.
    //   semEmoji=false → tem um NOME cadastrado que não bate com nenhum
    //                    arquivo do catálogo (typo, emoji custom faltando) —
    //                    ANTES isso era engolido como "sem emoji" e a
    //                    prévia saía faltando um emoji que devia aparecer,
    //                    sem nenhum aviso (bug: william.sfe, brbaraaguenavalle).
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
    if (emojiFalhas.length > 0) {
      throw new Error(`${p.molde}: ${emojiFalhas.join('; ')}`)
    }

    const molde = p.molde.trim().toUpperCase()
    const cliente = order.buyerUsername || order.orderId

    // CONJ infantil (ex "6 ANOS CONJ FEM") também é conjunto — usa a
    // geometria placeholder (M CONJ FEM), ver moldeConjuntoPlaceholder.
    if (CONJUNTO_POR_MOLDE[moldeConjuntoPlaceholder(molde)]) {
      const paineis = await montarConjuntoCanvas({ molde, cor: p.cor || '#000000', fotos, emojis })
      const { default: JSZip } = await import('jszip')
      const zip = new JSZip()
      for (const { painel, blob } of paineis) zip.file(`${labelDoMolde(molde)} ${painel}.jpg`, blob)
      const buf = await zip.generateAsync({ type: 'blob' })
      const frente = paineis.find((x) => x.painel === 'Frente')?.blob
      return { nome: `${cliente} ${labelDoMolde(molde)}.zip`, blob: buf, painelPreview: opts?.painelPreview ? frente : undefined }
    }

    const blob = await montarArteCanvas({ molde, cor: p.cor || '#000000', fotos, emojis })
    return { nome: `${cliente} ${labelDoMolde(molde)}.jpg`, blob, painelPreview: opts?.painelPreview ? blob : undefined }
  }

  function baixarBlob(nome: string, blob: Blob): void {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = nome
    a.click()
    URL.revokeObjectURL(url)
  }

  /** Baixa a(s) arte(s) do pedido inteiro — montadas na hora NO NAVEGADOR, sem
   *  esperar "Aprovado" e sem processar nada no servidor compartilhado. */
  function bindBaixarArtes(pieces: OrderPiece[]): void {
    const btn = overlay.querySelector<HTMLButtonElement>('#shopee-chat-baixar-artes')
    if (!btn) return
    btn.addEventListener('click', () =>
      acionarBotaoAssincrono(btn, '⏳ Montando…', async () => {
        if (pieces.length === 0) throw new Error('Nenhuma peça montada ainda pra este pedido')
        const geradas: Array<{ nome: string; blob: Blob }> = []
        const falhas: string[] = []
        for (const p of pieces) {
          try {
            geradas.push(await montarArtePecaNoNavegador(p))
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
        baixarBlob(`${order.buyerUsername || order.orderId}.zip`, buf)
      }),
    )
  }

  /**
   * Gera a prévia (print) de cada peça do pedido — a arte inteira é montada NO
   * NAVEGADOR (mesma função de "Baixar arte", ver montarArtePecaNoNavegador) e
   * recortada também no navegador (cortarPrintCanvas); só o print final (pequeno,
   * ~200KB) sobe pro servidor via /pieces/:id/print-upload, que apenas GRAVA — não
   * processa nada. Substitui a antiga rota /gerar-previas (que montava a folha
   * inteira NO SERVIDOR, ~14s medidos numa peça real — o gargalo que competia por
   * CPU com outras operações no mesmo container).
   *
   * Depois de subir, abre o MESMO popup de "Enviar prévia" que já existe no grid,
   * pro operador escolher ali mesmo qual(is) mandar no chat sem sair do painel.
   */
  function bindGerarPrevia(pieces: OrderPiece[]): void {
    const btn = overlay.querySelector<HTMLButtonElement>('#shopee-chat-gerar-previa')
    if (!btn) return
    btn.addEventListener('click', () =>
      acionarBotaoAssincrono(btn, '⏳ Gerando…', async () => {
        if (pieces.length === 0) throw new Error('Nenhuma peça montada ainda pra este pedido')
        const previas: Array<{ orderKey: string; col: number; label: string }> = []
        const falhas: string[] = []
        for (const p of pieces) {
          try {
            const { blob, painelPreview } = await montarArtePecaNoNavegador(p, { painelPreview: true })
            const nFotos = (p.photos[1] ? 1 : 0) + (p.photos[2] ? 1 : 0)
            const print = await cortarPrintCanvas(painelPreview ?? blob, Math.max(1, nFotos))
            const fd = new FormData()
            fd.append('image', print, 'print.jpg')
            const r = await fetch(`/api/pieces/${p.id}/print-upload`, {
              method: 'POST',
              credentials: 'include',
              body: fd,
            })
            const up = (await r.json().catch(() => ({}))) as { error?: string; col?: number }
            if (!r.ok) throw new Error(up.error ?? `HTTP ${r.status}`)
            previas.push({ orderKey: p.orderKey ?? order.orderKey, col: up.col ?? 8, label: labelDoMolde(p.molde) })
          } catch (e) {
            falhas.push(`${p.molde}: ${(e as Error).message}`)
          }
        }
        if (previas.length === 0) throw new Error(falhas[0] ?? 'nenhuma prévia pôde ser gerada')
        // Falha PARCIAL (algumas peças geraram, outras não) ficava silenciosa — só
        // dava erro visível se TODAS falhassem, então "sumia" 1 peça sem explicação
        // nenhuma (esse foi exatamente o sintoma reportado: "só aparece a última").
        if (falhas.length > 0) alert(`Atenção: ${falhas.length} peça(s) não geraram prévia:\n${falhas.join('\n')}`)

        const cacheBuster = Date.now() // a imagem acabou de ser trocada — evita servir a antiga do cache do navegador
        openPreviewPickerDialog({
          title: 'Enviar prévia',
          items: previas.map((p) => ({
            col: p.col,
            orderKey: p.orderKey,
            label: p.label,
            imageUrl: `/api/workbooks/${encodeURIComponent(order.workbookId)}/images/${encodeURIComponent(p.orderKey)}/${p.col}?t=${cacheBuster}`,
          })),
          onSend: async (item) => {
            // Só manda a imagem — NÃO mexe em status. O operador pode mandar quantas
            // peças quiser (o modal fica aberto, cada uma vira "✓ Enviada") antes de
            // decidir fechar o ciclo em "Marcar como prévia".
            await sendShopeePreview({
              username: order.buyerUsername,
              workbookId: order.workbookId,
              orderKey: item.orderKey ?? order.orderKey,
              col: item.col,
            })
          },
          onMarkAsPreview: async () => {
            // Sempre a linha-PAI (pieces[0].orderKey) — o painel pode ter aberto a
            // partir de qualquer linha, e só patchar o pai aciona o cascade pras
            // filhas no servidor (nunca o contrário).
            const chavePai = pieces[0]?.orderKey ?? order.orderKey
            await patchOrderDelta(order.workbookId, chavePai, {
              cells: [{ col: STATUS_COLUMN_INDEX, value: PREVIEW_SENT_STATUS }],
            })
            if (chavePai === order.orderKey) {
              order.status = PREVIEW_SENT_STATUS
            }
          },
        })
      }),
    )
  }

  function bindConfirmBar(pieces: OrderPiece[]): void {
    const btn = overlay.querySelector<HTMLButtonElement>('#shopee-chat-confirm-order')
    bindBaixarArtes(pieces)
    bindGerarPrevia(pieces)
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

  /**
   * "Ajustar todas": monta a fila com TODAS as fotos do pedido (peça a peça,
   * slot a slot) e passa uma por uma — mesmo ritmo do picker local, em vez de
   * abrir cada foto na mão.
   */
  function montarFilaAjuste(pieces: OrderPiece[]): void {
    const btn = overlay.querySelector<HTMLButtonElement>('#shopee-chat-ajustar-todas')
    if (!btn) return
    const fila: ItemFila[] = []
    for (const p of pieces) {
      for (const slot of [1, 2] as const) {
        if (p.photos[slot]) {
          fila.push({ pieceId: p.id, slot, titulo: `${p.molde} — Foto ${slot}` })
        }
      }
    }
    btn.hidden = fila.length === 0
    btn.textContent = `✎ Ajustar todas (${fila.length})`
    btn.onclick = () => {
      void abrirPickerFila(fila, () => void loadPieces())
    }
  }

  /**
   * Agrupa as peças por UNIDADE comprada (mesmo orderKey — mesma linha da planilha) e
   * antepõe um separador com o "nome" da unidade (SKU dela) antes do 1º card do grupo.
   * Pedido do user: uma unidade só (ex. SHORT) vs. um combo (ex. CAMISOLA + SHORT) ficavam
   * misturados numa sequência solta ("Peça 1 de 4", "Peça 2 de 4"…) sem indicar onde uma
   * unidade termina e a próxima começa — o header marca essa fronteira.
   */
  function cardsComSeparadores(pieces: OrderPiece[], firstPieceId: number | null): string {
    const grupos = new Map<string, OrderPiece[]>()
    for (const p of pieces) {
      const chave = p.orderKey ?? String(p.id)
      const g = grupos.get(chave) ?? []
      g.push(p)
      grupos.set(chave, g)
    }
    const partes: string[] = []
    let indiceGrupo = 0
    for (const [, grupo] of grupos) {
      indiceGrupo++
      const nomeUnidade = grupo.map((p) => p.molde).join(' + ')
      partes.push(`
        <div class="shopee-chat-piece-separador">
          <span class="shopee-chat-piece-separador-num">${indiceGrupo}º</span>
          <span class="shopee-chat-piece-separador-nome">${escapeHtml(nomeUnidade)}</span>
        </div>
      `)
      // Rótulo LOCAL ao grupo — "Peça 1 de 1" pra unidade simples, "Peça 1 de 2"/"2 de 2"
      // dentro do combo. O piece.rotulo do servidor é global ao pedido inteiro (útil só
      // pra saber a ordem geral); aqui o que importa é a posição dentro da COMPRA.
      grupo.forEach((p, i) => {
        const rotuloLocal = `Peça ${i + 1} de ${grupo.length}`
        partes.push(pieceCardHtml(p, p.id === firstPieceId ? null : firstPieceId, rotuloLocal))
      })
    }
    return partes.join('')
  }

  async function loadPieces(): Promise<void> {
    try {
      const data = await getOrderPieces(order.workbookId, order.orderKey)
      const firstId = data.pieces[0]?.id ?? null
      const cards = cardsComSeparadores(data.pieces, firstId)
      const failedHint = data.autoFailed
        ? `<p class="shopee-chat-pieces-hint">Não deu pra montar a peça sozinho pelo SKU (${escapeHtml(data.autoFailed)}). Adicione na mão:</p>`
        : ''
      piecesEl.innerHTML = `
        ${failedHint}
        <div class="shopee-chat-pieces-list">${cards}</div>
        <div class="shopee-chat-pieces-confirm-bar">${confirmBarHtml(data.pieces)}</div>
      `
      // "+ Adicionar peça" mora no HEADER do overlay (fixo, junto do "Ajustar todas") —
      // não é recriado a cada loadPieces(), então o listener é ligado 1x só, fora daqui.
      bindPieceCards()
      bindConfirmBar(data.pieces)
      renderPieceButtons()
      updatePiecesToggleLabel(data)
      montarFilaAjuste(data.pieces)
    } catch (error) {
      piecesEl.innerHTML = `<div class="shopee-chat-error-inline">Falha ao carregar peças: ${escapeHtml((error as Error).message)}</div>`
      piecesToggleLabel.textContent = 'Peças da arte'
    }
  }

  messagesEl.addEventListener('click', (e) => {
    const retryBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.shopee-chat-image-retry')
    if (retryBtn) {
      e.preventDefault()
      e.stopPropagation()
      // Botão fica FORA do card (irmão da bolha) — sobe pro container da linha
      // (.shopee-chat-image-linha) pra achar a imagem dentro da bolha ao lado.
      const linha = retryBtn.closest('.shopee-chat-image-linha')
      const img = linha?.querySelector<HTMLImageElement>('img.shopee-chat-image')
      if (img) reloadChatImage(img, false)
      return
    }
    const quotedEl = (e.target as HTMLElement).closest<HTMLElement>('.shopee-chat-quoted.is-clickable')
    if (quotedEl) {
      const id = quotedEl.dataset.quotedId
      // A mensagem original pode não estar carregada (fora da janela de histórico
      // atual) — nesse caso não tem pra onde rolar, e o clique não faz nada.
      const alvo = id ? messagesEl.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`) : null
      if (alvo) {
        alvo.scrollIntoView({ behavior: 'smooth', block: 'center' })
        alvo.classList.add('shopee-chat-bubble-wrap--highlight')
        window.setTimeout(() => alvo.classList.remove('shopee-chat-bubble-wrap--highlight'), 1600)
      }
      return
    }
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
      wireChatImages(messagesEl)
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
    wireChatImages(messagesEl)
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
