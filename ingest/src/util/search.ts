import type { DocsDb } from './store.js';
import { embeddingToBuffer } from './store.js';
import type { EmbedClient } from './embed.js';

// Hybrid docs search (phase 2.5). Mirrored in mcp-memory/src/search.ts; keep
// the two in sync so `yarn eval` measures what the server does.
//
// Three ranked candidate lists, merged with reciprocal rank fusion:
//   - vector: nomic-embed-text KNN, good for "how do I ..." questions
//   - fts:    SQLite FTS5 BM25 over heading + text, good for exact words
//   - symbol: identifiers in the query matched against the symbol table, so
//             `move_and_slide` or `Node2D global_position` land on the API entry

export type SearchMode = 'vector' | 'fts' | 'hybrid';

export interface SearchResult {
  chunkId: number;
  source: string;
  path: string;
  title: string | null;
  heading: string | null;
  anchor: string | null;
  text: string;
  score: number;
}

const CANDIDATES = 50;
const MAX_PER_PAGE = 2;
const RRF_K = 60;
const QUERY_PREFIX = 'search_query: ';

const STOPWORDS = new Set(
  'a an and are as at be by can do does for from how i in is it me my of on or should so that the this to use using what when where which why with you'.split(
    ' ',
  ),
);

// Words in the query, keeping identifier characters (_ . @) together.
function queryTerms(query: string): string[] {
  return (query.match(/[\p{L}\p{N}_.@]+/gu) ?? [])
    .map((t) => t.replace(/^[.]+|[.()]+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t.toLowerCase()));
}

// Each term as a quoted phrase, ORed. Quoting stops FTS5 from reading query
// text as syntax, and keeps `queue_free` matching as adjacent tokens.
function ftsQuery(terms: string[]): string | null {
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

function sourceFilter(column: string, source?: string): string {
  return source ? ` AND ${column} = @source` : '';
}

function vectorIds(db: DocsDb, vec: number[], source?: string): number[] {
  return db
    .prepare<{ vec: Buffer; k: number; source?: string }, { chunk_id: number }>(
      `SELECT chunk_id FROM chunks_vec
        WHERE embedding MATCH @vec AND k = @k${sourceFilter('source', source)}
        ORDER BY distance`,
    )
    .all({ vec: embeddingToBuffer(vec), k: CANDIDATES, ...(source ? { source } : {}) })
    .map((r) => Number(r.chunk_id));
}

function ftsIds(db: DocsDb, terms: string[], source?: string): number[] {
  const match = ftsQuery(terms);
  if (!match) return [];
  // Heading matches weigh 10x body matches; the source column isn't indexed.
  return db
    .prepare<{ match: string; k: number; source?: string }, { rowid: number }>(
      `SELECT rowid FROM chunks_fts
        WHERE chunks_fts MATCH @match${sourceFilter('source', source)}
        ORDER BY bm25(chunks_fts, 10.0, 1.0, 0.0)
        LIMIT @k`,
    )
    .all({ match, k: CANDIDATES, ...(source ? { source } : {}) })
    .map((r) => r.rowid);
}

// Terms that look like code: snake_case, dotted, or containing a capital or
// digit past the first letter (Node2D, CharacterBody2D). Plain English words
// ("pause", "play") also name members, and matching them swamps
// natural-language questions with unrelated API entries.
function looksLikeIdentifier(term: string): boolean {
  return /[_.@]/.test(term) || /^.+[A-Z0-9]/.test(term) || /^[A-Z][a-z]+$/.test(term);
}

// Exact `Class.member` names first (from dotted terms, adjacent term pairs, or
// a plain-word class name paired with another query word), then class names,
// then bare member names.
function symbolIds(db: DocsDb, terms: string[], source?: string): number[] {
  const lc = terms.filter(looksLikeIdentifier).map((t) => t.toLowerCase());
  const full = new Set(lc.filter((t) => t.includes('.')));
  for (let i = 0; i + 1 < lc.length; i++) full.add(`${lc[i]}.${lc[i + 1]}`);
  const bare = new Set(lc.flatMap((t) => t.split('.')).filter((t) => t.length > 1));

  const byName = db.prepare<{ name: string; source?: string }, { chunk_id: number }>(
    `SELECT chunk_id FROM symbols
      WHERE name_lc = @name AND chunk_id IS NOT NULL${sourceFilter('source', source)}`,
  );
  const isClass = db.prepare<{ name: string; source?: string }, { chunk_id: number }>(
    `SELECT chunk_id FROM symbols
      WHERE name_lc = @name AND kind = 'class' AND chunk_id IS NOT NULL${sourceFilter('source', source)}`,
  );

  // Plain words that name a class ("label", "button") count too, but only as
  // classes: "text of a label" means Label, plus Label.text when another word
  // in the query names one of its members. Bare plain words are still kept out
  // of member matching (see looksLikeIdentifier).
  const plain = terms.map((t) => t.toLowerCase()).filter((t) => !lc.includes(t));
  const classWords = plain.filter(
    (t) => isClass.get({ name: t, ...(source ? { source } : {}) }) !== undefined,
  );
  for (const cls of classWords) {
    for (const other of plain) if (other !== cls) full.add(`${cls}.${other}`);
  }
  const byMember = db.prepare<{ name: string; source?: string }, { chunk_id: number }>(
    `SELECT chunk_id FROM symbols
      WHERE member_lc = @name AND chunk_id IS NOT NULL${sourceFilter('source', source)}
      LIMIT 20`,
  );
  const params = (name: string) => ({ name, ...(source ? { source } : {}) });

  const ids: number[] = [];
  for (const name of full) ids.push(...byName.all(params(name)).map((r) => r.chunk_id));
  for (const name of classWords) ids.push(...isClass.all(params(name)).map((r) => r.chunk_id));
  for (const name of bare) {
    ids.push(...byName.all(params(name)).map((r) => r.chunk_id));
    ids.push(...byMember.all(params(name)).map((r) => r.chunk_id));
  }
  return [...new Set(ids)].slice(0, CANDIDATES);
}

function fuse(lists: number[][]): Map<number, number> {
  const scores = new Map<number, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + rank + 1)));
  }
  return scores;
}

