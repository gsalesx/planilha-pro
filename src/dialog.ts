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
  /** `orderKey` é opcional — quando ausente, todos os itens são da MESMA linha (fluxo
   *  antigo: 1 pedido, N colunas de foto). Quando presente, cada item pode ser de uma
   *  linha diferente (pedido pai+filha, cada peça com sua própria prévia). */
  items: Array<{ col: number; label: string; imageUrl: string; orderKey?: string }>
  onSend: (item: { col: number; orderKey?: string }) => Promise<void>
  /**
   * Botão "Marcar como prévia" (rodapé) — separa "mandei a foto no chat" de "o pedido
   * virou Prévia": pedido do user pra pedido de N peças, mandar 1 já fechava o modal
   * (não dava pra mandar as outras) e o status virava Prévia sozinho no 1º envio, sem
   * o operador ter decidido que terminou. Agora cada "Enviar prévia" só marca aquele
   * card como enviado e o modal CONTINUA aberto — o status só muda quando o operador
   * clica aqui, depois de mandar quantas quiser. Omitido = comportamento antigo (1
   * envio já fecha o modal), usado pelo fluxo simples do grid (1 linha, N colunas).
   */
  onMarkAsPreview?: () => Promise<void>
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
  let algumEnviado = false
  const atualizarBotaoMarcar = () => {
    if (marcarBtn) marcarBtn.disabled = !algumEnviado
  }

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
        await opts.onSend({ col: item.col, orderKey: item.orderKey })
        if (opts.onMarkAsPreview) {
          // Fluxo novo: fica marcado como enviado, modal continua aberto pro
          // operador mandar as outras peças antes de fechar o ciclo.
          btn.textContent = '✓ Enviada'
          btn.classList.remove('btn-primary')
          algumEnviado = true
          atualizarBotaoMarcar()
        } else {
          close()
        }
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
  let marcarBtn: HTMLButtonElement | null = null
  if (opts.onMarkAsPreview) {
    marcarBtn = document.createElement('button')
    marcarBtn.type = 'button'
    marcarBtn.className = 'btn btn-primary'
    marcarBtn.textContent = 'Marcar como prévia'
    marcarBtn.disabled = true
    marcarBtn.title = 'Envie ao menos 1 prévia antes de marcar o pedido'
    marcarBtn.addEventListener('click', async () => {
      marcarBtn!.disabled = true
      marcarBtn!.textContent = 'Marcando...'
      try {
        await opts.onMarkAsPreview!()
        close()
      } catch (error) {
        marcarBtn!.disabled = false
        marcarBtn!.textContent = 'Marcar como prévia'
        alert(`Falha ao marcar: ${(error as Error).message}`)
      }
    })
    actions.appendChild(marcarBtn)
  }
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

export type BaixarAprovadosAction =
  | { kind: 'download' }
  | { kind: 'download-and-mark'; status: 'Em produção 1' | 'Em produção 2' | 'Em produção 3' }

/** Escolha ao baixar aprovados da data: só baixar, ou baixar e marcar Em produção 1/2/3. */
export function openBaixarAprovadosDialog(opts: {
  sheetDate: string
  onChoose: (action: BaixarAprovadosAction) => Promise<void> | void
}): void {
  const overlay = document.createElement('div')
  overlay.className = 'modal-overlay'
  overlay.innerHTML = `
    <div class="modal modal-baixar-aprovados" role="dialog" aria-modal="true" aria-labelledby="baixar-aprovados-title">
      <div class="modal-title" id="baixar-aprovados-title">Baixar aprovados — ${opts.sheetDate}</div>
      <div class="modal-body">
        <button type="button" class="btn btn-primary baixar-aprovados-so-baixar">Baixar sem alterar status</button>
        <div class="baixar-aprovados-mark-label">Baixar e marcar como:</div>
        <div class="baixar-aprovados-mark-row" role="group" aria-label="Baixar e marcar em produção">
          <button type="button" class="btn baixar-aprovados-mark" data-status="Em produção 1" style="background:#1e3a8a;color:#fff;border-color:#1e3a8a">Em produção 1</button>
          <button type="button" class="btn baixar-aprovados-mark" data-status="Em produção 2" style="background:#fb923c;color:#0f172a;border-color:#fb923c">Em produção 2</button>
          <button type="button" class="btn baixar-aprovados-mark" data-status="Em produção 3" style="background:#7e22ce;color:#fff;border-color:#7e22ce">Em produção 3</button>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="btn modal-cancel">Cancelar</button>
      </div>
    </div>
  `
  document.body.appendChild(overlay)

  let busy = false
  function close() {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
  }
  function onKey(event: KeyboardEvent) {
    if (event.key === 'Escape' && !busy) close()
  }
  const run = async (action: BaixarAprovadosAction) => {
    if (busy) return
    busy = true
    close()
    await opts.onChoose(action)
  }

  overlay.querySelector('.modal-cancel')!.addEventListener('click', close)
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay && !busy) close()
  })
  overlay.querySelector('.baixar-aprovados-so-baixar')!.addEventListener('click', () => {
    void run({ kind: 'download' })
  })
  overlay.querySelectorAll<HTMLButtonElement>('.baixar-aprovados-mark').forEach((btn) => {
    btn.addEventListener('click', () => {
      const status = btn.dataset.status as 'Em produção 1' | 'Em produção 2' | 'Em produção 3'
      void run({ kind: 'download-and-mark', status })
    })
  })
  document.addEventListener('keydown', onKey)
  overlay.querySelector<HTMLButtonElement>('.baixar-aprovados-so-baixar')!.focus()
}
