import './style.css'

import { checkAuth, isIaSession, login, logout } from './api'

/**
 * Painel da IA (só o login `ia`). Por pedido: o que o operador fez × a sugestão da IA em
 * modo sombra. Somente leitura — nada aqui muda pedido nem fala com o cliente.
 */

interface Foto {
  slot: number
  formato: string | null
  url: string
  compostaUrl: string | null
  ajuste: { width?: number; height?: number; dx?: number; dy?: number; rotation?: number; fonteRecorte?: string; fundoCor?: string } | null
  uWidth: number | null
  origem: 'chat' | 'upload'
}

interface Peca {
  id: number
  seq: number
  molde: string
  tipo: string
  cor: string
  emoji1: string
  emoji2: string
  origem: string
  fotos: Foto[]
}

interface Pedido {
  marketplace: string
  orderKey: string
  filha: boolean
  pedido: string
  produto: string
  modelo: string
  qtd: string
  cliente: string
  status: string
  statusCanal: string
  fotoProduto: string | null
  pecas: Peca[]
  sugestao: null
}

interface Resumo {
  versoes: number
  fotos: number
  fotosComAlteracao: number
  chats: number
  ultimasExecucoes: Array<{ dia: string; inicio: number; fim: number | null; resumo: { versoesNovas?: number } }>
}

const FORMATOS: Record<string, string> = {
  coracao: 'Coração',
  rosto: 'Recorte',
  face: 'Rosto',
  sem: 'Sem ajuste',
}

const MARKETPLACES: Record<string, string> = {
  shopee: 'Shopee',
  tiktok: 'TikTok',
  mercadolivre: 'Mercado Livre',
}

let emojis = new Map<string, string>()

