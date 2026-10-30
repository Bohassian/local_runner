import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

// Docs store v2 (phase 2.5). Mirror of ingest/src/util/store.ts — both
// processes open the same file, so keep the schema in sync. Changing
// EMBEDDING_DIM or a table shape means deleting the DB and re-ingesting.
export const EMBEDDING_DIM = 768;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT,
  description TEXT,
  format TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  ingested_at TEXT
);

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT,
  body TEXT NOT NULL,
  UNIQUE (source, path)
);

CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  page_id INTEGER NOT NULL,
  heading TEXT,
  anchor TEXT,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chunks_source ON chunks (source);
CREATE INDEX IF NOT EXISTS chunks_page ON chunks (page_id);

-- source is a vec0 metadata column, so KNN queries can filter on it.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[${EMBEDDING_DIM}],
  source TEXT
);

-- Rowid = chunks.id. Plain (not external-content) FTS so rows can be deleted
-- by rowid on re-ingest.
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  heading,
  text,
  source UNINDEXED,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS symbols (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  name_lc TEXT NOT NULL,
  member_lc TEXT,
  kind TEXT NOT NULL,
  page_id INTEGER NOT NULL,
  chunk_id INTEGER
);
CREATE INDEX IF NOT EXISTS symbols_name ON symbols (name_lc);
CREATE INDEX IF NOT EXISTS symbols_member ON symbols (member_lc);
`;

export type DocsDb = Database.Database;

export function openStore(dbPath: string): DocsDb {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  sqliteVec.load(db);
  db.exec(SCHEMA_SQL);
  return db;
}

export function embeddingToBuffer(embedding: number[]): Buffer {
  const f32 = new Float32Array(embedding);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
