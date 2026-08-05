import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'

import Database from 'better-sqlite3'

import { env } from './env.js'

mkdirSync(env.dataDir, { recursive: true })
mkdirSync(path.join(env.dataDir, 'images'), { recursive: true })

const dbPath = path.join(env.dataDir, 'planilha.db')
export const db = new Database(dbPath)

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

// Base schema — sempre cria o que ainda não existe.
db.exec(`
  CREATE TABLE IF NOT EXISTS workbooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    column_widths TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_workbooks_updated_at ON workbooks (updated_at);

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
`)

// Tabela legada que pode não existir mais em DBs novos. Garantir antes de migrar.
db.exec(`
  CREATE TABLE IF NOT EXISTS workbook_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL DEFAULT 'Relatórios',
    updated_at INTEGER NOT NULL DEFAULT 0,
    column_widths TEXT NOT NULL DEFAULT '{}'
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    row_json TEXT NOT NULL,
    styles_json TEXT NOT NULL DEFAULT '{}',
    disappeared INTEGER NOT NULL DEFAULT 0,
    sheet_date TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS images (
    order_id TEXT NOT NULL,
    col INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT 'image/jpeg',
    storage_path TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (order_id, col),
    FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
  );
`)

// Migration legada (single-workbook): garante sheet_date em DBs antigos.
{
  const cols = db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'sheet_date')) {
    db.exec("ALTER TABLE orders ADD COLUMN sheet_date TEXT NOT NULL DEFAULT ''")
  }
}

// Multi-workbook migration: idempotente, roda quando orders ainda não tem workbook_id.
{
  const cols = db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>
  const hasWorkbookId = cols.some((c) => c.name === 'workbook_id')
  if (!hasWorkbookId) {
    if (existsSync(dbPath)) {
      const backupPath = `${dbPath}.pre-multiworkbook.bak`
      if (!existsSync(backupPath)) {
        copyFileSync(dbPath, backupPath)
      }
    }

    const migrate = db.transaction(() => {
      // 1) Seed workbook 'default' a partir do workbook_meta legado, se ainda não houver.
      const meta = db
        .prepare(
          'SELECT name, updated_at, column_widths FROM workbook_meta WHERE id = 1',
        )
        .get() as { name: string; updated_at: number; column_widths: string } | undefined
      const wbCount = (db.prepare('SELECT COUNT(*) AS c FROM workbooks').get() as { c: number }).c
      if (wbCount === 0) {
        const now = Date.now()
        db.prepare(
          'INSERT INTO workbooks (id, name, created_at, updated_at, column_widths) VALUES (?, ?, ?, ?, ?)',
        ).run(
          'default',
          meta?.name ?? 'Relatórios',
          meta?.updated_at ?? now,
          meta?.updated_at ?? now,
          meta?.column_widths ?? '{}',
        )
      }

      // 2) Recriar `orders` com workbook_id + PK composta.
      db.exec(`
        CREATE TABLE orders_new (
          workbook_id TEXT NOT NULL,
          id TEXT NOT NULL,
          row_json TEXT NOT NULL,
          styles_json TEXT NOT NULL DEFAULT '{}',
          disappeared INTEGER NOT NULL DEFAULT 0,
          sheet_date TEXT NOT NULL DEFAULT '',
          position INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workbook_id, id),
          FOREIGN KEY (workbook_id) REFERENCES workbooks(id) ON DELETE CASCADE
        );
      `)
      db.prepare(
        `INSERT INTO orders_new (workbook_id, id, row_json, styles_json, disappeared, sheet_date, position, updated_at)
         SELECT 'default', id, row_json, styles_json, disappeared, sheet_date, position, updated_at FROM orders`,
      ).run()
      db.exec('DROP TABLE orders')
      db.exec('ALTER TABLE orders_new RENAME TO orders')
      db.exec('CREATE INDEX IF NOT EXISTS idx_orders_workbook_position ON orders (workbook_id, position)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_orders_workbook_updated_at ON orders (workbook_id, updated_at)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_orders_workbook_sheet_date ON orders (workbook_id, sheet_date)')

      // 3) Recriar `images` com workbook_id + PK e FK compostas.
      db.exec(`
        CREATE TABLE images_new (
          workbook_id TEXT NOT NULL,
          order_id TEXT NOT NULL,
          col INTEGER NOT NULL,
          file_name TEXT NOT NULL,
          mime TEXT NOT NULL DEFAULT 'image/jpeg',
          storage_path TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workbook_id, order_id, col),
          FOREIGN KEY (workbook_id, order_id) REFERENCES orders(workbook_id, id) ON DELETE CASCADE
        );
      `)
      db.prepare(
        `INSERT INTO images_new (workbook_id, order_id, col, file_name, mime, storage_path, updated_at)
         SELECT 'default', order_id, col, file_name, mime, storage_path, updated_at FROM images`,
      ).run()
      db.exec('DROP TABLE images')
      db.exec('ALTER TABLE images_new RENAME TO images')
      db.exec('CREATE INDEX IF NOT EXISTS idx_images_workbook_order ON images (workbook_id, order_id)')

      // 4) workbook_meta vira história — mantemos a tabela criada acima por compat,
      //    mas não escrevemos mais nela. As novas rotas usam `workbooks`.
    })
    migrate()
    console.log('[migration] multi-workbook schema aplicada com sucesso')
  }
}

