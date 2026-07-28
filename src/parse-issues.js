import './style.css';
import { checkAuth, login } from './api';
async function api(path, init = {}) {
    const response = await fetch(`/api${path}`, { credentials: 'include', ...init });
    if (response.status === 401)
        throw new Error('Login necessário');
    const data = (await response.json().catch(() => ({})));
    if (!response.ok)
        throw new Error(data.error ?? `HTTP ${response.status}`);
    return data;
}
function escapeHtml(s) {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
function fmtDate(ms) {
    try {
        return new Intl.DateTimeFormat('pt-BR', {
            day: '2-digit',
            month: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
        }).format(new Date(ms));
    }
    catch {
        return '';
    }
}
function showLogin(onSuccess) {
    const overlay = document.createElement('div');
    overlay.className = 'login-overlay';
    overlay.innerHTML = `
    <form class="login-card">
      <h2>Planilha Pro — Pendências SKU</h2>
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
async function boot() {
    const root = document.querySelector('#app');
    root.innerHTML = `
    <div class="parse-issues-page">
      <header class="app-header">
        <a href="/" class="shopee-test-back">← Planilhas</a>
        <h1>Pendências SKU → peça</h1>
        <div class="parse-issues-toolbar">
          <button type="button" class="btn" id="btn-scan">Rodar varredura</button>
          <button type="button" class="btn" id="btn-refresh">Atualizar</button>
        </div>
      </header>
      <main class="parse-issues-main">
        <p class="parse-issues-status" id="status">Carregando…</p>
        <table class="parse-issues-table">
          <thead>
            <tr>
              <th>Quando</th>
              <th>Pedido</th>
              <th>SKU</th>
              <th>Modelo</th>
              <th>Motivo</th>
              <th></th>
            </tr>
          </thead>
          <tbody id="rows"></tbody>
        </table>
      </main>
    </div>
  `;
    const statusEl = root.querySelector('#status');
    const rowsEl = root.querySelector('#rows');
    const scanBtn = root.querySelector('#btn-scan');
    function renderRow(issue) {
        return `
      <tr data-id="${issue.id}">
        <td>${fmtDate(issue.created_at)}</td>
        <td>${escapeHtml(issue.order_id)}</td>
        <td><code>${escapeHtml(issue.sku || '—')}</code></td>
        <td><code>${escapeHtml(issue.model_name || '—')}</code></td>
        <td>${escapeHtml(issue.reason)}</td>
        <td><button type="button" class="btn parse-issue-resolve" data-id="${issue.id}">Marcar resolvida</button></td>
      </tr>
    `;
    }
    function bindRows() {
        rowsEl.querySelectorAll('.parse-issue-resolve').forEach((btn) => {
            btn.addEventListener('click', async () => {
                const id = Number(btn.dataset.id);
                btn.disabled = true;
                try {
                    await api(`/parse-issues/${id}/resolve`, { method: 'POST' });
                    btn.closest('tr')?.remove();
                    if (!rowsEl.children.length)
                        statusEl.textContent = 'Nenhuma pendência aberta.';
                }
                catch (error) {
                    alert(error.message);
                    btn.disabled = false;
                }
            });
        });
    }
    async function loadIssues() {
        statusEl.textContent = 'Carregando…';
        try {
            const data = await api('/parse-issues?resolved=0');
            rowsEl.innerHTML = data.issues.map(renderRow).join('');
            bindRows();
            statusEl.textContent = data.issues.length
                ? `${data.issues.length} pendência(s) aberta(s)`
                : 'Nenhuma pendência aberta.';
        }
        catch (error) {
            statusEl.textContent = `Erro: ${error.message}`;
        }
    }
    scanBtn.addEventListener('click', async () => {
        scanBtn.disabled = true;
        scanBtn.textContent = 'Varrendo…';
        try {
            const data = await api('/parse-issues/scan', { method: 'POST' });
            await loadIssues();
            if (data.issuesCreated)
                alert(`${data.issuesCreated} pendência(s) nova(s) encontrada(s).`);
        }
        catch (error) {
            alert(error.message);
        }
        finally {
            scanBtn.disabled = false;
            scanBtn.textContent = 'Rodar varredura';
        }
    });
    root.querySelector('#btn-refresh').addEventListener('click', () => void loadIssues());
    await loadIssues();
}
void checkAuth().then((ok) => {
    if (ok)
        void boot();
    else
        showLogin(() => void boot());
});
