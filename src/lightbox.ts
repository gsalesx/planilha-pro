/** Visualizador de imagem em tela cheia com zoom/pan — extraído de grid.ts (preview de
 * fotos da planilha) pra ser reaproveitado em qualquer lugar (ex. foto do produto no
 * card do chat Shopee). */
export function openImageLightbox(url: string, fileName: string): void {
  const overlay = document.createElement('div')
  overlay.className = 'lightbox-overlay'

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'lightbox-close'
  closeBtn.textContent = '×'

  const zoomBadge = document.createElement('span')
  zoomBadge.className = 'lightbox-zoom'
  zoomBadge.textContent = '100%'

  const hint = document.createElement('span')
  hint.className = 'lightbox-hint'
  hint.textContent = 'scroll: zoom · arraste: mover · duplo clique: reset · esc: fechar'

  const figure = document.createElement('figure')
  figure.className = 'lightbox-figure'

  const imgWrap = document.createElement('div')
  imgWrap.className = 'lightbox-img-wrap'

  const img = document.createElement('img')
  img.src = url
  img.alt = fileName
  img.draggable = false
  imgWrap.appendChild(img)

  const caption = document.createElement('figcaption')
  caption.textContent = fileName

  figure.appendChild(imgWrap)
  figure.appendChild(caption)

  overlay.appendChild(closeBtn)
  overlay.appendChild(zoomBadge)
  overlay.appendChild(hint)
  overlay.appendChild(figure)

  const MIN_SCALE = 0.4
  const MAX_SCALE = 2
  let scale = MAX_SCALE
  let tx = 0
  let ty = 0
  let dragging = false
  let lastX = 0
  let lastY = 0

  const clampPan = () => {
    // Mantem a imagem dentro do wrap: |tx|<=overflowX/2 e |ty|<=overflowY/2.
    // Antes do load, clientWidth=0 → pula clamp (sem efeito).
    const baseW = img.clientWidth
    const baseH = img.clientHeight
    const wrapW = imgWrap.clientWidth
    const wrapH = imgWrap.clientHeight
    if (baseW === 0 || baseH === 0) return
    const overflowX = Math.max(0, (scale * baseW - wrapW) / 2)
    const overflowY = Math.max(0, (scale * baseH - wrapH) / 2)
    tx = Math.max(-overflowX, Math.min(overflowX, tx))
    ty = Math.max(-overflowY, Math.min(overflowY, ty))
  }

  const applyTransform = () => {
    clampPan()
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
    zoomBadge.textContent = `${Math.round(scale * 100)}%`
    imgWrap.style.cursor = scale > 1.001 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in'
  }

  const zoomAtPoint = (clientX: number, clientY: number, factor: number) => {
    const rect = img.getBoundingClientRect()
    const cx = clientX - (rect.left + rect.width / 2)
    const cy = clientY - (rect.top + rect.height / 2)
    const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale * factor))
    if (next === scale) return
    const ratio = next / scale
    tx = cx - (cx - tx) * ratio
    ty = cy - (cy - ty) * ratio
    scale = next
    if (scale <= 1.001) {
      scale = 1
      tx = 0
      ty = 0
    }
    applyTransform()
  }

  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    const factor = event.deltaY < 0 ? 1.18 : 1 / 1.18
    zoomAtPoint(event.clientX, event.clientY, factor)
  }

  const onMouseDown = (event: MouseEvent) => {
    if (scale <= 1.001) return
    event.preventDefault()
    dragging = true
    lastX = event.clientX
    lastY = event.clientY
    imgWrap.style.cursor = 'grabbing'
  }
  const onMouseMove = (event: MouseEvent) => {
    if (!dragging) return
    tx += event.clientX - lastX
    ty += event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY
    applyTransform()
  }
  const onMouseUp = () => {
    if (!dragging) return
    dragging = false
    applyTransform()
  }

  const onDblClick = (event: MouseEvent) => {
    event.preventDefault()
    if (scale > 1.01) {
      scale = 1
      tx = 0
      ty = 0
      applyTransform()
    } else {
      zoomAtPoint(event.clientX, event.clientY, 2.4)
    }
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape') close()
    else if (event.key === '0') {
      scale = 1
      tx = 0
      ty = 0
      applyTransform()
    } else if (event.key === '+' || event.key === '=') {
      const rect = imgWrap.getBoundingClientRect()
      zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, 1.25)
    } else if (event.key === '-' || event.key === '_') {
      const rect = imgWrap.getBoundingClientRect()
      zoomAtPoint(rect.left + rect.width / 2, rect.top + rect.height / 2, 1 / 1.25)
    }
  }

  const close = () => {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }

  overlay.addEventListener('click', (event) => {
    if (event.target !== img) close()
  })
  imgWrap.addEventListener('wheel', onWheel, { passive: false })
  imgWrap.addEventListener('mousedown', onMouseDown)
  imgWrap.addEventListener('dblclick', onDblClick)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
  document.addEventListener('keydown', onKey)

  document.body.appendChild(overlay)
  applyTransform()
}
