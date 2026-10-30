import fs from 'node:fs';
import path from 'node:path';
import { env } from './util/env.js';
import { openStore, deleteSource, embeddingToBuffer, EMBEDDING_DIM } from './util/store.js';
import { createEmbedClient } from './util/embed.js';
import { chunkText } from './util/chunk.js';
import { embeddingText, embedWithFallback } from './util/embedding.js';
import type { Page, Reader } from './readers/types.js';
import { readRst } from './readers/rst.js';
import { readGodotClassRef } from './readers/godot-classref.js';
import { readMarkdown } from './readers/markdown.js';
import { readDevDocs } from './readers/devdocs.js';

// Ingests sources from ingest/sources.json into the docs store (data/docs.db).
//
//   yarn ingest godot-manual godot-api   # specific sources
//   yarn ingest --all
//
// Each run replaces the source's rows entirely. Reads local files only.

interface SourceConfig {
  id: string;
  name: string;
  version: string;
  description: string;
  format: string;
  // Directory under data/.
  path: string;
  // Path prefixes (relative to `path`) to include; omitted or "" includes
  // everything.
  include?: string[];
}

// File readers turn one file into a page; bundle readers read a whole source
// directory at once (DevDocs ships a single db.json).
const READERS: Record<string, { reader: Reader; ext: RegExp } | { bundle: (root: string) => Page[] }> = {
  rst: { reader: readRst, ext: /\.rst$/ },
  'godot-classref': { reader: readGodotClassRef, ext: /\.rst$/ },
  markdown: { reader: readMarkdown, ext: /\.(md|mdx|markdown|txt)$/i },
  devdocs: { bundle: readDevDocs },
};

const BATCH_SIZE = 32;

// nomic-embed-text v1.5 is trained with task prefixes; queries use
// `search_query: ` (see search.ts).
const DOC_PREFIX = 'search_document: ';

function listFiles(root: string, ext: RegExp): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && ext.test(e.name)) out.push(full);
    }
  }
  return out.sort();
}

// A DevDocs bundle's release (from the meta.json fetch-docs writes), so the
// version shown by list_docs is the one actually downloaded.
function bundleVersion(root: string): string | undefined {
  const meta = path.join(root, 'meta.json');
  if (!fs.existsSync(meta)) return undefined;
  return (JSON.parse(fs.readFileSync(meta, 'utf8')) as { release?: string }).release;
}

interface PendingChunk {
  pageIndex: number;
  heading: string;
  anchor?: string;
  text: string;
}

