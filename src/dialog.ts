export function openConfirmDialog(opts: {
  title: string
  body: string
  confirmLabel: string
  danger?: boolean
  onConfirm: () => Promise<void> | void
  onCancel?: () => void
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
  const close = (cancelled = false) => {
    overlay.remove()
    if (cancelled) opts.onCancel?.()
  }
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close(true)
  })
  overlay.querySelector('.modal-cancel')!.addEventListener('click', () => close(true))
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
      close(true)
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

/** Modal informativo — só botão OK. */
export function openAlertDialog(opts: {
  title: string
  body: string
  confirmLabel?: string
}): void {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const bodyHtml = opts.body
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>')
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-title">${opts.title}</div>
      <div class="modal-body">${bodyHtml}</div>
      <div class="modal-actions">
        <button type="button" class="btn btn-primary modal-confirm">${opts.confirmLabel ?? 'OK'}</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)
  const close = () => overlay.remove()
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  const confirmBtn = overlay.querySelector<HTMLButtonElement>('.modal-confirm')!
  confirmBtn.addEventListener('click', close)
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' || event.key === 'Enter') {
      close()
      document.removeEventListener('keydown', onKey)
    }
  }
  document.addEventListener('keydown', onKey)
  confirmBtn.focus()
}

function parseDDMMYYYY(raw: string): Date | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(raw)
  if (!m) return null
  return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]))
}

function formatDDMMYYYY(d: Date): string {
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const yyyy = d.getFullYear()
  return `${dd}-${mm}-${yyyy}`
}

const CALENDAR_WEEKDAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']
const CALENDAR_MONTH_FMT = new Intl.DateTimeFormat('pt-BR', { month: 'long', year: 'numeric' })

/**
 * Calendário mensal — só dias com pelo menos 1 pedido (availableDates) são clicáveis;
 * os demais aparecem esmaecidos. Usado pelo seletor "Personalizado" da planilha Shopee.
 */
export function openCalendarPickerDialog(opts: {
  title: string
  /** Datas no formato DD-MM-YYYY que podem ser selecionadas. */
  availableDates: string[]
  /** Mês inicial e dia destacado, se houver. */
  initialDate?: string | null
  onSelect: (date: string) => void
}): void {
  const available = new Set(opts.availableDates)
  const parsedAvailable = opts.availableDates
    .map(parseDDMMYYYY)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())

  const initial =
    (opts.initialDate ? parseDDMMYYYY(opts.initialDate) : null) ??
    parsedAvailable[parsedAvailable.length - 1] ??
    new Date()

  let viewYear = initial.getFullYear()
  let viewMonth = initial.getMonth()

  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const modal = document.createElement('div')
  modal.className = 'modal modal-calendar'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')

  const title = document.createElement('div')
  title.className = 'modal-title'
  title.textContent = opts.title
  modal.appendChild(title)

  const body = document.createElement('div')
  body.className = 'modal-body calendar-body'
  modal.appendChild(body)

  const actions = document.createElement('div')
  actions.className = 'modal-actions'
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'btn modal-cancel'
  closeBtn.textContent = 'Fechar'
  actions.appendChild(closeBtn)
  modal.appendChild(actions)

  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  closeBtn.addEventListener('click', close)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close()
      document.removeEventListener('keydown', onKey)
    }
  }
  document.addEventListener('keydown', onKey)

  function renderMonth() {
    body.innerHTML = ''

    const header = document.createElement('div')
    header.className = 'calendar-header'
    const prevBtn = document.createElement('button')
    prevBtn.type = 'button'
    prevBtn.className = 'calendar-nav-btn'
    prevBtn.textContent = '‹'
    prevBtn.setAttribute('aria-label', 'Mês anterior')
    const label = document.createElement('span')
    label.className = 'calendar-month-label'
    const labelText = CALENDAR_MONTH_FMT.format(new Date(viewYear, viewMonth, 1))
    label.textContent = labelText.charAt(0).toUpperCase() + labelText.slice(1)
    const nextBtn = document.createElement('button')
    nextBtn.type = 'button'
    nextBtn.className = 'calendar-nav-btn'
    nextBtn.textContent = '›'
    nextBtn.setAttribute('aria-label', 'Próximo mês')
    header.append(prevBtn, label, nextBtn)
    body.appendChild(header)

    const grid = document.createElement('div')
    grid.className = 'calendar-grid'
    for (const wd of CALENDAR_WEEKDAYS) {
      const cell = document.createElement('div')
      cell.className = 'calendar-weekday'
      cell.textContent = wd
      grid.appendChild(cell)
    }

    const firstOfMonth = new Date(viewYear, viewMonth, 1)
    const startWeekday = firstOfMonth.getDay()
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate()

    for (let i = 0; i < startWeekday; i++) {
      const blank = document.createElement('div')
      blank.className = 'calendar-day calendar-day-empty'
      grid.appendChild(blank)
    }

    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = formatDDMMYYYY(new Date(viewYear, viewMonth, day))
      const cell = document.createElement('button')
      cell.type = 'button'
      cell.textContent = String(day)
      if (available.has(dateStr)) {
        cell.className = 'calendar-day is-available' + (dateStr === opts.initialDate ? ' is-selected' : '')
        cell.addEventListener('click', () => {
          opts.onSelect(dateStr)
          close()
        })
      } else {
        cell.className = 'calendar-day is-disabled'
        cell.disabled = true
      }
      grid.appendChild(cell)
    }
    body.appendChild(grid)

    if (available.size === 0) {
      const empty = document.createElement('div')
      empty.className = 'calendar-empty-msg'
      empty.textContent = 'Nenhuma data com pedidos disponível.'
      body.appendChild(empty)
    }

    prevBtn.addEventListener('click', () => {
      viewMonth -= 1
      if (viewMonth < 0) {
        viewMonth = 11
        viewYear -= 1
      }
      renderMonth()
    })
    nextBtn.addEventListener('click', () => {
      viewMonth += 1
      if (viewMonth > 11) {
        viewMonth = 0
        viewYear += 1
      }
      renderMonth()
    })
  }

  renderMonth()
  closeBtn.focus()
}

