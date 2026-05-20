import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

// nomic-embed-text returns 768-dim vectors. Verified at server startup by
// embedding a probe string and comparing; mismatches throw rather than silently
// store bad vectors. Bumping the model requires updating this constant AND
// re-ingesting everything (the dim is baked into the vec0 table at create).
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
