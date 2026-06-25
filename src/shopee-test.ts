import './style.css'

import { checkAuth, login } from './api'

interface ShopeeStatus {
  configured: boolean
  env: string
  partnerId: string | null
  hasPartnerKey: boolean
  redirectUrl: string | null
  shop: { shopId: number; accessExpireAt: number; updatedAt: number } | null
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'include', ...init })
  if (response.status === 401) throw new Error('Login necessário')
  const data = (await response.json().catch(() => ({}))) as T & { error?: string }
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`)
  return data
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  return node
}

function showLogin(onSuccess: () => void): void {
  const overlay = el('div', 'login-overlay')
  overlay.innerHTML = `
    <form class="login-card">
      <h2>Planilha Pro — Shopee</h2>
      <p class="login-subtitle">Entre para testar a API de pedidos</p>
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

function fmtTs(ms: number): string {
  return new Date(ms).toLocaleString('pt-BR')
}

async function boot(): Promise<void> {
  const root = document.querySelector('#app')!
  root.innerHTML = ''
  const wrap = el('div', 'shopee-test-page')
  root.appendChild(wrap)

  const header = el('header', 'shopee-test-header')
  header.innerHTML = `
    <div>
      <a href="/" class="shopee-test-back">← Planilha</a>
      <h1>Teste Shopee — API</h1>
      <p class="shopee-test-sub">Pedidos, produtos e mensagens via Open Platform</p>
    </div>
  `
  wrap.appendChild(header)

  const statusBox = el('section', 'shopee-test-card')
  statusBox.innerHTML = '<h2>Status</h2><div id="status-body">Carregando…</div>'
  wrap.appendChild(statusBox)

  const authBox = el('section', 'shopee-test-card')
  authBox.innerHTML = `
    <h2>1. Autorizar loja</h2>
    <p class="shopee-test-hint">No console Shopee, cadastre o Redirect URL igual ao mostrado no status.</p>
    <div class="shopee-test-actions">
      <button type="button" class="btn btn-primary" id="btn-auth">Abrir autorização Shopee</button>
      <button type="button" class="btn" id="btn-shop">Testar get_shop_info</button>
      <button type="button" class="btn" id="btn-disconnect">Desconectar loja</button>
    </div>
    <div class="shopee-test-paste">
      <label>Colar URL de callback (use logo após autorizar — code expira em ~10 min)
        <input type="text" id="callback-url" placeholder="https://planilha.guilhermesales.com/api/shopee/oauth/callback?code=...&shop_id=..." />
      </label>
      <button type="button" class="btn btn-primary" id="btn-exchange">Trocar code por token</button>
    </div>
  `
  wrap.appendChild(authBox)

  const ordersBox = el('section', 'shopee-test-card')
  ordersBox.innerHTML = `
    <h2>2. Listar pedidos</h2>
    <div class="shopee-test-form">
      <label>Últimas horas <input type="number" id="hours" value="24" min="1" max="360" /></label>
      <label>Status
        <select id="order-status">
          <option value="">(todos na janela)</option>
          <option value="UNPAID">UNPAID</option>
          <option value="READY_TO_SHIP" selected>READY_TO_SHIP</option>
          <option value="PROCESSED">PROCESSED</option>
          <option value="SHIPPED">SHIPPED</option>
          <option value="COMPLETED">COMPLETED</option>
          <option value="CANCELLED">CANCELLED</option>
        </select>
      </label>
      <label>Campo de data
        <select id="time-field">
          <option value="create_time" selected>create_time</option>
          <option value="update_time">update_time</option>
        </select>
      </label>
      <button type="button" class="btn btn-primary" id="btn-orders">Buscar pedidos</button>
    </div>
  `
  wrap.appendChild(ordersBox)

  const productsBox = el('section', 'shopee-test-card')
  productsBox.innerHTML = `
    <h2>3. Listar produtos</h2>
    <div class="shopee-test-form">
      <label>Offset <input type="number" id="product-offset" value="0" min="0" /></label>
      <label>Por página <input type="number" id="product-page-size" value="20" min="1" max="100" /></label>
      <label>Status
        <select id="product-status">
          <option value="NORMAL" selected>NORMAL</option>
          <option value="UNLIST">UNLIST</option>
          <option value="BANNED">BANNED</option>
          <option value="DELETED">DELETED</option>
        </select>
      </label>
      <label>Atualizados nas últimas horas (0 = todos)
        <input type="number" id="product-hours" value="0" min="0" max="720" />
      </label>
      <button type="button" class="btn btn-primary" id="btn-products">Buscar produtos</button>
    </div>
    <div class="shopee-test-form shopee-test-form--detail">
      <label>Detalhe por item_id (vírgula)
        <input type="text" id="product-ids" placeholder="ex: 123456789,987654321" />
      </label>
      <button type="button" class="btn" id="btn-product-detail">get_item_base_info</button>
    </div>
  `
  wrap.appendChild(productsBox)

  const messagesBox = el('section', 'shopee-test-card')
  messagesBox.innerHTML = `
    <h2>4. Mensagens (chat)</h2>
    <div class="shopee-test-form">
      <label>Direção
        <select id="chat-direction">
          <option value="latest" selected>latest</option>
          <option value="oldest">oldest</option>
        </select>
      </label>
      <label>Tipo
        <select id="chat-type">
          <option value="all" selected>all</option>
          <option value="pinned">pinned</option>
          <option value="unread">unread</option>
        </select>
      </label>
      <label>Por página <input type="number" id="chat-page-size" value="20" min="1" max="50" /></label>
      <button type="button" class="btn btn-primary" id="btn-conversations">Listar conversas</button>
    </div>
    <p class="shopee-test-hint">“latest” ordena as <strong>conversas</strong> mais recentes. Para mensagens dentro do chat, use o cursor abaixo.</p>
    <div class="shopee-test-form shopee-test-form--detail">
      <label>conversation_id
        <input type="text" id="chat-conversation-id" placeholder="cole da lista acima" />
      </label>
      <label>Cursor offset (vazio = mensagens mais recentes)
        <input type="text" id="chat-offset" placeholder="latest" />
      </label>
      <button type="button" class="btn" id="btn-messages">Buscar mensagens</button>
    </div>
  `
  wrap.appendChild(messagesBox)

  const out = el('pre', 'shopee-test-output')
  out.textContent = 'Resultado aparece aqui…'
  wrap.appendChild(out)

  const statusBody = statusBox.querySelector('#status-body')!

  async function refreshStatus(): Promise<ShopeeStatus> {
    const st = await api<ShopeeStatus & { ok: boolean }>('/shopee/status')
    const lines: string[] = []
    lines.push(`Ambiente API: <strong>${st.env}</strong>`)
    lines.push(`Partner ID: ${st.partnerId ?? '<em>não configurado</em>'}`)
    lines.push(`Partner Key: ${st.hasPartnerKey ? '✓ configurada' : '✗ falta SHOPEE_PARTNER_KEY'}`)
    lines.push(`Redirect OAuth: ${st.redirectUrl ?? '<em>falta SHOPEE_REDIRECT_URL</em>'}`)
    if (st.shop) {
      lines.push(`Loja conectada: shop_id <strong>${st.shop.shopId}</strong>`)
      lines.push(`Token expira: ${fmtTs(st.shop.accessExpireAt)}`)
    } else {
      lines.push('Loja: <em>não autorizada ainda</em>')
    }
    statusBody.innerHTML = lines.join('<br/>')
    return st
  }

  async function run(label: string, fn: () => Promise<unknown>): Promise<void> {
    out.textContent = `${label}…`
    try {
      const data = await fn()
      out.textContent = JSON.stringify(data, null, 2)
    } catch (error) {
      out.textContent = `Erro: ${(error as Error).message}`
    }
  }

  authBox.querySelector('#btn-auth')!.addEventListener('click', async () => {
    try {
      const { url } = await api<{ url: string }>('/shopee/auth-url')
      window.open(url, '_blank', 'noopener')
    } catch (error) {
      out.textContent = `Erro: ${(error as Error).message}`
    }
  })

  authBox.querySelector('#btn-shop')!.addEventListener('click', () => {
    void run('get_shop_info', () => api('/shopee/shop'))
  })

  authBox.querySelector('#btn-disconnect')!.addEventListener('click', async () => {
    await api('/shopee/disconnect', { method: 'POST' })
    await refreshStatus()
    out.textContent = 'Loja desconectada.'
  })

  authBox.querySelector('#btn-exchange')!.addEventListener('click', () => {
    const callbackUrl = (authBox.querySelector('#callback-url') as HTMLInputElement).value.trim()
    void run('oauth/exchange', () =>
      api('/shopee/oauth/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callbackUrl }),
      }).then(async (data) => {
        await refreshStatus()
        return data
      }),
    )
  })

  ordersBox.querySelector('#btn-orders')!.addEventListener('click', () => {
    const hours = (ordersBox.querySelector('#hours') as HTMLInputElement).value
    const orderStatus = (ordersBox.querySelector('#order-status') as HTMLSelectElement).value
    const timeRangeField = (ordersBox.querySelector('#time-field') as HTMLSelectElement).value
    const qs = new URLSearchParams({ hours, timeRangeField })
    if (orderStatus) qs.set('orderStatus', orderStatus)
    void run('get_order_list', () => api(`/shopee/orders?${qs}`))
  })

  productsBox.querySelector('#btn-products')!.addEventListener('click', () => {
    const offset = (productsBox.querySelector('#product-offset') as HTMLInputElement).value
    const pageSize = (productsBox.querySelector('#product-page-size') as HTMLInputElement).value
    const itemStatus = (productsBox.querySelector('#product-status') as HTMLSelectElement).value
    const hours = (productsBox.querySelector('#product-hours') as HTMLInputElement).value
    const qs = new URLSearchParams({ offset, pageSize, itemStatus })
    if (Number(hours) > 0) qs.set('hours', hours)
    void run('get_item_list', () => api(`/shopee/products?${qs}`))
  })

  productsBox.querySelector('#btn-product-detail')!.addEventListener('click', () => {
    const itemIds = (productsBox.querySelector('#product-ids') as HTMLInputElement).value.trim()
    if (!itemIds) {
      out.textContent = 'Erro: informe pelo menos um item_id'
      return
    }
    const qs = new URLSearchParams({ itemIds })
    void run('get_item_base_info', () => api(`/shopee/products/detail?${qs}`))
  })

  messagesBox.querySelector('#btn-conversations')!.addEventListener('click', () => {
    const direction = (messagesBox.querySelector('#chat-direction') as HTMLSelectElement).value
    const type = (messagesBox.querySelector('#chat-type') as HTMLSelectElement).value
    const pageSize = (messagesBox.querySelector('#chat-page-size') as HTMLInputElement).value
    const qs = new URLSearchParams({ direction, type, pageSize })
    void run('get_conversation_list', () => api(`/shopee/conversations?${qs}`))
  })

  messagesBox.querySelector('#btn-messages')!.addEventListener('click', () => {
    const conversationId = (messagesBox.querySelector('#chat-conversation-id') as HTMLInputElement).value.trim()
    if (!conversationId) {
      out.textContent = 'Erro: informe conversation_id'
      return
    }
    const pageSize = (messagesBox.querySelector('#chat-page-size') as HTMLInputElement).value
    const offset = (messagesBox.querySelector('#chat-offset') as HTMLInputElement).value.trim()
    const qs = new URLSearchParams({ conversationId, pageSize })
    if (offset) qs.set('offset', offset)
    void run('get_message', () => api(`/shopee/messages?${qs}`))
  })

  if (new URLSearchParams(location.search).get('connected') === '1') {
    out.textContent = 'Loja autorizada com sucesso. Pode buscar pedidos.'
    history.replaceState({}, '', location.pathname)
  }

  await refreshStatus()
}

async function main(): Promise<void> {
  try {
    const ok = await checkAuth()
    if (!ok) {
      showLogin(() => void boot())
      return
    }
    await boot()
  } catch {
    showLogin(() => void boot())
  }
}

void main()
