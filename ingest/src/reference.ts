import fs from 'node:fs';
import path from 'node:path';
import { env } from './util/env.js';
import { openDb } from './util/db.js';
import { createEmbedClient } from './util/embed.js';
import { chunkText } from './util/chunk.js';
import { ingestSource, type Chunk } from './util/ingest.js';

// Hand-curated markdown the user writes themselves — project conventions,
// gameplay design notes, GDScript style cheatsheets, etc. Drop .md files into
// ./data/reference/ and rerun.
const REF_DIR = path.join(env.repoRoot, 'data', 'reference');
const SOURCE = 'reference';

function findMarkdown(root: string): string[] {
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
      else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) out.push(full);
    }
  }
  return out;
}

async function main() {
  if (!fs.existsSync(REF_DIR)) {
    console.log(
      `${REF_DIR} does not exist — nothing to ingest. Create it and drop in .md files.`,
    );
    const db = openDb(env.dbPath);
    try {
      await ingestSource(db, createEmbedClient({
        baseUrl: env.embedBaseUrl,
        model: env.embedModel,
      }), SOURCE, []);
    } finally {
      db.close();
    }
    return;
  }

  const files = findMarkdown(REF_DIR);
  console.log(`[reference] ${files.length} markdown files`);

  const chunks: Chunk[] = [];
  for (const file of files) {
    const rel = path.relative(REF_DIR, file);
    const content = fs.readFileSync(file, 'utf8');
    const pieces = chunkText(content).map((c) => `# ${rel}\n\n${c}`);
    for (const piece of pieces) {
      chunks.push({ chunk: piece, metadata: { path: rel } });
    }
  }
  console.log(`total chunks: ${chunks.length}`);

  const db = openDb(env.dbPath);
  const embed = createEmbedClient({
    baseUrl: env.embedBaseUrl,
    model: env.embedModel,
  });
  try {
    const { inserted } = await ingestSource(db, embed, SOURCE, chunks);
    console.log(`done. inserted ${inserted} chunks into ${env.dbPath}`);
  } finally {
    db.close();
  }
}

await main();
