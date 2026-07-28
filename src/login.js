import { login } from './api';
export function showLoginScreen(onSuccess) {
    const overlay = document.createElement('div');
    overlay.className = 'login-overlay';
    overlay.innerHTML = `
    <form class="login-card" autocomplete="on">
      <h2>Planilha Pro</h2>
      <p class="login-subtitle">Entre para acessar a planilha compartilhada</p>
      <label>
        <span>Usuário</span>
        <input id="login-username" type="text" autocomplete="username" autofocus required />
      </label>
      <label>
        <span>Senha</span>
        <input id="login-password" type="password" autocomplete="current-password" required />
      </label>
      <button type="submit" id="login-submit">Entrar</button>
      <div class="login-error" id="login-error" hidden></div>
    </form>
  `;
    const form = overlay.querySelector('form');
    const errBox = overlay.querySelector('#login-error');
    const submit = overlay.querySelector('#login-submit');
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const username = (overlay.querySelector('#login-username')).value.trim();
        const password = (overlay.querySelector('#login-password')).value;
        errBox.hidden = true;
        submit.disabled = true;
        submit.textContent = 'Entrando...';
        try {
            await login(username, password);
            overlay.remove();
            onSuccess();
        }
        catch (error) {
            errBox.hidden = false;
            errBox.textContent = error.message || 'Falha no login';
            submit.disabled = false;
            submit.textContent = 'Entrar';
        }
    });
    document.body.appendChild(overlay);
}