function esc(texto: unknown): string {
  return String(texto ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

async function api<T>(caminho: string): Promise<T> {
  const r = await fetch(`/api${caminho}`, { credentials: 'include' })
  const corpo = (await r.json().catch(() => ({}))) as T & { error?: string }
  if (!r.ok) throw new Error(corpo.error ?? `HTTP ${r.status}`)
  return corpo
}

function hora(ms: number | null | undefined): string {
  if (!ms) return ''
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).format(new Date(ms))
}

function resumoAjuste(f: Foto): string {
  const a = f.ajuste
  if (!a) return f.formato === 'sem' ? 'foto inteira' : 'sem ajuste salvo (padrão)'
  const partes: string[] = []
  if (a.width) partes.push(`zoom ${Math.round(a.width)}`)
  if (a.dx || a.dy) partes.push(`dx ${Math.round(a.dx ?? 0)} · dy ${Math.round(a.dy ?? 0)}`)
  if (a.rotation) partes.push(`${Math.round(a.rotation * 10) / 10}°`)
  if (f.uWidth && f.formato === 'rosto') partes.push(`cápsula ${f.uWidth}`)
  if (a.fonteRecorte === 'sem_fundo') partes.push('sem fundo')
  return partes.join(' · ') || 'centralizado'
}

function emojiHtml(nome: string): string {
  if (!nome) return '<span class="ia-emoji ia-emoji--vazio" title="Sem emoji">–</span>'
  const url = emojis.get(nome)
  return url
    ? `<img class="ia-emoji" src="${esc(url)}" alt="${esc(nome)}" title="${esc(nome)}" loading="lazy" />`
    : `<span class="ia-emoji ia-emoji--texto" title="${esc(nome)}">${esc(nome)}</span>`
}

function pecaHtml(p: Peca): string {
  const fotos = p.fotos.length
    ? p.fotos
        .map(
          (f) => `
        <figure class="ia-foto">
          <img src="${esc(f.compostaUrl ?? f.url)}" alt="Foto ${f.slot}" loading="lazy" referrerpolicy="no-referrer" />
          <figcaption>
            <strong>Foto ${f.slot} · ${esc(FORMATOS[f.formato ?? ''] ?? f.formato ?? '—')}</strong>
            <span>${esc(resumoAjuste(f))}</span>
            <span class="ia-muted">${f.origem === 'chat' ? 'veio do chat' : 'enviada à mão'}</span>
          </figcaption>
        </figure>`,
        )
        .join('')
    : '<p class="ia-muted">Sem foto escolhida ainda.</p>'
  return `
    <div class="ia-peca">
      <div class="ia-peca-head">
        <span class="ia-peca-molde">Peça ${p.seq} · ${esc(p.molde)}</span>
        <span class="ia-cor" style="background:${esc(p.cor)}" title="Cor ${esc(p.cor)}"></span>
        ${emojiHtml(p.emoji1)}${emojiHtml(p.emoji2)}
      </div>
      <div class="ia-fotos">${fotos}</div>
    </div>`
}

function pedidoHtml(o: Pedido): string {
  return `
    <article class="ia-pedido">
      <header class="ia-pedido-head">
        <span class="ia-tag ia-tag--${esc(o.marketplace)}">${esc(MARKETPLACES[o.marketplace] ?? o.marketplace)}</span>
        <strong>${esc(o.pedido)}${o.filha ? ' <span class="ia-muted">(unidade extra)</span>' : ''}</strong>
        <span class="ia-muted">${esc(o.cliente)}</span>
        <span class="ia-status">${esc(o.status || o.statusCanal)}</span>
      </header>
      <p class="ia-produto">${esc(o.produto)}${o.modelo ? ` — <em>${esc(o.modelo)}</em>` : ''}${o.qtd ? ` · qtd ${esc(o.qtd)}` : ''}</p>
      <div class="ia-colunas">
        <section class="ia-coluna">
          <h3>O que o operador fez</h3>
          ${o.pecas.map(pecaHtml).join('')}
        </section>
        <section class="ia-coluna ia-coluna--ia">
          <h3>Sugestão da IA</h3>
          <div class="ia-bloco">
            <h4>Resposta sugerida</h4>
            <p class="ia-muted">Ainda sem sugestão.</p>
          </div>
          <div class="ia-bloco">
            <h4>Arte sugerida</h4>
            <p class="ia-muted">Ainda sem sugestão.</p>
          </div>
        </section>
      </div>
    </article>`
}

function resumoHtml(r: Resumo): string {
  const ultima = r.ultimasExecucoes[0]
  const leitura = ultima
    ? ultima.fim
      ? `última leitura ${hora(ultima.fim)} (+${ultima.resumo?.versoesNovas ?? 0})`
      : `leitura em andamento desde ${hora(ultima.inicio)}`
    : 'nenhuma leitura ainda'
  return `
    <div class="ia-resumo">
      <div><strong>${r.fotos}</strong><span>fotos no relatório</span></div>
      <div><strong>${r.fotosComAlteracao}</strong><span>com alteração</span></div>
      <div><strong>${r.chats}</strong><span>chats guardados</span></div>
      <div><strong>${r.versoes}</strong><span>versões</span></div>
      <div class="ia-resumo-leitura"><span>${esc(leitura)}</span></div>
    </div>`
}

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>('#app')!
  if (!isIaSession()) {
    root.innerHTML = `
      <div class="ia-page"><div class="ia-aviso">
        <p>Este endereço é do Painel da IA e precisa do login da IA.</p>
        <button type="button" class="btn" id="ia-sair">Sair e entrar com outro login</button>
      </div></div>`
    root.querySelector('#ia-sair')!.addEventListener('click', () => void logout().then(() => location.reload()))
    return
  }

  root.innerHTML = `
    <div class="ia-page">
      <header class="app-header ia-header">
        <h1>🤖 Painel da IA</h1>
        <span class="ia-sombra">Modo sombra · os operadores não veem esta tela</span>
        <div class="ia-header-espaco"></div>
        <button type="button" class="btn" id="ia-sair">Sair</button>
      </header>
      <div id="ia-resumo"></div>
      <div class="ia-filtros">
        <label>Dia <select id="ia-data"></select></label>
        <label><input type="checkbox" id="ia-com-foto" checked /> só pedidos com foto</label>
        <span class="ia-muted" id="ia-contagem"></span>
      </div>
      <main id="ia-lista" class="ia-lista"><p class="ia-muted">Carregando…</p></main>
    </div>`

  root.querySelector('#ia-sair')!.addEventListener('click', () => void logout().then(() => location.reload()))
  const selData = root.querySelector<HTMLSelectElement>('#ia-data')!
  const chkFoto = root.querySelector<HTMLInputElement>('#ia-com-foto')!
  const lista = root.querySelector<HTMLElement>('#ia-lista')!
  const contagem = root.querySelector<HTMLElement>('#ia-contagem')!
  let pedidos: Pedido[] = []

  function desenhar(): void {
    const visiveis = chkFoto.checked ? pedidos.filter((o) => o.pecas.some((p) => p.fotos.length > 0)) : pedidos
    contagem.textContent = `${visiveis.length} de ${pedidos.length} pedido(s)`
    lista.innerHTML = visiveis.length
      ? visiveis.map(pedidoHtml).join('')
      : '<p class="ia-muted">Nenhum pedido para mostrar neste dia.</p>'
  }

  async function carregarDia(): Promise<void> {
    lista.innerHTML = '<p class="ia-muted">Carregando…</p>'
    try {
      pedidos = (await api<{ pedidos: Pedido[] }>(`/ia/pedidos?data=${encodeURIComponent(selData.value)}`)).pedidos
      desenhar()
    } catch (e) {
      lista.innerHTML = `<p class="ia-erro">Falha ao carregar: ${esc((e as Error).message)}</p>`
    }
  }

  chkFoto.addEventListener('change', desenhar)
  selData.addEventListener('change', () => void carregarDia())

  const [resumo, datas, catalogo] = await Promise.all([
    api<{ relatorio: Resumo }>('/ia/resumo').catch(() => null),
    api<{ datas: string[] }>('/ia/datas'),
    api<{ items: Array<{ name: string; imageUrl: string }> }>('/emoji-catalog').catch(() => ({ items: [] })),
  ])
  emojis = new Map(catalogo.items.map((i) => [i.name, i.imageUrl]))
  if (resumo) root.querySelector('#ia-resumo')!.innerHTML = resumoHtml(resumo.relatorio)
  selData.innerHTML = datas.datas.map((d) => `<option value="${esc(d)}">${esc(d)}</option>`).join('')
  if (datas.datas.length === 0) {
    lista.innerHTML = '<p class="ia-muted">Nenhum pedido com peças ainda.</p>'
    return
  }
  await carregarDia()
}

function telaLogin(): void {
  const overlay = document.createElement('div')
  overlay.className = 'login-overlay'
  overlay.innerHTML = `
    <form class="login-card">
      <h2>Painel da IA</h2>
      <label><span>Usuário</span><input id="u" type="text" autocomplete="username" required autofocus /></label>
      <label><span>Senha</span><input id="p" type="password" autocomplete="current-password" required /></label>
      <button type="submit">Entrar</button>
      <div class="login-error" id="err" hidden></div>
    </form>`
  const form = overlay.querySelector('form')!
  const err = overlay.querySelector<HTMLDivElement>('#err')!
  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    err.hidden = true
    try {
      await login(
        overlay.querySelector<HTMLInputElement>('#u')!.value.trim(),
        overlay.querySelector<HTMLInputElement>('#p')!.value,
      )
      await checkAuth()
      overlay.remove()
      await boot()
    } catch (error) {
      err.hidden = false
      err.textContent = (error as Error).message
    }
  })
  document.body.appendChild(overlay)
}

void checkAuth().then((ok) => (ok ? boot() : telaLogin()))