// Chave interna por linha: permite IDs visíveis repetidos sem misturar status/fotos.
{
  const cols = db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>
  const hasWorkbookId = cols.some((c) => c.name === 'workbook_id')
  const hasOrderKey = cols.some((c) => c.name === 'order_key')
  if (hasWorkbookId && !hasOrderKey) {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE orders_new (
          workbook_id TEXT NOT NULL,
          order_key TEXT NOT NULL,
          id TEXT NOT NULL,
          row_json TEXT NOT NULL,
          styles_json TEXT NOT NULL DEFAULT '{}',
          disappeared INTEGER NOT NULL DEFAULT 0,
          sheet_date TEXT NOT NULL DEFAULT '',
          position INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workbook_id, order_key),
          FOREIGN KEY (workbook_id) REFERENCES workbooks(id) ON DELETE CASCADE
        );
      `)
      db.prepare(
        `INSERT INTO orders_new (workbook_id, order_key, id, row_json, styles_json, disappeared, sheet_date, position, updated_at)
         SELECT workbook_id, id, id, row_json, styles_json, disappeared, sheet_date, position, updated_at FROM orders`,
      ).run()

      db.exec('ALTER TABLE images RENAME TO images_old')
      db.exec('DROP TABLE orders')
      db.exec('ALTER TABLE orders_new RENAME TO orders')
      db.exec('CREATE INDEX IF NOT EXISTS idx_orders_workbook_position ON orders (workbook_id, position)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_orders_workbook_updated_at ON orders (workbook_id, updated_at)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_orders_workbook_sheet_date ON orders (workbook_id, sheet_date)')
      db.exec('CREATE INDEX IF NOT EXISTS idx_orders_workbook_visible_id ON orders (workbook_id, id)')

      db.exec(`
        CREATE TABLE images (
          workbook_id TEXT NOT NULL,
          order_id TEXT NOT NULL,
          col INTEGER NOT NULL,
          file_name TEXT NOT NULL,
          mime TEXT NOT NULL DEFAULT 'image/jpeg',
          storage_path TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (workbook_id, order_id, col),
          FOREIGN KEY (workbook_id, order_id) REFERENCES orders(workbook_id, order_key) ON DELETE CASCADE
        );
      `)
      db.prepare(
        `INSERT INTO images (workbook_id, order_id, col, file_name, mime, storage_path, updated_at)
         SELECT workbook_id, order_id, col, file_name, mime, storage_path, updated_at FROM images_old`,
      ).run()
      db.exec('DROP TABLE images_old')
      db.exec('CREATE INDEX IF NOT EXISTS idx_images_workbook_order ON images (workbook_id, order_id)')
    })
    db.pragma('foreign_keys = OFF')
    try {
      migrate()
    } finally {
      db.pragma('foreign_keys = ON')
    }
    console.log('[migration] order_key schema aplicada com sucesso')
  }
}

// Foto do produto/anúncio (image_info.image_url do get_order_detail da Shopee) — mostrada
// no card do chat pra o operador ver "o que o cliente comprou de fato" sem entrar na Shopee.
{
  const cols = db.prepare("PRAGMA table_info(orders)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'product_image_url')) {
    db.exec("ALTER TABLE orders ADD COLUMN product_image_url TEXT NOT NULL DEFAULT ''")
  }
}

/**
 * Agrupamento pai/filha (2026-07-28). Um pedido passa a ocupar UMA linha contável na
 * planilha; as unidades seguintes viram linhas-filhas (`↳`), que existem de verdade —
 * cada uma tem sua arte e sua prévia — mas não contam como pedido.
 *
 * `parent_key` NULL = linha do pedido (a 1ª unidade). Preenchido = filha, apontando pra
 * key da linha-pai. Não há FK: a limpeza é feita junto do pedido, e uma FK com CASCADE
 * apagaria as filhas silenciosamente num delete manual da linha-pai.
 */
{
  const cols = db.prepare('PRAGMA table_info(orders)').all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'parent_key')) {
    db.exec('ALTER TABLE orders ADD COLUMN parent_key TEXT')
    db.exec('CREATE INDEX IF NOT EXISTS idx_orders_parent ON orders (workbook_id, parent_key)')
    console.log('[migration] orders.parent_key criada')
  }
}

// Mapa comprador Shopee → chat (fora da planilha; usado para envio de prévias etc.)
db.exec(`
  CREATE TABLE IF NOT EXISTS shopee_buyer_chats (
    buyer_user_id INTEGER NOT NULL PRIMARY KEY,
    buyer_username TEXT NOT NULL DEFAULT '',
    conversation_id TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shopee_buyer_chats_username ON shopee_buyer_chats (buyer_username);
`)

// Disparo único: mensagem automática na PRÓXIMA compra READY_TO_SHIP (teste de chat frio).
db.exec(`
  CREATE TABLE IF NOT EXISTS shopee_auto_greet (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    armed INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL DEFAULT 0
  );
  INSERT OR IGNORE INTO shopee_auto_greet (id, armed, message, updated_at) VALUES (1, 0, '', 0);

  CREATE TABLE IF NOT EXISTS shopee_auto_greet_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_sn TEXT NOT NULL,
    buyer_user_id INTEGER,
    buyer_username TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_shopee_auto_greet_log_created ON shopee_auto_greet_log (created_at);
`)

/**
 * Captura diagnóstica de qualquer push com código desconhecido (não é 3/8) — usada pra
 * descobrir o formato real do webchat_push antes de implementar o vínculo automático de
 * verdade. Guarda o payload cru + um "chute" de campos prováveis (to_id, username, etc);
 * nada aqui grava em shopee_buyer_chats.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS shopee_webchat_push_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at INTEGER NOT NULL,
    code INTEGER NOT NULL,
    raw_json TEXT NOT NULL,
    guessed_to_id INTEGER,
    guessed_from_user_name TEXT,
    guessed_to_user_name TEXT,
    guessed_conversation_id TEXT,
    guessed_content TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_shopee_webchat_push_log_received ON shopee_webchat_push_log (received_at);
`)

/**
 * Pendências do parser SKU→peça: pedidos cujo SKU/campo Modelo não bateu com
 * nenhuma família conhecida (ver server/src/sku-rules.ts). Página de revisão
 * em src/parse-issues.ts.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS parse_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workbook_id TEXT NOT NULL,
    order_key TEXT NOT NULL,
    order_id TEXT NOT NULL,
    sku TEXT NOT NULL,
    model_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_parse_issues_resolved ON parse_issues (resolved, created_at);
  CREATE INDEX IF NOT EXISTS idx_parse_issues_order ON parse_issues (workbook_id, order_key);
`)

/**
 * Peças resolvidas por pedido (Fase 2 da migração SKU→peça — ver
 * server/src/sku-rules.ts e server/src/pieces.ts). Cada order_key pode gerar 1+ peças
 * (ex.: CAMISOLA + SHORT = 2 peças). `source` = 'auto' (veio do parser) ou 'manual'
 * (usuário criou/editou). Fotos de cada peça (baixadas do chat Shopee) em piece_images,
 * reaproveitando o mesmo diretório de disco de `images` (env.dataDir/images).
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS order_pieces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workbook_id TEXT NOT NULL,
    order_key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    tipo TEXT NOT NULL,
    genero TEXT,
    tamanho TEXT NOT NULL,
    molde TEXT NOT NULL,
    emoji1 TEXT NOT NULL DEFAULT '',
    emoji2 TEXT NOT NULL DEFAULT '',
    cor TEXT NOT NULL DEFAULT '#000000',
    nota TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'auto',
    updated_at INTEGER NOT NULL,
    UNIQUE (workbook_id, order_key, seq)
  );
  CREATE INDEX IF NOT EXISTS idx_order_pieces_order ON order_pieces (workbook_id, order_key);

  CREATE TABLE IF NOT EXISTS piece_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piece_id INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    mime TEXT NOT NULL DEFAULT 'image/jpeg',
    storage_path TEXT NOT NULL,
    crop TEXT NOT NULL DEFAULT 'rosto',
    updated_at INTEGER NOT NULL,
    UNIQUE (piece_id, slot),
    FOREIGN KEY (piece_id) REFERENCES order_pieces(id) ON DELETE CASCADE
  );

  -- Foto escolhida mas AINDA NÃO baixada/salva — só a URL do CDN da Shopee (hotlink
  -- direto pro preview, sem custo de download). Só vira piece_images (arquivo salvo de
  -- verdade) quando o pedido é confirmado (POST .../pieces/:orderKey/confirm) — antes
  -- disso, escolher foto era lento (baixava na hora) e sujava o disco com fotos de
  -- pedido que o operador pode nem confirmar.
  CREATE TABLE IF NOT EXISTS piece_pending_photos (
    piece_id INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    url TEXT NOT NULL,
    crop TEXT NOT NULL DEFAULT 'rosto',
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (piece_id, slot),
    FOREIGN KEY (piece_id) REFERENCES order_pieces(id) ON DELETE CASCADE
  );
`)

/**
 * Catálogo de emojis disponíveis pro picker de peças (Emoji 1/2 — ver
 * server/src/emoji-catalog.ts e src/shopee-chat-panel.ts). `name` é o nome
 * canônico, mesma convenção do repo irmão Criador de artes
 * (`Moldes/EMOJIS/{name}.png`) — é o que fica salvo em order_pieces.emoji1/2.
 * `aliases` = emojis unicode colados do chat que resolvem pra esse `name`
 * (JSON array). `source` builtin = veio de server/assets/emojis/ (seed no
 * boot, protegido contra DELETE/rename); custom = upload do usuário.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS emoji_catalog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    aliases TEXT NOT NULL DEFAULT '[]',
    image_path TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'builtin',
    created_at INTEGER NOT NULL
  );
`)

/**
 * Trilha de auditoria de TUDO que mexe em pedido sem humano na frente: poll de 2h,
 * webhook da Shopee, upsert linha a linha, mutações via API de automação.
 *
 * Existe porque o `console.log` morre no restart do container: quando um pedido de 2 peças
 * apareceu como 3 linhas (bug da order_key com data embutida, 2026-07-28 — casos 24lehsilva/
 * livea.maria123/taty1lima), não havia NENHUM registro de qual rotina criou a linha extra nem
 * quando — a timeline teve que ser deduzida de `position`/`updated_at`. Regra: qualquer
 * escrita automática em `orders` deixa rastro aqui.
 *
 * `run_id` correlaciona todos os eventos de uma mesma execução (um poll, um push).
 * `detail_json` é livre — guardar o máximo de contexto, inclusive payload cru quando couber.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    level TEXT NOT NULL DEFAULT 'info',
    source TEXT NOT NULL,
    event TEXT NOT NULL,
    run_id TEXT,
    workbook_id TEXT,
    order_sn TEXT,
    order_key TEXT,
    detail_json TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_order_sn ON audit_log (order_sn, at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_event ON audit_log (event, at);
  CREATE INDEX IF NOT EXISTS idx_audit_log_run ON audit_log (run_id);
  CREATE INDEX IF NOT EXISTS idx_audit_log_level ON audit_log (level, at);
`)

// Migration idempotente: garante order_pieces.nota em DBs criados antes dessa coluna existir.
{
  const cols = db.prepare("PRAGMA table_info(order_pieces)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'nota')) {
    db.exec("ALTER TABLE order_pieces ADD COLUMN nota TEXT NOT NULL DEFAULT ''")
  }
}

// Migration idempotente: garante piece_images.crop
// ('rosto'=recorte/cápsula | 'coracao' | 'face'=face cutout PicWish) em DBs
// criados antes dessa coluna existir.
{
  const cols = db.prepare("PRAGMA table_info(piece_images)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'crop')) {
    db.exec("ALTER TABLE piece_images ADD COLUMN crop TEXT NOT NULL DEFAULT 'rosto'")
  }
}

/**
 * Migration idempotente — estado do PICKER WEB por foto (server/src/render-foto.ts).
 * Guarda o ajuste manual (posição/zoom/rotação) em vez da arte pronta: regerar é
 * barato (~0,3s) e a arte final pesa ~4MB, então ela é efêmera (gerada no download).
 *  - ajuste_json:  {dx, dy, rotation, width} escolhidos no editor
 *  - u_width:      largura da cápsula, só no modo recorte
 *  - sem_fundo_path: cache do PicWish (chamada externa, cara — não repetir)
 *  - composta_path:  PNG 900×900 já com máscara/borda, pronto pro carimbo
 */
{
  const cols = db.prepare('PRAGMA table_info(piece_images)').all() as Array<{ name: string }>
  const add = (nome: string, ddl: string) => {
    if (!cols.some((c) => c.name === nome)) db.exec(`ALTER TABLE piece_images ADD COLUMN ${ddl}`)
  }
  add('ajuste_json', "ajuste_json TEXT NOT NULL DEFAULT ''")
  add('u_width', 'u_width INTEGER')
  add('sem_fundo_path', "sem_fundo_path TEXT NOT NULL DEFAULT ''")
  add('composta_path', "composta_path TEXT NOT NULL DEFAULT ''")
}

/** Status legado "Em produção" → "Em produção 1" (coluna F, índice 5 do row_json). */
{
  const STATUS_COL = 5
  const rows = db
    .prepare('SELECT workbook_id, order_key, row_json FROM orders')
    .all() as Array<{ workbook_id: string; order_key: string; row_json: string }>
  const update = db.prepare(
    'UPDATE orders SET row_json = ?, updated_at = ? WHERE workbook_id = ? AND order_key = ?',
  )
  let migrated = 0
  const run = db.transaction(() => {
    for (const row of rows) {
      let cells: unknown
      try {
        cells = JSON.parse(row.row_json)
      } catch {
        continue
      }
      if (!Array.isArray(cells)) continue
      if (String(cells[STATUS_COL] ?? '').trim() !== 'Em produção') continue
      cells[STATUS_COL] = 'Em produção 1'
      update.run(JSON.stringify(cells), Date.now(), row.workbook_id, row.order_key)
      migrated++
    }
  })
  run()
  if (migrated > 0) {
    console.log(`[migration] Em produção → Em produção 1: ${migrated} pedido(s)`)
  }
}

/**
 * Cache da arte FINAL por peça (2026-07-29). Antes a arte era sempre gerada na hora e
 * descartada — cada download (individual, do pedido, ou o zip de aprovados) refazia o
 * mesmo trabalho, e "gerar todas as artes de hoje" não tinha como rodar em segundo
 * plano pro operador só voltar depois pra baixar.
 *
 * `cache_key` é o que decide se a arte guardada ainda vale: junta `order_pieces.
 * updated_at` (muda em QUALQUER edição — cor/emoji/molde/tipo/tamanho, ver
 * `updatePiece`) com o `updated_at` de cada `piece_images` (muda toda vez que a foto
 * composta é resalva, ver PUT /ajuste). Se qualquer um mudou desde que a arte foi
 * gerada, a chave não bate mais e a arte é refeita — SEM precisar caçar e invalidar
 * manualmente em cada rota que mexe em peça/foto (frágil, fácil esquecer uma).
 *
 * Expira em `expira_em` (gerado_em + 10 dias) OU quando o pedido correspondente vira
 * "Concluído" (status interno do SHIPPED da Shopee) — o que vier primeiro; ver
 * `limparArtesExpiradas` em routes/picker.ts, rodada por um setInterval em index.ts.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS piece_arte_cache (
    piece_id INTEGER PRIMARY KEY,
    cache_key TEXT NOT NULL,
    jpg_path TEXT NOT NULL,
    gerado_em INTEGER NOT NULL,
    expira_em INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_piece_arte_cache_expira ON piece_arte_cache (expira_em);
`)

export function nowMs(): number {
  return Date.now()
}
