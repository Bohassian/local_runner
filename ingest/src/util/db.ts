import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';

// Mirror of mcp-memory/src/store/db.ts. Kept in sync deliberately — both
// processes touch the same DB file, so the schema must match. If you change
// EMBEDDING_DIM or the table shape here, update the other side and re-create
// the DB (drop ./data/mcp-memory.db; re-ingest).
export const EMBEDDING_DIM = 768;

const SCHEMA_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING vec0(
  embedding float[${EMBEDDING_DIM}],
  +source TEXT,
  +chunk TEXT,
  +metadata TEXT
);
`;

export type DocsDb = Database.Database;

export function openDb(dbPath: string): DocsDb {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
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
