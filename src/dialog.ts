export function openConfirmDialog(opts: {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<void> | void
}): void {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">${opts.title}</div>
      <div class="modal-body">${opts.body}</div>
      <div class="modal-actions">
        <button type="button" class="btn modal-cancel">Cancelar</button>
        <button type="button" class="btn ${opts.danger ? 'btn-danger' : 'btn-primary'} modal-confirm">${opts.confirmLabel}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  overlay.querySelector('.modal-cancel')!.addEventListener('click', close)
  const confirmBtn = overlay.querySelector<HTMLButtonElement>('.modal-confirm')!
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true
    try {
      await opts.onConfirm()
    } finally {
      close()
    }
  })
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close()
      document.removeEventListener('keydown', onKey)
    }
  }
  document.addEventListener('keydown', onKey)
  confirmBtn.focus()
}

export function openPromptDialog(opts: {
  title: string
  label: string
  defaultValue?: string
  confirmLabel: string
  onConfirm: (value: string) => Promise<void> | void
}): void {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">${opts.title}</div>
      <div class="modal-body">
        <label class="modal-prompt-label">
          <span>${opts.label}</span>
          <input type="text" class="modal-prompt-input" />
        </label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn modal-cancel">Cancelar</button>
        <button type="button" class="btn btn-primary modal-confirm">${opts.confirmLabel}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  const input = overlay.querySelector<HTMLInputElement>('.modal-prompt-input')!
  input.value = opts.defaultValue ?? ''
  const close = () => overlay.remove()
  const confirmBtn = overlay.querySelector<HTMLButtonElement>('.modal-confirm')!
  const submit = async () => {
    const value = input.value.trim()
    if (!value) {
      input.focus()
      return
    }
    confirmBtn.disabled = true
    try {
      await opts.onConfirm(value)
    } finally {
      close()
    }
  }
  overlay.querySelector('.modal-cancel')!.addEventListener('click', close)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  confirmBtn.addEventListener('click', () => void submit())
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  })
  input.focus()
  input.select()
}

export function openTextareaDialog(opts: {
  title: string
  label: string
  defaultValue?: string
  confirmLabel: string
  onConfirm: (value: string) => Promise<void> | void
}): void {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">${opts.title}</div>
      <div class="modal-body">
        <label class="modal-prompt-label">
          <span>${opts.label}</span>
          <textarea class="modal-prompt-input modal-textarea" rows="5"></textarea>
        </label>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn modal-cancel">Cancelar</button>
        <button type="button" class="btn btn-primary modal-confirm">${opts.confirmLabel}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  const textarea = overlay.querySelector<HTMLTextAreaElement>('.modal-textarea')!
  textarea.value = opts.defaultValue ?? ''
  const close = () => overlay.remove()
  const confirmBtn = overlay.querySelector<HTMLButtonElement>('.modal-confirm')!
  const submit = async () => {
    confirmBtn.disabled = true
    try {
      await opts.onConfirm(textarea.value.trim())
    } finally {
      close()
    }
  }
  overlay.querySelector('.modal-cancel')!.addEventListener('click', close)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  confirmBtn.addEventListener('click', () => void submit())
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void submit()
    }
  })
  textarea.focus()
  textarea.select()
}
