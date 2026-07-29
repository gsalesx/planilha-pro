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
/** Laranja da guia de corte — precisa destacar sobre pele, roupa e fundo claro. */
const GUIA_COR = '#ff7a18'

export type ModoFoto = 'coracao' | 'recorte'

export interface AjusteFoto {
  width?: number
  dx?: number
  dy?: number
  rotation?: number
}

/** 'original' = corta a foto COM fundo direto (uso legítimo — nem toda foto precisa de
 *  remoção); 'sem_fundo' = usa a silhueta recortada pelo PicWish. */
export type FonteRecorte = 'original' | 'sem_fundo'

interface EstadoServidor {
  modo: ModoFoto
  ajuste: AjusteFoto
  uWidth: number
  temSemFundo: boolean
  temComposta: boolean
  fonteRecorte: FonteRecorte
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
    // SEM crossOrigin: as rotas são same-origin e exigem sessão. `anonymous`
    // faz o navegador OMITIR o cookie → 401 → a imagem nunca carrega.
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
  let fonteRecorte: FonteRecorte = estado.fonteRecorte
  let temSemFundo = estado.temSemFundo

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
          <div class="picker-editor-duplo">
            <figure>
              <figcaption>Foto — arraste pra posicionar</figcaption>
              <canvas class="picker-editor-canvas" width="${CANVAS}" height="${CANVAS}"></canvas>
            </figure>
            <figure>
              <figcaption>Resultado</figcaption>
              <canvas class="picker-editor-canvas picker-editor-canvas--saida" width="${CANVAS}" height="${CANVAS}"></canvas>
            </figure>
          </div>
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
            <div class="picker-editor-fonte">
              <button type="button" class="btn in-fonte-original" title="Corta a foto ORIGINAL, com fundo">🖼 Foto original</button>
              <button type="button" class="btn in-removebg" title="Corta a silhueta sem fundo (PicWish)">✂ Remover fundo</button>
            </div>
          </div>

          <div class="picker-editor-grupo">
            <span class="picker-editor-label">Zoom <b class="v-zoom"></b></span>
            <input type="range" class="in-zoom" min="20" max="400" step="1" />
          </div>

          <div class="picker-editor-grupo">
            <span class="picker-editor-label">Girar <b class="v-rot"></b></span>
            <div class="picker-editor-rot-wrap">
              <svg class="picker-editor-rot-disco" viewBox="0 0 120 120" width="120" height="120">
                <circle class="picker-editor-rot-trilha" cx="60" cy="60" r="52"></circle>
                <circle class="picker-editor-rot-bola" cx="60" cy="8" r="9"></circle>
              </svg>
              <div class="picker-editor-rot-90">
                <button type="button" data-rot="-90" title="Girar -90°">-90°</button>
                <button type="button" data-rot="90" title="Girar +90°">+90°</button>
              </div>
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
  const saida = q<HTMLCanvasElement>('.picker-editor-canvas--saida')
  const ctxSaida = saida.getContext('2d')!
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
  // Falha aqui NÃO pode abortar a montagem do editor (era o que deixava os
  // botões sem efeito): sem a máscara, cai no contorno desenhado à mão.
  let heart: HTMLImageElement | null = null
  try {
    heart = await carregarImagem('/api/picker/mask/heart')
  } catch {
    heart = null
  }

  /**
   * `heart-mask.png` é ESCALA DE CINZA sem canal alpha (é o formato que o sharp
   * espera no servidor, que lê o canal L como máscara). No navegador ela carrega
   * 100% opaca, então usá-la direto em `destination-out`/`destination-in` apagava
   * ou preservava o quadro INTEIRO — era por isso que a mascaração do coração não
   * aparecia. Aqui a luminância vira alpha, produzindo a máscara de verdade.
   */
  function mascaraComAlpha(img: HTMLImageElement): HTMLCanvasElement {
    const m = document.createElement('canvas')
    m.width = CANVAS
    m.height = CANVAS
    const mc = m.getContext('2d')!
    mc.drawImage(img, 0, 0, CANVAS, CANVAS)
    const dados = mc.getImageData(0, 0, CANVAS, CANVAS)
    const px = dados.data
    for (let i = 0; i < px.length; i += 4) {
      px[i + 3] = px[i] // luminância → alpha
      px[i] = 255
      px[i + 1] = 255
      px[i + 2] = 255
    }
    mc.putImageData(dados, 0, 0)
    return m
  }

