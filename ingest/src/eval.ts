import fs from 'node:fs';
import path from 'node:path';
import { env } from './util/env.js';
import { openStore } from './util/store.js';
import { searchDocs, type SearchMode } from './util/search.js';
import { createEmbedClient } from './util/embed.js';

// Retrieval eval: for each query in ingest/eval/<set>.json, does any of the
// top-k results come from one of the expected pages? Reports hit@k overall and
// per query kind, plus the misses, so retrieval changes can be compared on
// numbers rather than impressions.
//
//   yarn eval                    # godot set, k=5, every mode
//   yarn eval godot 5 hybrid     # one mode: vector | fts | hybrid

interface EvalQuery {
  kind: string;
  query: string;
  pages: string[];
  symbol?: string;
}

const MODES: SearchMode[] = ['vector', 'fts', 'hybrid'];

const set = process.argv[2] ?? 'godot';
const k = Number.parseInt(process.argv[3] ?? '5', 10);
const modes = process.argv[4] ? [process.argv[4] as SearchMode] : MODES;

const evalPath = path.join(env.repoRoot, 'ingest', 'eval', `${set}.json`);
const { queries } = JSON.parse(fs.readFileSync(evalPath, 'utf8')) as {
  queries: EvalQuery[];
};

const embed = createEmbedClient({ baseUrl: env.embedBaseUrl, model: env.embedModel });

const store = openStore(env.docsDbPath);
const pct = (h: number, t: number) => `${h}/${t} (${Math.round((100 * h) / t)}%)`;

for (const mode of modes) {
  const byKind = new Map<string, { hits: number; total: number }>();
  const misses: string[] = [];

  for (const q of queries) {
    const got = (await searchDocs(store, embed, q.query, { k, mode })).map((r) => r.path);
    const hit = got.some((p) => q.pages.includes(p));
    const tally = byKind.get(q.kind) ?? { hits: 0, total: 0 };
    tally.total++;
    if (hit) tally.hits++;
    byKind.set(q.kind, tally);
    if (!hit) misses.push(`  [${q.kind}] ${q.query}\n      got: ${[...new Set(got)].join(', ')}`);
  }

  const all = [...byKind.values()].reduce(
    (a, b) => ({ hits: a.hits + b.hits, total: a.total + b.total }),
    { hits: 0, total: 0 },
  );
  console.log(`\n== ${mode}: hit@${k}`);
  for (const [kind, t] of byKind) console.log(`  ${kind.padEnd(8)} ${pct(t.hits, t.total)}`);
  console.log(`  ${'all'.padEnd(8)} ${pct(all.hits, all.total)}`);
  if (misses.length) console.log(`  misses:\n${misses.join('\n')}`);
}

store.close();