async function ingest(src: SourceConfig) {
  const fmt = READERS[src.format];
  if (!fmt) throw new Error(`[${src.id}] unknown format: ${src.format}`);
  const root = path.join(env.repoRoot, 'data', src.path);
  if (!fs.existsSync(root)) {
    console.warn(`[${src.id}] ${root} not found, skipping`);
    return;
  }

  const inScope = (rel: string) => (src.include ?? ['']).some((prefix) => rel.startsWith(prefix));
  let files: string[] = [];
  const pages: Page[] = [];
  if ('bundle' in fmt) {
    pages.push(...fmt.bundle(root).filter((p) => inScope(p.path)));
  } else {
    files = listFiles(root, fmt.ext).filter((f) => inScope(path.relative(root, f)));
    for (const file of files) {
      const rel = path.relative(root, file);
      const page = fmt.reader(root, rel, fs.readFileSync(file, 'utf8'));
      if (page) pages.push(page);
    }
  }

  const chunks: PendingChunk[] = [];
  pages.forEach((page, pageIndex) => {
    for (const s of page.sections) {
      for (const text of chunkText(s.text)) {
        chunks.push({ pageIndex, heading: s.heading, anchor: s.anchor, text });
      }
    }
  });
  const symbolCount = pages.reduce((n, p) => n + p.symbols.length, 0);
  console.log(
    `[${src.id}] ${'bundle' in fmt ? 'bundle' : `${files.length} files`} -> ${pages.length} pages, ${chunks.length} chunks, ${symbolCount} symbols`,
  );

  // Embed everything before touching the DB, so a failed run leaves the
  // previous copy of the source intact.
  const vectors: Buffer[] = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const vecs = await embedWithFallback(
      embed,
      batch.map((c) => `${DOC_PREFIX}${c.heading}\n\n${embeddingText(c.text)}`),
      (j) => `chunk ${i + j} (${pages[batch[j].pageIndex].path})`,
    );
    for (const v of vecs) {
      if (v.length !== EMBEDDING_DIM) {
        throw new Error(`Embedding dim mismatch: expected ${EMBEDDING_DIM}, got ${v.length}`);
      }
      vectors.push(embeddingToBuffer(v));
    }
    process.stdout.write(`\r[${src.id}] embedded ${vectors.length}/${chunks.length}`);
  }
  process.stdout.write('\n');

  deleteSource(db, src.id);
  const insertPage = db.prepare(
    `INSERT INTO pages (source, path, title, body) VALUES (?, ?, ?, ?)`,
  );
  const insertChunk = db.prepare(
    `INSERT INTO chunks (source, page_id, heading, anchor, text) VALUES (?, ?, ?, ?, ?)`,
  );
  // vec0 rejects non-integer primary keys, and better-sqlite3 binds plain
  // numbers as REAL, so the id goes in as a BigInt.
  const insertVec = db.prepare(
    `INSERT INTO chunks_vec (chunk_id, embedding, source) VALUES (?, ?, ?)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO chunks_fts (rowid, heading, text, source) VALUES (?, ?, ?, ?)`,
  );
  const insertSymbol = db.prepare(
    `INSERT INTO symbols (source, name, name_lc, member_lc, kind, page_id, chunk_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSource = db.prepare(
    `INSERT INTO sources (id, name, version, description, format, page_count, chunk_count, symbol_count, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    const pageIds = pages.map(
      (p) => Number(insertPage.run(src.id, p.path, p.title, p.body).lastInsertRowid),
    );
    // First chunk of each anchored section, so a symbol points at the start
    // of its documentation.
    const anchorChunk = new Map<string, number>();
    chunks.forEach((c, i) => {
      const pageId = pageIds[c.pageIndex];
      const id = Number(
        insertChunk.run(src.id, pageId, c.heading, c.anchor ?? null, c.text).lastInsertRowid,
      );
      insertVec.run(BigInt(id), vectors[i], src.id);
      insertFts.run(id, c.heading, c.text, src.id);
      const key = `${c.pageIndex}#${c.anchor}`;
      if (c.anchor && !anchorChunk.has(key)) anchorChunk.set(key, id);
    });
    pages.forEach((p, pageIndex) => {
      for (const s of p.symbols) {
        insertSymbol.run(
          src.id,
          s.name,
          s.name.toLowerCase(),
          s.member?.toLowerCase() ?? null,
          s.kind,
          pageIds[pageIndex],
          anchorChunk.get(`${pageIndex}#${s.anchor}`) ?? null,
        );
      }
    });
    insertSource.run(
      src.id,
      src.name,
      bundleVersion(root) ?? src.version,
      src.description,
      src.format,
      pages.length,
      chunks.length,
      symbolCount,
      new Date().toISOString(),
    );
  })();
  console.log(`[${src.id}] done`);
}

const config = JSON.parse(
  fs.readFileSync(path.join(env.repoRoot, 'ingest', 'sources.json'), 'utf8'),
) as { sources: SourceConfig[] };

const args = process.argv.slice(2);
const selected = args.includes('--all')
  ? config.sources
  : args.map((id) => {
      const s = config.sources.find((c) => c.id === id);
      if (!s) throw new Error(`Unknown source "${id}". Known: ${config.sources.map((c) => c.id).join(', ')}`);
      return s;
    });
if (selected.length === 0) {
  console.error(`Usage: yarn ingest <source-id>... | --all\nSources: ${config.sources.map((c) => c.id).join(', ')}`);
  process.exit(1);
}

const db = openStore(env.docsDbPath);
const embed = createEmbedClient({ baseUrl: env.embedBaseUrl, model: env.embedModel });
try {
  for (const src of selected) await ingest(src);
} finally {
  db.close();
}
