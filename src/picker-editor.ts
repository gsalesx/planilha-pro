/**
 * Editor de foto do picker web — substitui o `EditorWin` (Tkinter) do
 * `picker_coracao.py`.
 *
 * O preview é desenhado no PRÓPRIO navegador (canvas) pra arrastar/zoom/girar
 * ficarem instantâneos; o servidor só é chamado ao salvar, quando compõe a
 * versão definitiva com o mesmo código do render final. A geometria aqui
 * espelha `render-foto.ts`: rotaciona → escala pra `width` → posiciona a
 * partir do centro com dx/dy.
 */
const CANVAS = 900

export type ModoFoto = 'coracao' | 'recorte'

export interface AjusteFoto {
  width?: number
  dx?: number
  dy?: number
  rotation?: number
}

interface EstadoServidor {
  modo: ModoFoto
  ajuste: AjusteFoto
  uWidth: number
  temSemFundo: boolean
  temComposta: boolean
}

export interface PickerEditorOpts {
  pieceId: number
  slot: 1 | 2
  /** Rótulo mostrado no topo (ex. "G MASCULINO — Foto 1"). */
  titulo?: string
  /** Posição na fila do "Ajustar todas" — só pra mostrar "3 de 8". */
  fila?: { indice: number; total: number }
  /** Chamado após salvar, pra a tela de trás atualizar a miniatura. */
  onSalvo?: () => void
}

/** Item da fila do "Ajustar todas". */
export interface ItemFila {
  pieceId: number
  slot: 1 | 2
  titulo: string
}

/**
 * Percorre várias fotos em sequência — equivalente ao picker local, que passa
 * de slot em slot. Salvar avança pra próxima; fechar (Esc/×) interrompe a fila.
 */
export async function abrirPickerFila(
  itens: ItemFila[],
  onSalvo?: () => void,
): Promise<void> {
  for (let i = 0; i < itens.length; i++) {
    const item = itens[i]
    const r = await abrirPickerEditor({
      ...item,
      fila: { indice: i + 1, total: itens.length },
      onSalvo,
    })
    if (r === 'cancelado') return // operador fechou: não segue a fila
  }
}

/** Tamanho da foto rotacionada-expandida — precisa bater com o `expand` do PIL. */
function tamanhoRotacionado(w: number, h: number, graus: number): { w: number; h: number } {
  const r = (graus * Math.PI) / 180
  const c = Math.abs(Math.cos(r))
  const s = Math.abs(Math.sin(r))
  return { w: w * c + h * s, h: w * s + h * c }
}

