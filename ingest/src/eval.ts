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
  // Limit the search to these sources, as a project's AGENTS.md would.
  sources?: string[];
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

// Low-level/editor classes with hundreds of chunks each. With that many
// chunks on varied topics, one of them is near almost any query, so they
// crowd results. Tracked as "noise": the share of returned results from these
// pages (never expected answers in this set).
const NOISE_PAGES = new Set([
  'classes/class_renderingserver.rst',
  'classes/class_projectsettings.rst',
  'classes/class_renderingdevice.rst',
  'classes/class_displayserver.rst',
  'classes/class_editorsettings.rst',
  'classes/class_textserver.rst',
]);

const store = openStore(env.docsDbPath);
const pct = (h: number, t: number) => `${h}/${t} (${Math.round((100 * h) / t)}%)`;

interface Tally {
  hits: number;
  rr: number;
  total: number;
}
const row = (label: string, t: Tally) =>
  `  ${label.padEnd(13)} hit@${k} ${pct(t.hits, t.total).padEnd(12)} MRR ${(t.rr / t.total).toFixed(2)}`;

for (const mode of modes) {
  const byKind = new Map<string, Tally>();
  const misses: string[] = [];
  let returned = 0;
  let noise = 0;

  for (const q of queries) {
    const got = (await searchDocs(store, embed, q.query, { k, mode, sources: q.sources })).map(
      (r) => r.path,
    );
    // Reciprocal rank of the first result from an expected page (0 if none).
    const rank = got.findIndex((p) => q.pages.includes(p));
    const tally = byKind.get(q.kind) ?? { hits: 0, rr: 0, total: 0 };
    tally.total++;
    if (rank >= 0) {
      tally.hits++;
      tally.rr += 1 / (rank + 1);
    }
    byKind.set(q.kind, tally);
    returned += got.length;
    noise += got.filter((p) => NOISE_PAGES.has(p)).length;
    if (rank < 0) misses.push(`  [${q.kind}] ${q.query}\n      got: ${[...new Set(got)].join(', ')}`);
  }

  const all = [...byKind.values()].reduce(
    (a, b) => ({ hits: a.hits + b.hits, rr: a.rr + b.rr, total: a.total + b.total }),
    { hits: 0, rr: 0, total: 0 },
  );
  console.log(`\n== ${mode}`);
  for (const [kind, t] of byKind) console.log(row(kind, t));
  console.log(row('all', all));
  console.log(`  noise: ${pct(noise, returned)} of results from big settings/server classes`);
  if (misses.length) console.log(`  misses:\n${misses.join('\n')}`);
}

store.close();