  /**
   * Anel de contorno de uma máscara: dilata a silhueta em 8 direções e subtrai a
   * original, sobrando só a borda. É o que dá a linha grossa e destacada em cima
   * da foto — sem isso o único indício do formato era um escurecimento sutil.
   */
  function anelDaMascara(m: HTMLCanvasElement, cor: string, espessura: number): HTMLCanvasElement {
    const anel = document.createElement('canvas')
    anel.width = CANVAS
    anel.height = CANVAS
    const c = anel.getContext('2d')!
    const e = espessura
    const desloc: Array<[number, number]> = [
      [-e, 0], [e, 0], [0, -e], [0, e],
      [-e, -e], [e, -e], [-e, e], [e, e],
    ]
    for (const [ox, oy] of desloc) c.drawImage(m, ox, oy, CANVAS, CANVAS)
    c.globalCompositeOperation = 'source-in'
    c.fillStyle = cor
    c.fillRect(0, 0, CANVAS, CANVAS)
    c.globalCompositeOperation = 'destination-out'
    c.drawImage(m, 0, 0, CANVAS, CANVAS)
    return anel
  }

  // getImageData lança SecurityError em canvas "tainted". Aqui é same-origin,
  // então não deveria acontecer — mas uma exceção nesta linha derrubaria a
  // montagem do editor inteiro (foi assim que os botões sumiram da outra vez).
  let heartMask: HTMLCanvasElement | null = null
  let heartAnel: HTMLCanvasElement | null = null
  try {
    heartMask = heart ? mascaraComAlpha(heart) : null
    heartAnel = heartMask ? anelDaMascara(heartMask, GUIA_COR, 5) : null
  } catch {
    heartMask = null
    heartAnel = null
  }

  /** Camada onde a borracha pinta (mesma resolução da foto sem fundo). */
  let apagador: HTMLCanvasElement | null = null
  let borrachaAtiva = false
  /** Posição do mouse no canvas — só usada pra desenhar a bolinha da borracha. */
  let cursor: { x: number; y: number } | null = null

