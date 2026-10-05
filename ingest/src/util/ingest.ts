import type { DocsDb } from './db.js';
import { EMBEDDING_DIM, embeddingToBuffer } from './db.js';
import type { EmbedClient } from './embed.js';

export interface Chunk {
  chunk: string;
  metadata?: Record<string, unknown>;
}

const BATCH_SIZE = 32;

// Text sent to the embedding model (the stored chunk keeps the original).
// RST grid tables and section underlines are long runs of -, =, +, | that
// tokenize to roughly one token per character: a 4k-char table blew past
// nomic-embed-text's 2048-token context. They carry no meaning, so collapse
// them and squeeze whitespace before embedding.
function embeddingText(chunk: string): string {
  return chunk
    .replace(/[-=+|~^*#_]{3,}/g, ' ')
    .replace(/[ \t]*\|[ \t]*/g, ' | ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function isContextLengthError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('exceeds the context length');
}

// Embed a batch; if Ollama rejects it for length, fall back to one-by-one and
// halve any single input that still doesn't fit. Logs each truncation so it's
// visible rather than silent.
async function embedWithFallback(
  embed: EmbedClient,
  texts: string[],
  label: (j: number) => string,
): Promise<number[][]> {
  try {
    return await embed.embedBatch(texts);
  } catch (err) {
    if (!isContextLengthError(err)) throw err;
  }
  const out: number[][] = [];
  for (let j = 0; j < texts.length; j++) {
    let text = texts[j];
    for (;;) {
      try {
        out.push((await embed.embedBatch([text]))[0]);
        break;
      } catch (err) {
        if (!isContextLengthError(err) || text.length < 200) throw err;
        text = text.slice(0, Math.floor(text.length / 2));
        process.stdout.write(
          `\n[warn] ${label(j)} too long to embed; truncated embedding input to ${text.length} chars\n`,
        );
      }
    }
  }
  return out;
}

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
    const vectors = await embedWithFallback(
      embed,
      batch.map((c) => embeddingText(c.chunk)),
      (j) => `chunk ${i + j} (${String(batch[j].metadata?.path ?? '?')})`,
    );
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
