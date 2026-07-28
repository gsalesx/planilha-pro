import './style.css';
import { checkAuth, login, syncShopeeWorkbookInitial } from './api';
async function api(path, init = {}) {
    const response = await fetch(`/api${path}`, { credentials: 'include', ...init });
    if (response.status === 401)
        throw new Error('Login necessário');
    const data = (await response.json().catch(() => ({})));
    if (!response.ok)
        throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
}
function el(tag, className) {
    const node = document.createElement(tag);
    if (className)
        node.className = className;
    return node;
}
function showLogin(onSuccess) {
    const overlay = el('div', 'login-overlay');
    overlay.innerHTML = `
    <form class="login-card">
      <h2>Planilha Pro — Shopee</h2>
      <p class="login-subtitle">Entre para testar a API de pedidos</p>
      <label><span>Usuário</span><input id="u" type="text" required autofocus /></label>
      <label><span>Senha</span><input id="p" type="password" required /></label>
      <button type="submit">Entrar</button>
      <div class="login-error" id="err" hidden></div>
    </form>
  `;
    const form = overlay.querySelector('form');
    const err = overlay.querySelector('#err');
    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        err.hidden = true;
        try {
            await login(overlay.querySelector('#u').value.trim(), overlay.querySelector('#p').value);
            overlay.remove();
            onSuccess();
        }
        catch (error) {
            err.hidden = false;
            err.textContent = error.message;
        }
    });
    document.body.appendChild(overlay);
}
function fmtTs(ms) {
    return new Date(ms).toLocaleString('pt-BR');
}
async function boot() {
    const root = document.querySelector('#app');
    root.innerHTML = '';
    const wrap = el('div', 'shopee-test-page');
    root.appendChild(wrap);
    const header = el('header', 'shopee-test-header');
    header.innerHTML = `
    <div>
      <a href="/" class="shopee-test-back">← Planilha</a>
      <h1>Teste Shopee — API</h1>
      <p class="shopee-test-sub">Pedidos, produtos e mensagens via Open Platform</p>
    </div>
  `;
    wrap.appendChild(header);
    const statusBox = el('section', 'shopee-test-card');
    statusBox.innerHTML = '<h2>Status</h2><div id="status-body">Carregando…</div>';
    wrap.appendChild(statusBox);
    const authBox = el('section', 'shopee-test-card');
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
  `;
    wrap.appendChild(authBox);
    const ordersBox = el('section', 'shopee-test-card');
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
    <div class="shopee-test-form shopee-test-form--detail">
      <label>Consultar pedido (order_sn)
        <input type="text" id="order-sn-detail" placeholder="ex: 260611QUNS9EA4" />
      </label>
      <button type="button" class="btn" id="btn-order-detail">get_order_detail</button>
    </div>
  `;
    wrap.appendChild(ordersBox);
    const syncBox = el('section', 'shopee-test-card');
    syncBox.innerHTML = `
    <h2>2b. Sincronizar planilha automática</h2>
    <p class="shopee-test-hint">
      Importa pedidos com status <strong>RETRY_SHIP</strong> para a planilha fixa Shopee.
      Se o pedido já existir, só atualiza Status Shopee (H) e nome do destinatário (G).
      <a href="/?workbook=wb_shopee">Abrir planilha Shopee</a>
    </p>
    <div class="shopee-test-form">
      <button type="button" class="btn btn-primary" id="btn-sync-initial">Importar últimos 5 dias (parcelado)</button>
      <span class="shopee-test-sync-progress" id="sync-initial-progress" hidden></span>
    </div>
    <div class="shopee-test-form">
      <label>Últimos dias <input type="number" id="sync-days" value="90" min="1" max="365" /></label>
      <button type="button" class="btn" id="btn-sync-workbook">Importar / atualizar (janela única)</button>
    </div>
  `;
    wrap.appendChild(syncBox);
    const productsBox = el('section', 'shopee-test-card');
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
  `;
    wrap.appendChild(productsBox);
    const messagesBox = el('section', 'shopee-test-card');
    messagesBox.innerHTML = `
    <h2>4. Mensagens (chat)</h2>

    <h3 class="shopee-test-subheading">4a. Listar conversas</h3>
    <p class="shopee-test-hint">
      Vínculo usa <code>direction=latest</code> e começa na <strong>página 285</strong> (cursor salvo em
      <code>/data</code>). Use <strong>Preparar cursor automaticamente</strong> — varre páginas 1→284 e grava o
      cursor da 285. Status: <span id="link-start-status">—</span>
    </p>
    <div class="shopee-test-form">
      <label>Direção
        <select id="chat-direction">
          <option value="latest" selected>latest (produção / vínculo)</option>
          <option value="older">older (teste — enum candidato)</option>
          <option value="newest">newest (teste)</option>
          <option value="oldest">oldest (teste — costuma param_error)</option>
        </select>
      </label>
      <label>Tipo
        <select id="chat-type">
          <option value="all" selected>all</option>
          <option value="pinned">pinned</option>
          <option value="unread">unread</option>
        </select>
      </label>
      <label>Por página <input type="number" id="chat-page-size" value="50" min="1" max="50" /></label>
      <label>next_timestamp_nano (2ª página em diante)
        <input type="text" id="chat-next-ts" placeholder="vazio = 1ª página" />
      </label>
      <label>Filtrar username
        <input type="text" id="chat-filter-name" placeholder="ex: giihfitcher" />
      </label>
      <button type="button" class="btn btn-primary" id="btn-warm-link-start" title="Varre conversas da página 1 até 284 e grava o cursor da página 285">Preparar cursor automaticamente (→ pág 285)</button>
      <button type="button" class="btn" id="btn-conversations">Listar conversas</button>
      <button type="button" class="btn" id="btn-conversations-next">Usar próximo cursor</button>
      <button type="button" class="btn" id="btn-save-link-start" title="Grava o next_timestamp_nano atual como início do vínculo (página 285)">Definir início manual (pág 285)</button>
      <button type="button" class="btn" id="btn-conversations-compare">Comparar latest / newest / oldest</button>
    </div>

    <h3 class="shopee-test-subheading">4b. Mensagens de um chat</h3>
    <p class="shopee-test-hint">
      Use o <code>conversation_id</code> copiado do passo 4a. Cada busca traz até “Por página” mensagens
      (não o chat inteiro). Offset vazio = mais recentes; próxima página = <code>next_offset</code> do JSON.
    </p>
    <div class="shopee-test-form shopee-test-form--detail">
      <label>conversation_id
        <input type="text" id="chat-conversation-id" placeholder="ex: 1403996256561827208" />
      </label>
      <label>Próxima página (next_offset — vazio na 1ª busca)
        <input type="text" id="chat-offset" placeholder="deixe vazio" />
      </label>
      <button type="button" class="btn btn-primary" id="btn-messages">Buscar página de mensagens</button>
      <button type="button" class="btn" id="btn-messages-all">Buscar histórico completo</button>
    </div>

    <h3 class="shopee-test-subheading">4c. Enviar mensagem (send_message)</h3>
    <p class="shopee-test-hint">
      Envio manual de texto via API. Usa <code>to_id</code> do comprador (não o conversation_id).
      Mensagem real — confira o chat no Seller Center depois.
    </p>
    <div class="shopee-test-form shopee-test-form--detail">
      <label>to_id (comprador)
        <input type="number" id="send-to-id" value="267446409" />
      </label>
      <label>conversation_id (referência / 4b)
        <input type="text" id="send-conversation-id" value="1148673580414533416" />
      </label>
      <label>Texto
        <input type="text" id="send-text" value="Teste API Planilha Pro — pode ignorar" />
      </label>
      <button type="button" class="btn btn-primary" id="btn-send-message">Enviar mensagem</button>
    </div>
  `;
    wrap.appendChild(messagesBox);
    const out = el('pre', 'shopee-test-output');
    out.textContent = 'Resultado aparece aqui…';
    wrap.appendChild(out);
    const statusBody = statusBox.querySelector('#status-body');
    async function refreshStatus() {
        const st = await api('/shopee/status');
        const lines = [];
        lines.push(`Ambiente API: <strong>${st.env}</strong>`);
        lines.push(`Partner ID: ${st.partnerId ?? '<em>não configurado</em>'}`);
        lines.push(`API Partner Key: ${st.hasPartnerKey ? '✓ configurada' : '✗ falta SHOPEE_PARTNER_KEY'}`);
        lines.push(`Push Partner Key: ${st.hasPushPartnerKey ? '✓ configurada' : '✗ falta SHOPEE_PUSH_PARTNER_KEY (Live Push Partner Key)'}`);
        if (st.pushCallbackUrl)
            lines.push(`Push callback: ${st.pushCallbackUrl}`);
        lines.push(`Redirect OAuth: ${st.redirectUrl ?? '<em>falta SHOPEE_REDIRECT_URL</em>'}`);
        if (st.shop) {
            lines.push(`Loja conectada: shop_id <strong>${st.shop.shopId}</strong>`);
            lines.push(`Token expira: ${fmtTs(st.shop.accessExpireAt)}`);
        }
        else {
            lines.push('Loja: <em>não autorizada ainda</em>');
        }
        statusBody.innerHTML = lines.join('<br/>');
        return st;
    }
    async function run(label, fn) {
        out.textContent = `${label}…`;
        try {
            const data = await fn();
            out.textContent = `=== ${label} ===\n${JSON.stringify(data, null, 2)}`;
        }
        catch (error) {
            out.textContent = `=== ${label} ===\nErro: ${error.message}`;
        }
    }
    authBox.querySelector('#btn-auth').addEventListener('click', async () => {
        try {
            const { url } = await api('/shopee/auth-url');
            window.open(url, '_blank', 'noopener');
        }
        catch (error) {
            out.textContent = `Erro: ${error.message}`;
        }
    });
    authBox.querySelector('#btn-shop').addEventListener('click', () => {
        void run('get_shop_info', () => api('/shopee/shop'));
    });
    authBox.querySelector('#btn-disconnect').addEventListener('click', async () => {
        await api('/shopee/disconnect', { method: 'POST' });
        await refreshStatus();
        out.textContent = 'Loja desconectada.';
    });
    authBox.querySelector('#btn-exchange').addEventListener('click', () => {
        const callbackUrl = authBox.querySelector('#callback-url').value.trim();
        void run('oauth/exchange', () => api('/shopee/oauth/exchange', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ callbackUrl }),
        }).then(async (data) => {
            await refreshStatus();
            return data;
        }));
    });
    ordersBox.querySelector('#btn-orders').addEventListener('click', () => {
        const hours = ordersBox.querySelector('#hours').value;
        const orderStatus = ordersBox.querySelector('#order-status').value;
        const timeRangeField = ordersBox.querySelector('#time-field').value;
        const qs = new URLSearchParams({ hours, timeRangeField });
        if (orderStatus)
            qs.set('orderStatus', orderStatus);
        void run('get_order_list', () => api(`/shopee/orders?${qs}`));
    });
    ordersBox.querySelector('#btn-order-detail').addEventListener('click', () => {
        const orderSn = ordersBox.querySelector('#order-sn-detail').value.trim();
        if (!orderSn) {
            out.textContent = 'Erro: informe order_sn';
            return;
        }
        const qs = new URLSearchParams({ orderSn });
        void run('get_order_detail', () => api(`/shopee/orders/detail?${qs}`));
    });
    syncBox.querySelector('#btn-sync-initial').addEventListener('click', async () => {
        const btn = syncBox.querySelector('#btn-sync-initial');
        const progress = syncBox.querySelector('#sync-initial-progress');
        btn.disabled = true;
        progress.hidden = false;
        progress.textContent = 'Iniciando…';
        try {
            const result = await syncShopeeWorkbookInitial(5, (done, total, parcel) => {
                progress.textContent = `Dia ${done}/${total} — ${parcel.listed} listados, ${parcel.created} novos`;
                out.textContent = `Importando… dia ${done} de ${total}`;
            });
            progress.textContent = `Concluído — ${result.created} novos, ${result.updated} atualizados`;
            out.textContent = `=== Importação 5 dias ===\n${JSON.stringify(result, null, 2)}`;
            if (result.errors.length) {
                alert(`${result.errors.length} erro(s) — veja o log abaixo`);
            }
        }
        catch (error) {
            out.textContent = `Erro: ${error.message}`;
            progress.textContent = '';
        }
        finally {
            btn.disabled = false;
        }
    });
    syncBox.querySelector('#btn-sync-workbook').addEventListener('click', () => {
        const days = syncBox.querySelector('#sync-days').value;
        void run('sync-workbook', () => api('/shopee/sync-workbook', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ days: Number(days) || 90 }),
        }));
    });
    productsBox.querySelector('#btn-products').addEventListener('click', () => {
        const offset = productsBox.querySelector('#product-offset').value;
        const pageSize = productsBox.querySelector('#product-page-size').value;
        const itemStatus = productsBox.querySelector('#product-status').value;
        const hours = productsBox.querySelector('#product-hours').value;
        const qs = new URLSearchParams({ offset, pageSize, itemStatus });
        if (Number(hours) > 0)
            qs.set('hours', hours);
        void run('get_item_list', () => api(`/shopee/products?${qs}`));
    });
    productsBox.querySelector('#btn-product-detail').addEventListener('click', () => {
        const itemIds = productsBox.querySelector('#product-ids').value.trim();
        if (!itemIds) {
            out.textContent = 'Erro: informe pelo menos um item_id';
            return;
        }
        const qs = new URLSearchParams({ itemIds });
        void run('get_item_base_info', () => api(`/shopee/products/detail?${qs}`));
    });
    let lastConvNextTs = null;
    let warmLinkStartRunning = false;
    const linkStartStatusEl = messagesBox.querySelector('#link-start-status');
    async function refreshLinkStartStatus() {
        try {
            const data = await api('/shopee/link-conversations/start-cursor');
            linkStartStatusEl.textContent = data.configured
                ? `configurado (${data.cursor?.slice(0, 8)}…)`
                : 'não configurado';
        }
        catch {
            linkStartStatusEl.textContent = 'erro ao ler';
        }
    }
    void refreshLinkStartStatus();
    function formatNanoTs(raw) {
        if (!raw)
            return '—';
        try {
            const ms = Number(BigInt(raw) / 1000000n);
            return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
        }
        catch {
            return raw;
        }
    }
    function formatConversationSummary(data) {
        const shopeeErr = data.shopee?.error;
        if (shopeeErr) {
            return `Erro Shopee: ${shopeeErr}${data.shopee?.message ? ` — ${data.shopee.message}` : ''}`;
        }
        const summary = data.summary;
        if (!summary)
            return 'Sem resumo (resposta vazia).';
        const filter = messagesBox.querySelector('#chat-filter-name').value.trim().toLowerCase();
        const lines = [
            `Chats nesta página: ${summary.count}`,
            `Mais páginas: ${summary.more === true ? 'sim' : summary.more === false ? 'não' : '?'}`,
            `Próximo cursor (next_timestamp_nano): ${summary.nextTimestampNano ?? '(nenhum)'}`,
            '',
            '--- Usernames por chat (compare com col E) ---',
        ];
        let shown = 0;
        for (const row of summary.rows) {
            const u = row.usernames;
            const haystack = Object.values(u).filter(Boolean).join(' ').toLowerCase();
            if (filter && !haystack.includes(filter))
                continue;
            shown++;
            lines.push(`#${shown} conv=${row.conversation_id ?? '?'} | parsed_for_link=${u.parsed_for_link ?? '—'}`, `    to_name=${u.to_name ?? '—'} | to_user_info.user_name=${u.to_user_info_user_name ?? '—'} | buyer_username=${u.buyer_username ?? '—'}`);
        }
        if (filter && shown === 0) {
            lines.push(`(nenhum chat contém "${filter}" nesta página)`);
        }
        return lines.join('\n');
    }
    messagesBox.querySelector('#btn-conversations').addEventListener('click', () => {
        const direction = messagesBox.querySelector('#chat-direction').value;
        const type = messagesBox.querySelector('#chat-type').value;
        const pageSize = messagesBox.querySelector('#chat-page-size').value;
        const nextTs = messagesBox.querySelector('#chat-next-ts').value.trim();
        const qs = new URLSearchParams({ direction, type, pageSize });
        if (nextTs)
            qs.set('nextTimestampNano', nextTs);
        out.textContent = 'get_conversation_list…';
        void (async () => {
            try {
                const data = await api(`/shopee/conversations?${qs}`);
                lastConvNextTs = data.summary?.nextTimestampNano ?? null;
                const summaryText = formatConversationSummary(data);
                out.textContent = `=== get_conversation_list ===\n${summaryText}\n\n--- JSON completo ---\n${JSON.stringify(data, null, 2)}`;
            }
            catch (error) {
                out.textContent = `=== get_conversation_list ===\nErro: ${error.message}`;
            }
        })();
    });
    messagesBox.querySelector('#btn-warm-link-start').addEventListener('click', () => {
        if (warmLinkStartRunning)
            return;
        const btn = messagesBox.querySelector('#btn-warm-link-start');
        warmLinkStartRunning = true;
        btn.disabled = true;
        out.textContent = 'Preparando cursor da página 285… página 0/284';
        void (async () => {
            let pageNumber = 0;
            let nextTimestampNano;
            const targetPage = 284;
            try {
                while (true) {
                    const data = await api('/shopee/link-conversations/warm-cursor/chunk', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ pageNumber, nextTimestampNano }),
                    });
                    if (data.nextTimestampNano) {
                        lastConvNextTs = data.nextTimestampNano;
                        messagesBox.querySelector('#chat-next-ts').value = data.nextTimestampNano;
                    }
                    out.textContent = [
                        '=== Preparar cursor página 285 ===',
                        `Página ${data.pageNumber}/${targetPage} | ${data.chatsOnPage} chats nesta página`,
                        data.done
                            ? data.saved
                                ? `Concluído — cursor salvo (início do vínculo na pág ${data.startPage}).\nnext_timestamp_nano: ${data.nextTimestampNano}`
                                : `Parou: ${data.error ?? 'sem cursor'}`
                            : 'Aguarde…',
                    ].join('\n');
                    if (data.done) {
                        await refreshLinkStartStatus();
                        break;
                    }
                    pageNumber = data.pageNumber;
                    nextTimestampNano = data.nextTimestampNano ?? undefined;
                    if (!nextTimestampNano)
                        break;
                }
            }
            catch (error) {
                out.textContent = `Erro ao preparar cursor: ${error.message}`;
            }
            finally {
                warmLinkStartRunning = false;
                btn.disabled = false;
            }
        })();
    });
    messagesBox.querySelector('#btn-conversations-next').addEventListener('click', () => {
        const input = messagesBox.querySelector('#chat-next-ts');
        if (!lastConvNextTs) {
            out.textContent = 'Erro: liste conversas primeiro — não há cursor salvo.';
            return;
        }
        input.value = lastConvNextTs;
        messagesBox.querySelector('#btn-conversations').dispatchEvent(new Event('click'));
    });
    messagesBox.querySelector('#btn-save-link-start').addEventListener('click', () => {
        const cursor = messagesBox.querySelector('#chat-next-ts').value.trim();
        if (!cursor) {
            out.textContent =
                'Erro: informe next_timestamp_nano (avance até a página 284 com "Usar próximo cursor", depois salve o próximo cursor).';
            return;
        }
        void (async () => {
            try {
                const data = await api('/shopee/link-conversations/start-cursor', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ nextTimestampNano: cursor }),
                });
                out.textContent = `Cursor salvo para início do vínculo na página ${data.startPage}.\nnext_timestamp_nano: ${data.nextTimestampNano}`;
                await refreshLinkStartStatus();
            }
            catch (error) {
                out.textContent = `Erro ao salvar cursor: ${error.message}`;
            }
        })();
    });
    messagesBox.querySelector('#btn-conversations-compare').addEventListener('click', () => {
        const type = messagesBox.querySelector('#chat-type').value;
        const pageSize = '20';
        out.textContent = 'Comparando latest / older / newest / oldest…';
        void (async () => {
            const lines = [
                '=== Comparar direction (1ª página, page_size=20) ===',
                'Objetivo: ver qual enum a Shopee aceita sem param_error e qual traz chats mais antigos.',
                '',
            ];
            for (const direction of ['latest', 'older', 'newest', 'oldest']) {
                const qs = new URLSearchParams({ direction, type, pageSize });
                try {
                    const data = await api(`/shopee/conversations?${qs}`);
                    const err = data.shopee?.error;
                    if (err) {
                        lines.push(`## ${direction}`);
                        lines.push(`ERRO: ${err}${data.shopee?.message ? ` — ${data.shopee.message}` : ''}`);
                        lines.push('');
                        continue;
                    }
                    const s = data.summary;
                    const first = s?.rows?.[0];
                    const last = s?.rows?.length ? s.rows[s.rows.length - 1] : undefined;
                    lines.push(`## ${direction}`);
                    lines.push(`Chats: ${s?.count ?? 0} | more: ${s?.more === true ? 'sim' : s?.more === false ? 'não' : '?'}`);
                    lines.push(`1º chat: ${first?.usernames?.parsed_for_link ?? '—'} | msg ${formatNanoTs(first?.last_message_ts)}`);
                    lines.push(`Último da página: ${last?.usernames?.parsed_for_link ?? '—'} | msg ${formatNanoTs(last?.last_message_ts)}`);
                    lines.push(`next_timestamp_nano: ${s?.nextTimestampNano ?? '—'}`);
                    lines.push('');
                }
                catch (error) {
                    lines.push(`## ${direction}`);
                    lines.push(`Falha HTTP: ${error.message}`);
                    lines.push('');
                }
            }
            out.textContent = lines.join('\n');
        })();
    });
    messagesBox.querySelector('#btn-messages').addEventListener('click', () => {
        const conversationId = messagesBox.querySelector('#chat-conversation-id').value.trim();
        if (!conversationId) {
            out.textContent = 'Erro: informe conversation_id';
            return;
        }
        const pageSize = messagesBox.querySelector('#chat-page-size').value;
        const offset = messagesBox.querySelector('#chat-offset').value.trim();
        const qs = new URLSearchParams({ conversationId, pageSize });
        if (offset)
            qs.set('offset', offset);
        void run('get_message', () => api(`/shopee/messages?${qs}`));
    });
    messagesBox.querySelector('#btn-messages-all').addEventListener('click', () => {
        const conversationId = messagesBox.querySelector('#chat-conversation-id').value.trim();
        if (!conversationId) {
            out.textContent = 'Erro: informe conversation_id';
            return;
        }
        const pageSize = messagesBox.querySelector('#chat-page-size').value;
        void run('get_message (histórico completo)', async () => {
            const all = [];
            let offset = '';
            let pages = 0;
            const maxPages = 30;
            while (pages < maxPages) {
                const qs = new URLSearchParams({ conversationId, pageSize });
                if (offset)
                    qs.set('offset', offset);
                const data = await api(`/shopee/messages?${qs}`);
                const batch = data.shopee?.response?.messages ?? [];
                all.push(...batch);
                const next = data.shopee?.response?.page_result?.next_offset;
                pages++;
                if (!next || batch.length === 0)
                    break;
                offset = next;
            }
            return {
                conversationId,
                pages,
                total: all.length,
                truncated: pages >= maxPages,
                messages: all,
            };
        });
    });
    messagesBox.querySelector('#btn-send-message').addEventListener('click', () => {
        const toId = Number(messagesBox.querySelector('#send-to-id').value);
        const conversationId = messagesBox.querySelector('#send-conversation-id').value.trim();
        const text = messagesBox.querySelector('#send-text').value.trim();
        if (!toId || toId <= 0) {
            out.textContent = 'Erro: informe to_id válido';
            return;
        }
        if (!text) {
            out.textContent = 'Erro: informe o texto da mensagem';
            return;
        }
        void run('send_message', () => api('/shopee/messages/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ toId, conversationId, text }),
        }));
    });
    if (new URLSearchParams(location.search).get('connected') === '1') {
        out.textContent = 'Loja autorizada com sucesso. Pode buscar pedidos.';
        history.replaceState({}, '', location.pathname);
    }
    await refreshStatus();
}
async function main() {
    try {
        const ok = await checkAuth();
        if (!ok) {
            showLogin(() => void boot());
            return;
        }
        await boot();
    }
    catch {
        showLogin(() => void boot());
    }
}
void main();
