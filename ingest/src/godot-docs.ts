import fs from 'node:fs';
import path from 'node:path';
import { env } from './util/env.js';
import { openDb } from './util/db.js';
import { createEmbedClient } from './util/embed.js';
import { chunkText } from './util/chunk.js';
import { ingestSource, type Chunk } from './util/ingest.js';

// Expected layout: user runs
//   git clone https://github.com/godotengine/godot-docs ./data/godot-docs
// once, then re-pulls when they want fresher docs. We read RST files directly;
// no live network access during ingest.
const DOCS_DIR = path.join(env.repoRoot, 'data', 'godot-docs');

// Manual + tutorials slice only — class reference is intentionally excluded
// (large, repetitive, and contributes a lot of vectors for relatively little
// per-query value). Revisit if retrieval starts missing class-API questions.
const INGEST_SUBDIRS = ['getting_started', 'tutorials'];

const SOURCE = 'godot-docs';

function findRstFiles(root: string): string[] {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith('.rst')) out.push(full);
    }
  }
  return out;
}

function deriveTitle(rst: string, fallback: string): string {
  // RST page title: first non-blank line followed by an underline of = or # or *.
  const lines = rst.split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i].trim();
    const under = lines[i + 1];
    if (!line || !under) continue;
    if (/^[=#*]{3,}\s*$/.test(under) && under.trim().length >= line.length - 2) {
      return line;
    }
  }
  return fallback;
}

async function main() {
  if (!fs.existsSync(DOCS_DIR)) {
    console.error(
      `godot-docs not found at ${DOCS_DIR}.\n` +
        `Clone it once:\n` +
        `  git clone https://github.com/godotengine/godot-docs ${DOCS_DIR}`,
    );
    process.exit(1);
  }

  const allChunks: Chunk[] = [];

  for (const sub of INGEST_SUBDIRS) {
    const subPath = path.join(DOCS_DIR, sub);
    if (!fs.existsSync(subPath)) {
      console.warn(`skipping missing subdir: ${sub}`);
      continue;
    }
    const files = findRstFiles(subPath);
    console.log(`[${sub}] ${files.length} .rst files`);
    for (const file of files) {
      const rel = path.relative(DOCS_DIR, file);
      const content = fs.readFileSync(file, 'utf8');
      const title = deriveTitle(content, rel);
      // Prepend a small header so each chunk carries its origin into the
      // embedding — improves retrievability for "where does X live" queries
      // and gives the model a citation hook in the returned text.
      const pieces = chunkText(content).map((c) => `# ${title} (${rel})\n\n${c}`);
      for (const piece of pieces) {
        allChunks.push({ chunk: piece, metadata: { path: rel, title } });
      }
    }
  }

  console.log(`total chunks: ${allChunks.length}`);

  const db = openDb(env.dbPath);
  const embed = createEmbedClient({
    baseUrl: env.embedBaseUrl,
    model: env.embedModel,
  });
  try {
    const { inserted } = await ingestSource(db, embed, SOURCE, allChunks);
    console.log(`done. inserted ${inserted} chunks into ${env.dbPath}`);
  } finally {
    db.close();
  }
}

await main();
