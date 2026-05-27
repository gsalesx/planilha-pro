import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

import { env } from './env.js'

mkdirSync(env.dataDir, { recursive: true })
mkdirSync(path.join(env.dataDir, 'images'), { recursive: true })

const dbPath = path.join(env.dataDir, 'planilha.db')
export const db = new Database(dbPath)

db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS workbook_meta (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL DEFAULT 'Relatórios',
    updated_at INTEGER NOT NULL DEFAULT 0,
    column_widths TEXT NOT NULL DEFAULT '{}'
  );

  INSERT OR IGNORE INTO workbook_meta (id, name, updated_at) VALUES (1, 'Relatórios', 0);

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    row_json TEXT NOT NULL,
    styles_json TEXT NOT NULL DEFAULT '{}',
    disappeared INTEGER NOT NULL DEFAULT 0,
    position INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_orders_position ON orders (position);
  CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON orders (updated_at);

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

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions (expires_at);
`)

export function nowMs(): number {
  return Date.now()
}
