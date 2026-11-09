import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS portals (
  member_id      TEXT PRIMARY KEY,
  domain         TEXT NOT NULL,
  client_endpoint TEXT NOT NULL,
  access_token   TEXT,
  refresh_token  TEXT,
  expires_at     INTEGER,
  installed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS objects (
  id            INTEGER PRIMARY KEY,          -- ID элемента на newflat72.ru
  url           TEXT NOT NULL,
  category      TEXT,
  deal          TEXT,
  title         TEXT,
  address       TEXT,
  lat           REAL,
  lng           REAL,
  price         INTEGER,
  rooms         INTEGER,                      -- 0 = студия
  floor         INTEGER,
  floors        INTEGER,
  area_total    REAL,
  area_living   REAL,
  area_kitchen  REAL,
  thumb         TEXT,
  listed_at     TEXT,
  props_json    TEXT,
  detail_json   TEXT,
  detail_at     INTEGER,
  active        INTEGER NOT NULL DEFAULT 1,
  seen_at       INTEGER,
  search_text   TEXT
);
CREATE INDEX IF NOT EXISTS idx_objects_cat ON objects(category, active);
CREATE INDEX IF NOT EXISTS idx_objects_price ON objects(price);

CREATE TABLE IF NOT EXISTS selections (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  token            TEXT NOT NULL UNIQUE,
  member_id        TEXT NOT NULL,
  entity_type      TEXT NOT NULL CHECK (entity_type IN ('lead','deal')),
  entity_id        INTEGER NOT NULL,
  title            TEXT,
  message          TEXT,
  created_by_id    INTEGER,
  created_by_name  TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  first_viewed_at  TEXT,
  last_viewed_at   TEXT,
  view_count       INTEGER NOT NULL DEFAULT 0,
  submitted_at     TEXT,
  submit_count     INTEGER NOT NULL DEFAULT 0,
  archived         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sel_entity ON selections(member_id, entity_type, entity_id);

CREATE TABLE IF NOT EXISTS selection_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  selection_id   INTEGER NOT NULL REFERENCES selections(id) ON DELETE CASCADE,
  object_id      INTEGER NOT NULL,
  position       INTEGER NOT NULL DEFAULT 0,
  snapshot_json  TEXT NOT NULL,               -- данные объекта на момент отправки
  agent_note     TEXT,
  reaction       TEXT CHECK (reaction IN ('like','dislike') OR reaction IS NULL),
  reasons_json   TEXT,
  client_comment TEXT,
  want_viewing   INTEGER NOT NULL DEFAULT 0,
  reacted_at     TEXT,
  UNIQUE (selection_id, object_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`);

// Миграции: колонки, добавленные после первой версии
const selCols = db.prepare('PRAGMA table_info(selections)').all().map((c) => c.name);
if (!selCols.includes('last_activity_at')) db.exec('ALTER TABLE selections ADD COLUMN last_activity_at TEXT');
if (!selCols.includes('digest_pending')) db.exec('ALTER TABLE selections ADD COLUMN digest_pending INTEGER NOT NULL DEFAULT 0');

export function getMeta(key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}
export function setMeta(key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}