function carregarImagem(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`falha ao carregar ${url}`))
    img.src = url
  })
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: 'include', ...init })
  const txt = await r.text()
  const body = txt ? (JSON.parse(txt) as T & { error?: string }) : ({} as T)
  if (!r.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`)
  return body
}

/** Resolve quando o editor fecha: 'salvo' segue a fila, 'cancelado' interrompe. */
export async function abrirPickerEditor(
  opts: PickerEditorOpts,
): Promise<'salvo' | 'cancelado'> {
  const { pieceId, slot } = opts
  const base = `/api/pieces/${pieceId}/photo/${slot}`

  const estado = await api<EstadoServidor>(`${base}/ajuste`)
  let modo: ModoFoto = estado.modo
  let uWidth = estado.uWidth || 600
  const ajuste: Required<AjusteFoto> = {
    width: estado.ajuste.width ?? 0,
    dx: estado.ajuste.dx ?? 0,
    dy: estado.ajuste.dy ?? 0,
    rotation: estado.ajuste.rotation ?? 0,
  }

  const overlay = document.createElement('div')
  overlay.className = 'picker-editor-backdrop'
  overlay.innerHTML = `
    <section class="picker-editor" role="dialog" aria-label="Ajustar foto">
      <header class="picker-editor-header">
        <h2>${opts.titulo ? escapeHtml(opts.titulo) : `Foto ${slot}`}</h2>
        ${
          opts.fila
            ? `<span class="picker-editor-fila">${opts.fila.indice} de ${opts.fila.total}</span>`
            : ''
        }
        <button type="button" class="picker-editor-close" aria-label="Fechar">×</button>
      </header>

      <div class="picker-editor-body">
        <div class="picker-editor-palco">
          <canvas class="picker-editor-canvas" width="${CANVAS}" height="${CANVAS}"></canvas>
          <div class="picker-editor-dica">arraste: mover · roda: zoom · shift+roda: girar</div>
        </div>

        <aside class="picker-editor-controles">
          <div class="picker-editor-grupo">
            <span class="picker-editor-label">Formato</span>
            <div class="picker-editor-modos">
              <button type="button" data-modo="coracao">Coração</button>
              <button type="button" data-modo="recorte">Recorte</button>
            </div>
          </div>

          <div class="picker-editor-grupo" data-so-recorte>
            <span class="picker-editor-label">Largura do recorte <b class="v-uwidth"></b></span>
            <input type="range" class="in-uwidth" min="200" max="1000" step="10" />
            <button type="button" class="btn in-removebg">Remover fundo</button>
          </div>

          <div class="picker-editor-grupo">
            <span class="picker-editor-label">Zoom <b class="v-zoom"></b></span>
            <input type="range" class="in-zoom" min="20" max="400" step="1" />
          </div>

          <div class="picker-editor-grupo">
            <span class="picker-editor-label">Girar <b class="v-rot"></b></span>
            <div class="picker-editor-rot">
              <button type="button" data-rot="-90">-90°</button>
              <button type="button" data-rot="-1">-1°</button>
              <button type="button" data-rot="1">+1°</button>
              <button type="button" data-rot="90">+90°</button>
            </div>
          </div>

          <div class="picker-editor-grupo" data-so-recorte>
            <span class="picker-editor-label">Borracha</span>
            <div class="picker-editor-borracha">
              <button type="button" class="in-borracha">Ativar</button>
              <input type="range" class="in-brush" min="10" max="200" step="5" value="60" />
            </div>
          </div>

          <div class="picker-editor-acoes">
            <button type="button" class="btn in-reset">Resetar</button>
            <button type="button" class="btn btn-primary in-salvar">Salvar</button>
          </div>
          <div class="picker-editor-status"></div>
        </aside>
      </div>
    </section>
  `
  document.body.appendChild(overlay)

  const q = <T extends HTMLElement>(sel: string): T => overlay.querySelector<T>(sel)!
  const canvas = q<HTMLCanvasElement>('.picker-editor-canvas')
  const ctx = canvas.getContext('2d')!
  const status = q('.picker-editor-status')
  const inZoom = q<HTMLInputElement>('.in-zoom')
  const inUWidth = q<HTMLInputElement>('.in-uwidth')
  const inBrush = q<HTMLInputElement>('.in-brush')

  const setStatus = (msg: string, erro = false) => {
    status.textContent = msg
    status.classList.toggle('erro', erro)
  }

  /* ---------------- carregamento das imagens ---------------- */
  let fonte: HTMLImageElement | null = null
  const heart = await carregarImagem('/api/picker/mask/heart')

  /** Camada onde a borracha pinta (mesma resolução da foto sem fundo). */
  let apagador: HTMLCanvasElement | null = null
  let borrachaAtiva = false

  async function carregarFonte(): Promise<void> {
    const url = modo === 'recorte' ? `${base}/sem-fundo` : `${base}?t=${Date.now()}`
    try {
      fonte = await carregarImagem(url)
      // Sem `width` salvo: começa com a foto cobrindo o canvas inteiro.
      if (!ajuste.width) {
        const r = tamanhoRotacionado(fonte.naturalWidth, fonte.naturalHeight, ajuste.rotation)
        ajuste.width = Math.round((CANVAS / Math.min(r.w, r.h)) * r.w)
      }
      apagador = null
      desenhar()
    } catch {
      fonte = null
      if (modo === 'recorte') {
        setStatus('Clique em "Remover fundo" para começar o recorte.', true)
      } else {
        setStatus('Não consegui carregar a foto.', true)
      }
      desenhar()
    }
  }

  /* ---------------- desenho do preview ---------------- */
  function desenhar(): void {
    ctx.clearRect(0, 0, CANVAS, CANVAS)
    if (fonte) {
      const rot = tamanhoRotacionado(fonte.naturalWidth, fonte.naturalHeight, ajuste.rotation)
      const escala = (ajuste.width || rot.w) / rot.w
      const dw = fonte.naturalWidth * escala
      const dh = fonte.naturalHeight * escala

      ctx.save()
      ctx.translate(CANVAS / 2 + ajuste.dx, CANVAS / 2 + ajuste.dy)
      ctx.rotate((ajuste.rotation * Math.PI) / 180)
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(fonte, -dw / 2, -dh / 2, dw, dh)
      if (apagador) ctx.drawImage(apagador, -dw / 2, -dh / 2, dw, dh)
      ctx.restore()
    }

    // Recorta na máscara do formato escolhido.
    ctx.globalCompositeOperation = 'destination-in'
    if (modo === 'coracao') {
      ctx.drawImage(heart, 0, 0, CANVAS, CANVAS)
    } else {
      desenharCapsula(ctx, uWidth)
    }
    ctx.globalCompositeOperation = 'source-over'

    // Contorno de guia, pra enxergar o limite mesmo sem foto.
    ctx.save()
    ctx.strokeStyle = 'rgba(148,163,184,.9)'
    ctx.setLineDash([12, 10])
    ctx.lineWidth = 3
    if (modo === 'recorte') {
      caminhoCapsula(ctx, uWidth)
      ctx.stroke()
    }
    ctx.restore()
  }

  /** Cápsula do recorte: extensão vertical fixa (36–864), largura variável. */
  function caminhoCapsula(c: CanvasRenderingContext2D, largura: number): void {
    const w = Math.max(120, Math.min(1000, largura))
    const x = (CANVAS - w) / 2
    const r = w / 2
    c.beginPath()
    // roundRect é suportado nos navegadores atuais; o fallback cobre os antigos.
    if (typeof c.roundRect === 'function') c.roundRect(x, 36, w, 864 - 36, r)
    else c.rect(x, 36, w, 864 - 36)
    c.closePath()
  }

  function desenharCapsula(c: CanvasRenderingContext2D, largura: number): void {
    c.save()
    c.fillStyle = '#fff'
    caminhoCapsula(c, largura)
    c.fill()
    c.restore()
  }

  /* ---------------- interação no palco ---------------- */
  function paraCanvas(ev: MouseEvent): { x: number; y: number } {
    const r = canvas.getBoundingClientRect()
    return {
      x: ((ev.clientX - r.left) / r.width) * CANVAS,
      y: ((ev.clientY - r.top) / r.height) * CANVAS,
    }
  }

  /** Converte um ponto do canvas pro sistema da foto (pra apagar no lugar certo). */
  function paraFoto(p: { x: number; y: number }): { x: number; y: number } | null {
    if (!fonte) return null
    const rot = tamanhoRotacionado(fonte.naturalWidth, fonte.naturalHeight, ajuste.rotation)
    const escala = (ajuste.width || rot.w) / rot.w
    const rad = (-ajuste.rotation * Math.PI) / 180
    const ox = p.x - (CANVAS / 2 + ajuste.dx)
    const oy = p.y - (CANVAS / 2 + ajuste.dy)
    const rx = ox * Math.cos(rad) - oy * Math.sin(rad)
    const ry = ox * Math.sin(rad) + oy * Math.cos(rad)
    return { x: rx / escala + fonte.naturalWidth / 2, y: ry / escala + fonte.naturalHeight / 2 }
  }

  function apagarEm(p: { x: number; y: number }): void {
    if (!fonte) return
    if (!apagador) {
      apagador = document.createElement('canvas')
      apagador.width = fonte.naturalWidth
      apagador.height = fonte.naturalHeight
    }
    const alvo = paraFoto(p)
    if (!alvo) return
    const c = apagador.getContext('2d')!
    // Pinta opaco no apagador e usa 'destination-out' na hora de aplicar —
    // aqui basta marcar; a subtração real acontece no `aplicarBorracha`.
    c.globalCompositeOperation = 'source-over'
    c.fillStyle = 'rgba(255,0,0,1)'
    c.beginPath()
    const rot = tamanhoRotacionado(fonte.naturalWidth, fonte.naturalHeight, ajuste.rotation)
    const escala = (ajuste.width || rot.w) / rot.w
    c.arc(alvo.x, alvo.y, Number(inBrush.value) / 2 / escala, 0, Math.PI * 2)
    c.fill()
    desenhar()
  }

  let arrastando = false
  let ultimo = { x: 0, y: 0 }

  canvas.addEventListener('mousedown', (ev) => {
    const p = paraCanvas(ev)
    if (borrachaAtiva) {
      apagarEm(p)
      arrastando = true
      ultimo = p
      return
    }
    arrastando = true
    ultimo = p
    canvas.style.cursor = 'grabbing'
  })
  window.addEventListener('mousemove', (ev) => {
    if (!arrastando) return
    const p = paraCanvas(ev)
    if (borrachaAtiva) {
      apagarEm(p)
    } else {
      ajuste.dx += p.x - ultimo.x
      ajuste.dy += p.y - ultimo.y
      desenhar()
    }
    ultimo = p
  })
  window.addEventListener('mouseup', () => {
    arrastando = false
    canvas.style.cursor = borrachaAtiva ? 'crosshair' : 'grab'
  })

  canvas.addEventListener(
    'wheel',
    (ev) => {
      ev.preventDefault()
      if (ev.shiftKey) {
        ajuste.rotation += ev.deltaY < 0 ? 1 : -1
      } else if (fonte) {
        const fator = ev.deltaY < 0 ? 1.05 : 1 / 1.05
        ajuste.width = Math.max(50, Math.round((ajuste.width || CANVAS) * fator))
      }
      sincronizarControles()
      desenhar()
    },
    { passive: false },
  )

  /* ---------------- controles ---------------- */
  function sincronizarControles(): void {
    if (fonte) {
      const rot = tamanhoRotacionado(fonte.naturalWidth, fonte.naturalHeight, ajuste.rotation)
      const pct = Math.round(((ajuste.width || rot.w) / rot.w) * 100)
      inZoom.value = String(Math.max(20, Math.min(400, pct)))
      q('.v-zoom').textContent = `${pct}%`
    }
    q('.v-rot').textContent = `${ajuste.rotation.toFixed(0)}°`
    inUWidth.value = String(uWidth)
    q('.v-uwidth').textContent = String(uWidth)
    overlay.querySelectorAll<HTMLElement>('[data-so-recorte]').forEach((el) => {
      el.style.display = modo === 'recorte' ? '' : 'none'
    })
    overlay.querySelectorAll<HTMLButtonElement>('[data-modo]').forEach((b) => {
      b.classList.toggle('ativo', b.dataset.modo === modo)
    })
  }

  overlay.querySelectorAll<HTMLButtonElement>('[data-modo]').forEach((b) => {
    b.addEventListener('click', () => {
      const novo = b.dataset.modo as ModoFoto
      if (novo === modo) return
      modo = novo
      setStatus('')
      sincronizarControles()
      void carregarFonte()
    })
  })

  overlay.querySelectorAll<HTMLButtonElement>('[data-rot]').forEach((b) => {
    b.addEventListener('click', () => {
      ajuste.rotation += Number(b.dataset.rot)
      sincronizarControles()
      desenhar()
    })
  })

  inZoom.addEventListener('input', () => {
    if (!fonte) return
    const rot = tamanhoRotacionado(fonte.naturalWidth, fonte.naturalHeight, ajuste.rotation)
    ajuste.width = Math.round((Number(inZoom.value) / 100) * rot.w)
    sincronizarControles()
    desenhar()
  })

  inUWidth.addEventListener('input', () => {
    uWidth = Number(inUWidth.value)
    sincronizarControles()
    desenhar()
  })

  q<HTMLButtonElement>('.in-borracha').addEventListener('click', (ev) => {
    borrachaAtiva = !borrachaAtiva
    ;(ev.currentTarget as HTMLButtonElement).classList.toggle('ativo', borrachaAtiva)
    canvas.style.cursor = borrachaAtiva ? 'crosshair' : 'grab'
  })

  q<HTMLButtonElement>('.in-removebg').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement
    btn.disabled = true
    setStatus('Removendo fundo…')
    try {
      await api(`${base}/remove-bg`, { method: 'POST' })
      setStatus('Fundo removido.')
      await carregarFonte()
    } catch (e) {
      setStatus((e as Error).message, true)
    } finally {
      btn.disabled = false
    }
  })

  q<HTMLButtonElement>('.in-reset').addEventListener('click', () => {
    ajuste.dx = 0
    ajuste.dy = 0
    ajuste.rotation = 0
    ajuste.width = 0
    apagador = null
    void carregarFonte()
    sincronizarControles()
  })

  /** Aplica a borracha de verdade na foto sem fundo e sobe pro servidor. */
  async function aplicarBorracha(): Promise<void> {
    if (!apagador || !fonte) return
    const out = document.createElement('canvas')
    out.width = fonte.naturalWidth
    out.height = fonte.naturalHeight
    const c = out.getContext('2d')!
    c.drawImage(fonte, 0, 0)
    c.globalCompositeOperation = 'destination-out'
    c.drawImage(apagador, 0, 0)
    const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'))
    if (!blob) return
    const fd = new FormData()
    fd.append('image', blob, 'sem-fundo.png')
    await fetch(`${base}/sem-fundo`, { method: 'PUT', credentials: 'include', body: fd })
    apagador = null
  }

  q<HTMLButtonElement>('.in-salvar').addEventListener('click', async (ev) => {
    const btn = ev.currentTarget as HTMLButtonElement
    btn.disabled = true
    setStatus('Salvando…')
    try {
      if (modo === 'recorte' && apagador) await aplicarBorracha()
      await api(`${base}/ajuste`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ modo, ajuste, uWidth }),
      })
      setStatus('Salvo.')
      opts.onSalvo?.()
      fechar('salvo')
    } catch (e) {
      setStatus((e as Error).message, true)
    } finally {
      btn.disabled = false
    }
  })

  /* ---------------- ciclo de vida ---------------- */
  let resolver: ((r: 'salvo' | 'cancelado') => void) | null = null
  const fim = new Promise<'salvo' | 'cancelado'>((res) => {
    resolver = res
  })

  function fechar(resultado: 'salvo' | 'cancelado' = 'cancelado'): void {
    overlay.remove()
    document.removeEventListener('keydown', onKey)
    resolver?.(resultado)
    resolver = null
  }
  function onKey(ev: KeyboardEvent): void {
    if (ev.key === 'Escape') fechar()
  }
  document.addEventListener('keydown', onKey)
  q<HTMLButtonElement>('.picker-editor-close').addEventListener('click', () => fechar())
  overlay.addEventListener('mousedown', (ev) => {
    if (ev.target === overlay) fechar()
  })

  canvas.style.cursor = 'grab'
  sincronizarControles()
  await carregarFonte()
  sincronizarControles()
  return fim
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] as string),
  )
}