export async function searchDocs(
  db: DocsDb,
  embed: EmbedClient,
  query: string,
  opts: { k?: number; source?: string; mode?: SearchMode } = {},
): Promise<SearchResult[]> {
  const { k = 5, source, mode = 'hybrid' } = opts;
  const terms = queryTerms(query);

  const lists: number[][] = [];
  if (mode !== 'fts') {
    const [vec] = await embed.embedBatch([`${QUERY_PREFIX}${query}`]);
    lists.push(vectorIds(db, vec, source));
  }
  if (mode !== 'vector') {
    lists.push(ftsIds(db, terms, source));
    lists.push(symbolIds(db, terms, source));
  }

  const row = db.prepare<
    [number],
    Omit<SearchResult, 'score' | 'chunkId'> & { chunkId: number; pageId: number }
  >(
    `SELECT c.id AS chunkId, c.page_id AS pageId, c.source, p.path, p.title, c.heading, c.anchor, c.text
       FROM chunks c JOIN pages p ON p.id = c.page_id
      WHERE c.id = ?`,
  );

  // At most MAX_PER_PAGE results from one page, so a single big page (a class
  // with hundreds of members) can't fill the whole result list.
  const results: SearchResult[] = [];
  const perPage = new Map<number, number>();
  for (const [id, score] of [...fuse(lists)].sort((a, b) => b[1] - a[1])) {
    const { pageId, ...r } = row.get(id)!;
    const n = perPage.get(pageId) ?? 0;
    if (n >= MAX_PER_PAGE) continue;
    perPage.set(pageId, n + 1);
    results.push({ ...r, score });
    if (results.length === k) break;
  }
  return results;
}