export function openPreviewPickerDialog(opts: {
  title: string
  items: Array<{ col: number; label: string; imageUrl: string }>
  onSend: (col: number) => Promise<void>
}): void {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  const modal = document.createElement('div')
  modal.className = 'modal modal-preview-picker'
  modal.setAttribute('role', 'dialog')
  modal.setAttribute('aria-modal', 'true')

  const title = document.createElement('div')
  title.className = 'modal-title'
  title.textContent = opts.title
  modal.appendChild(title)

  const body = document.createElement('div')
  body.className = 'modal-body preview-picker-grid'
  for (const item of opts.items) {
    const card = document.createElement('div')
    card.className = 'preview-picker-card'

    const img = document.createElement('img')
    img.className = 'preview-picker-img'
    img.src = item.imageUrl
    img.alt = item.label
    card.appendChild(img)

    const label = document.createElement('div')
    label.className = 'preview-picker-label'
    label.textContent = item.label
    card.appendChild(label)

    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn btn-primary preview-picker-send'
    btn.textContent = 'Enviar prévia'
    btn.addEventListener('click', async () => {
      btn.disabled = true
      btn.textContent = 'Enviando...'
      try {
        await opts.onSend(item.col)
        close()
      } catch {
        btn.disabled = false
        btn.textContent = 'Enviar prévia'
      }
    })
    card.appendChild(btn)
    body.appendChild(card)
  }
  modal.appendChild(body)

  const actions = document.createElement('div')
  actions.className = 'modal-actions'
  const cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'
  cancelBtn.className = 'btn modal-cancel'
  cancelBtn.textContent = 'Fechar'
  actions.appendChild(cancelBtn)
  modal.appendChild(actions)

  overlay.appendChild(modal)
  document.body.appendChild(overlay)

  const close = () => overlay.remove()
  cancelBtn.addEventListener('click', close)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close()
  })
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      close()
      document.removeEventListener('keydown', onKey)
    }
  }
  document.addEventListener('keydown', onKey)
  cancelBtn.focus()
}
