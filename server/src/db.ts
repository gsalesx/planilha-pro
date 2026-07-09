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
    updated_at INTEGER NOT NULL,
    UNIQUE (piece_id, slot),
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

// Migration idempotente: garante order_pieces.nota em DBs criados antes dessa coluna existir.
{
  const cols = db.prepare("PRAGMA table_info(order_pieces)").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'nota')) {
    db.exec("ALTER TABLE order_pieces ADD COLUMN nota TEXT NOT NULL DEFAULT ''")
  }
}

export function nowMs(): number {
  return Date.now()
}