  async function carregarFonte(): Promise<void> {
    const url = modo === 'recorte'
      ? (fonteRecorte === 'original' ? `${base}?t=${Date.now()}` : `${base}/sem-fundo`)
      : `${base}?t=${Date.now()}`
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
      if (modo === 'recorte' && fonteRecorte === 'sem_fundo') {
        // Sem foto sem-fundo ainda: 404 é o estado normal na 1ª vez. Destaca
        // o botão em vez de só escrever a instrução.
        setStatus('O recorte precisa da foto sem fundo — clique em "✂ Remover fundo" (botão abaixo).', true)
        q<HTMLButtonElement>('.in-removebg').classList.add('destaque')
      } else {
        setStatus('Não consegui carregar a foto.', true)
      }
      desenhar()
    }
  }

  /* ---------------- desenho do preview ---------------- */
  /** Carimba a foto com o enquadramento atual no contexto dado. */
  function desenharFoto(c: CanvasRenderingContext2D): void {
    if (!fonte) return
    const rot = tamanhoRotacionado(fonte.naturalWidth, fonte.naturalHeight, ajuste.rotation)
    const escala = (ajuste.width || rot.w) / rot.w
    const dw = fonte.naturalWidth * escala
    const dh = fonte.naturalHeight * escala
    c.save()
    c.translate(CANVAS / 2 + ajuste.dx, CANVAS / 2 + ajuste.dy)
    c.rotate((ajuste.rotation * Math.PI) / 180)
    c.imageSmoothingQuality = 'high'
    c.drawImage(fonte, -dw / 2, -dh / 2, dw, dh)
    if (apagador) c.drawImage(apagador, -dw / 2, -dh / 2, dw, dh)
    c.restore()
  }

  /**
   * Contorno do formato — é a "mascaração" que mostra onde vai cortar.
   * Escurece o que fica de fora e traça a borda em laranja por cima: só o
   * escurecimento era discreto demais pra enxergar em foto clara.
   */
  function desenharGuia(c: CanvasRenderingContext2D): void {
    c.save()
    if (modo === 'recorte') {
      // Fora da cápsula escurecido, com a mesma leitura do modo coração: o cinza é o
      // que vai FICAR DE FORA, não o que fica dentro.
      // ⚠️ `caminhoCapsula` chama `c.beginPath()` — se o retângulo externo fosse
      // desenhado ANTES dela nesta mesma trajetória, esse beginPath apagaria o
      // retângulo e o fill('evenodd') acabava enxergando só a cápsula sozinha,
      // pintando ela por DENTRO (exatamente o inverso do esperado). O retângulo tem
      // que vir DEPOIS de caminhoCapsula já ter aberto o novo Path2D.
      c.save()
      caminhoCapsula(c, uWidth)
      c.rect(0, 0, CANVAS, CANVAS)
      c.fillStyle = 'rgba(15,23,42,.45)'
      c.fill('evenodd')
      c.restore()
      // Halo escuro por baixo pra linha não sumir em foto clara.
      caminhoCapsula(c, uWidth)
      c.strokeStyle = 'rgba(15,23,42,.55)'
      c.lineWidth = 11
      c.stroke()
      caminhoCapsula(c, uWidth)
      c.strokeStyle = GUIA_COR
      c.lineWidth = 5
      c.stroke()
    } else if (heartMask) {
      const fora = document.createElement('canvas')
      fora.width = CANVAS
      fora.height = CANVAS
      const fc = fora.getContext('2d')!
      fc.fillStyle = 'rgba(15,23,42,.45)'
      fc.fillRect(0, 0, CANVAS, CANVAS)
      fc.globalCompositeOperation = 'destination-out'
      fc.drawImage(heartMask, 0, 0, CANVAS, CANVAS)
      c.drawImage(fora, 0, 0)
      if (heartAnel) c.drawImage(heartAnel, 0, 0)
    }
    c.restore()
  }

  /** Bolinha da borracha: mostra exatamente a área que o clique vai apagar. */
  function desenharCursorBorracha(c: CanvasRenderingContext2D): void {
    if (!borrachaAtiva || !cursor) return
    c.save()
    c.beginPath()
    c.arc(cursor.x, cursor.y, Number(inBrush.value) / 2, 0, Math.PI * 2)
    c.strokeStyle = 'rgba(255,255,255,.95)'
    c.lineWidth = 4
    c.stroke()
    c.strokeStyle = 'rgba(15,23,42,.9)'
    c.lineWidth = 2
    c.stroke()
    c.restore()
  }

  function desenhar(): void {
    // ESQUERDA: foto inteira + guia do formato (é onde se arrasta).
    ctx.clearRect(0, 0, CANVAS, CANVAS)
    desenharFoto(ctx)
    desenharGuia(ctx)
    desenharCursorBorracha(ctx)

    // DIREITA: o resultado, já recortado no formato.
    ctxSaida.clearRect(0, 0, CANVAS, CANVAS)
    desenharFoto(ctxSaida)
    ctxSaida.globalCompositeOperation = 'destination-in'
    if (modo === 'coracao') {
      if (heartMask) ctxSaida.drawImage(heartMask, 0, 0, CANVAS, CANVAS)
    } else {
      desenharCapsula(ctxSaida, uWidth)
    }
    ctxSaida.globalCompositeOperation = 'source-over'
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
  // A bolinha da borracha precisa acompanhar o mouse mesmo sem botão pressionado.
  canvas.addEventListener('mousemove', (ev) => {
    if (!borrachaAtiva || arrastando) return
    cursor = paraCanvas(ev)
    desenhar()
  })
  canvas.addEventListener('mouseleave', () => {
    if (!borrachaAtiva) return
    cursor = null
    desenhar()
  })

  window.addEventListener('mousemove', (ev) => {
    if (!arrastando) return
    const p = paraCanvas(ev)
    if (borrachaAtiva) {
      cursor = p
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
    canvas.style.cursor = borrachaAtiva ? 'none' : 'grab'
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
    posicionarBolaRotacao()
    inUWidth.value = String(uWidth)
    q('.v-uwidth').textContent = String(uWidth)
    overlay.querySelectorAll<HTMLElement>('[data-so-recorte]').forEach((el) => {
      el.style.display = modo === 'recorte' ? '' : 'none'
    })
    overlay.querySelectorAll<HTMLButtonElement>('[data-modo]').forEach((b) => {
      b.classList.toggle('ativo', b.dataset.modo === modo)
    })
    // Mesma semântica do picker local: "Foto original" só faz sentido clicar se tem
    // pra onde voltar (sem-fundo já existe) E não é já o que está sendo visto agora;
    // "Remover fundo" só faz sentido se ainda não é a fonte ativa (senão é reclicar
    // à toa) — ambos continuam clicáveis, isso é só pra deixar claro qual ação falta.
    const btnOriginal = q<HTMLButtonElement>('.in-fonte-original')
    const btnRemoverFundo = q<HTMLButtonElement>('.in-removebg')
    btnOriginal.classList.toggle('ativo', fonteRecorte === 'original')
    btnOriginal.disabled = !temSemFundo && fonteRecorte === 'original'
    btnRemoverFundo.classList.toggle('ativo', fonteRecorte === 'sem_fundo')
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

  /**
   * Disco de rotação: a bolinha fica presa na borda do círculo, e arrastá-la em volta
   * gira a foto — o ângulo da bolinha (medido a partir do topo, sentido horário) É o
   * `ajuste.rotation`. Pedido do user, no lugar dos botões -1°/+1° (imprecisos pra
   * ajuste fino) como controle principal; +90°/-90° continuam ao lado pra virar rápido.
   */
  const discoRot = overlay.querySelector<SVGSVGElement>('.picker-editor-rot-disco')!
  const bolaRot = overlay.querySelector<SVGCircleElement>('.picker-editor-rot-bola')!
  const CENTRO_ROT = 60
  const RAIO_ROT = 52

  function posicionarBolaRotacao(): void {
    // -90 pra medir a partir do topo (0°) em vez do padrão trigonométrico (3h).
    const rad = ((ajuste.rotation - 90) * Math.PI) / 180
    bolaRot.setAttribute('cx', String(CENTRO_ROT + RAIO_ROT * Math.cos(rad)))
    bolaRot.setAttribute('cy', String(CENTRO_ROT + RAIO_ROT * Math.sin(rad)))
  }

  function anguloDoPonteiro(clientX: number, clientY: number): number {
    const r = discoRot.getBoundingClientRect()
    const escala = 120 / r.width // viewBox é 120×120, independente do tamanho renderizado
    const x = (clientX - r.left) * escala - CENTRO_ROT
    const y = (clientY - r.top) * escala - CENTRO_ROT
    // atan2 padrão mede a partir do eixo X (3h); +90 realinha pro topo = 0°.
    return (Math.atan2(y, x) * 180) / Math.PI + 90
  }

  let arrastandoRot = false
  discoRot.addEventListener('pointerdown', (ev) => {
    arrastandoRot = true
    discoRot.setPointerCapture(ev.pointerId)
    ajuste.rotation = anguloDoPonteiro(ev.clientX, ev.clientY)
    sincronizarControles()
    desenhar()
  })
  discoRot.addEventListener('pointermove', (ev) => {
    if (!arrastandoRot) return
    ajuste.rotation = anguloDoPonteiro(ev.clientX, ev.clientY)
    sincronizarControles()
    desenhar()
  })
  discoRot.addEventListener('pointerup', () => {
    arrastandoRot = false
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
    // Borracha apaga sobra do REMOVE-FUNDO — não faz sentido em cima da foto
    // original (ainda com fundo), e salvar erraria: aplicarBorracha sempre grava em
    // sem_fundo_path, então apagar sobre a original corromperia o sem-fundo guardado.
    if (fonteRecorte === 'original') {
      setStatus('A borracha só funciona na foto sem fundo — clique em "✂ Remover fundo".', true)
      return
    }
    borrachaAtiva = !borrachaAtiva
    ;(ev.currentTarget as HTMLButtonElement).classList.toggle('ativo', borrachaAtiva)
    canvas.style.cursor = borrachaAtiva ? 'none' : 'grab'
    if (!borrachaAtiva) cursor = null
    desenhar()
  })

  // Mudar o tamanho do pincel precisa redesenhar a bolinha na hora.
  inBrush.addEventListener('input', () => desenhar())

  // "🖼 Foto original": troca a FONTE do recorte pra foto COM fundo, sem chamar
  // nenhuma API — é só cliente decidindo qual imagem carregar/compor.
  q<HTMLButtonElement>('.in-fonte-original').addEventListener('click', () => {
    if (fonteRecorte === 'original') return
    fonteRecorte = 'original'
    setStatus('')
    sincronizarControles()
    void carregarFonte()
  })

  /**
   * Remove o fundo (PicWish) ou reaproveita o que já existe — mesma lógica pro
   * clique manual e pro disparo automático na abertura (ver chamada no fim da
   * função). Se o sem-fundo JÁ EXISTE (ex. usuário foi pra "Foto original" e
   * voltou), só troca a fonte de volta — NÃO chama o PicWish de novo (evita
   * gastar a chamada paga à toa). Só bate no PicWish quando falta gerar.
   */
  async function removerFundo(btn?: HTMLButtonElement): Promise<void> {
    if (fonteRecorte === 'sem_fundo') return
    if (temSemFundo) {
      fonteRecorte = 'sem_fundo'
      setStatus('')
      sincronizarControles()
      void carregarFonte()
      return
    }
    if (btn) btn.disabled = true
    setStatus('Removendo fundo…')
    try {
      await api(`${base}/remove-bg`, { method: 'POST' })
      temSemFundo = true
      fonteRecorte = 'sem_fundo'
      setStatus('Fundo removido.')
      btn?.classList.remove('destaque')
      sincronizarControles()
      await carregarFonte()
    } catch (e) {
      setStatus((e as Error).message, true)
    } finally {
      if (btn) btn.disabled = false
    }
  }

  q<HTMLButtonElement>('.in-removebg').addEventListener('click', (ev) => {
    void removerFundo(ev.currentTarget as HTMLButtonElement)
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
        body: JSON.stringify({ modo, ajuste, uWidth, fonteRecorte }),
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
  // Recorte sem foto sem-fundo ainda — remove o fundo sozinho ao abrir, em vez de
  // esperar o clique em "✂ Remover fundo". `removerFundo()` já checa cache antes de
  // chamar o PicWish.
  //
  // ⚠️ Peça NUNCA editada devolve fonteRecorte='original' como PADRÃO do servidor
  // (parseFonteRecorte: sem ajuste_json salvo, cai em 'sem_fundo'/'original' conforme
  // já existir sem-fundo) — não é uma escolha do operador, e checar só `fonteRecorte
  // !== 'original'` bloqueava o auto-disparo bem no caso mais comum (peça fresca).
  // `ajuste.width > 0` é o sinal de que ESTE piece já foi salvo antes — só aí a
  // escolha 'original' é de verdade deliberada e deve ser respeitada.
  const jaEditadoAntes = ajuste.width > 0
  if (modo === 'recorte' && !temSemFundo && (!jaEditadoAntes || fonteRecorte !== 'original')) {
    await removerFundo()
  } else {
    await carregarFonte()
  }
  sincronizarControles()
  return fim
}

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c] as string),
  )
}
