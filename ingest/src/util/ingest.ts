import type { DocsDb } from './db.js';
import { EMBEDDING_DIM, embeddingToBuffer } from './db.js';
import type { EmbedClient } from './embed.js';

export interface Chunk {
  chunk: string;
  metadata?: Record<string, unknown>;
}

const BATCH_SIZE = 32;

export async function ingestSource(
  db: DocsDb,
  embed: EmbedClient,
  source: string,
  chunks: Chunk[],
): Promise<{ inserted: number }> {
  // Idempotent: nuke this source's existing rows so re-ingest produces a fresh,
  // de-duplicated set. Downside: there's a window where the source has zero
  // rows; acceptable for a single-user dev tool, not for a production index.
  const del = db.prepare(`DELETE FROM docs WHERE source = ?`);
  del.run(source);

  if (chunks.length === 0) return { inserted: 0 };

  const insert = db.prepare(
    `INSERT INTO docs (embedding, source, chunk, metadata) VALUES (?, ?, ?, ?)`,
  );
  const insertMany = db.transaction(
    (rows: Array<{ vec: Buffer; chunk: string; metadata: string | null }>) => {
      for (const r of rows) insert.run(r.vec, source, r.chunk, r.metadata);
    },
  );

  let inserted = 0;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vectors = await embed.embedBatch(batch.map((c) => c.chunk));
    const rows = batch.map((c, j) => {
      const v = vectors[j];
      if (!v || v.length !== EMBEDDING_DIM) {
        throw new Error(
          `Embedding dim mismatch on chunk ${i + j}: expected ${EMBEDDING_DIM}, got ${v?.length}`,
        );
      }
      return {
        vec: embeddingToBuffer(v),
        chunk: c.chunk,
        metadata: c.metadata ? JSON.stringify(c.metadata) : null,
      };
    });
    insertMany(rows);
    inserted += rows.length;
    process.stdout.write(
      `\r[${source}] embedded ${inserted}/${chunks.length} chunks`,
    );
  }
  process.stdout.write('\n');
  return { inserted };
}
