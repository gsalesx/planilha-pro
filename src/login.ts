import { login } from './api'

export function showLoginScreen(onSuccess: () => void): void {
  const overlay = document.createElement('div')
  overlay.className = 'login-overlay'
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
  `

  const form = overlay.querySelector<HTMLFormElement>('form')!
  const errBox = overlay.querySelector<HTMLDivElement>('#login-error')!
  const submit = overlay.querySelector<HTMLButtonElement>('#login-submit')!

  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    const username = (overlay.querySelector<HTMLInputElement>('#login-username')!).value.trim()
    const password = (overlay.querySelector<HTMLInputElement>('#login-password')!).value
    errBox.hidden = true
    submit.disabled = true
    submit.textContent = 'Entrando...'
    try {
      await login(username, password)
      overlay.remove()
      onSuccess()
    } catch (error) {
      errBox.hidden = false
      errBox.textContent = (error as Error).message || 'Falha no login'
      submit.disabled = false
      submit.textContent = 'Entrar'
    }
  })

  document.body.appendChild(overlay)
}
