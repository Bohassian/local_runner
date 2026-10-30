import type { DocsDb } from './store/docs.js';
import { embeddingToBuffer } from './store/docs.js';
import type { EmbedClient } from './embed/ollama.js';

// Hybrid docs search (phase 2.5). Mirror of ingest/src/util/search.ts; keep
// the two in sync so `yarn eval` measures what the server does.
//
// Three ranked candidate lists, merged with reciprocal rank fusion:
//   - vector: nomic-embed-text KNN, good for "how do I ..." questions
//   - fts:    SQLite FTS5 BM25 over heading + text, good for exact words
//   - symbol: identifiers in the query matched against the symbol table, so
//             `move_and_slide`, `Node2D global_position` or
//             `QueryMethods where` land on the API entry

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

// Separators between an owner and a member: Godot `Node.queue_free`, Ruby
// `Array#map` (instance) and `File::exist?` (class method / namespace).
const MEMBER_SEP = /(?:#|::|\.)/;

// Words in the query, keeping identifier characters (_ . @ # :) together.
function queryTerms(query: string): string[] {
  return (query.match(/[\p{L}\p{N}_.@#:?!]+/gu) ?? [])
    .map((t) => t.replace(/^[.#:]+|[.():]+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t.toLowerCase()));
}

// Each term as a quoted phrase, ORed. Quoting stops FTS5 from reading query
// text as syntax, and keeps `queue_free` matching as adjacent tokens.
function ftsQuery(terms: string[]): string | null {
  if (terms.length === 0) return null;
  return terms.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

// SQL filter on one or more sources; binds @source0, @source1, ...
function sourceFilter(column: string, sources: string[]): string {
  if (sources.length === 0) return '';
  return ` AND ${column} IN (${sources.map((_, i) => `@source${i}`).join(', ')})`;
}
function sourceParams(sources: string[]): Record<string, string> {
  return Object.fromEntries(sources.map((s, i) => [`source${i}`, s]));
}

// KNN per source when filtering (one vec0 query each, merged by distance), so
// the filter only relies on vec0's equality support for metadata columns.
function vectorIds(db: DocsDb, vec: number[], sources: string[]): number[] {
  const knn = (source?: string) =>
    db
      .prepare<{ vec: Buffer; k: number; source?: string }, { chunk_id: number; distance: number }>(
        `SELECT chunk_id, distance FROM chunks_vec
          WHERE embedding MATCH @vec AND k = @k${source ? ' AND source = @source' : ''}
          ORDER BY distance`,
      )
      .all({ vec: embeddingToBuffer(vec), k: CANDIDATES, ...(source ? { source } : {}) });
  const rows = sources.length === 0 ? knn() : sources.flatMap((s) => knn(s));
  return rows
    .sort((a, b) => a.distance - b.distance)
    .slice(0, CANDIDATES)
    .map((r) => Number(r.chunk_id));
}

function ftsIds(db: DocsDb, terms: string[], sources: string[]): number[] {
  const match = ftsQuery(terms);
  if (!match) return [];
  // Heading matches weigh 10x body matches; the source column isn't indexed.
  return db
    .prepare<Record<string, unknown>, { rowid: number }>(
      `SELECT rowid FROM chunks_fts
        WHERE chunks_fts MATCH @match${sourceFilter('source', sources)}
        ORDER BY bm25(chunks_fts, 10.0, 1.0, 0.0)
        LIMIT @k`,
    )
    .all({ match, k: CANDIDATES, ...sourceParams(sources) })
    .map((r) => r.rowid);
}

// Terms that look like code: snake_case, dotted or namespaced, or containing a
// capital or digit past the first letter (Node2D, CharacterBody2D,
// QueryMethods). Plain English words ("pause", "play", "where") also name
// members, and matching them alone swamps natural-language questions with
// unrelated API entries.
function looksLikeIdentifier(term: string): boolean {
  return /[_.@#]|::/.test(term) || /^.+[A-Z0-9]/.test(term) || /^[A-Z][a-z]+$/.test(term);
}

// The owner part of a qualified name: `activerecord::querymethods` for
// `activerecord::querymethods#where`, `label` for `label.text`.
function ownerOf(nameLc: string): string {
  return nameLc.replace(new RegExp(`${MEMBER_SEP.source}[^#:.]+$`), '');
}

// Candidates, in order:
//   1. qualified terms matching a symbol exactly (`Tween.tween_property`,
//      `ActiveRecord::Base#save`)
//   2. members of a class named in the query, for any other query word
//      ("label" + "text" -> Label.text; "QueryMethods" + "where" ->
//      ActiveRecord::QueryMethods#where)
//   3. the classes themselves
//   4. bare identifier-like terms as a symbol or member name
// A class term matches a class's full name or its last `::` segment, so
// `QueryMethods` finds `ActiveRecord::QueryMethods`.
function symbolIds(db: DocsDb, terms: string[], sources: string[]): number[] {
  const all = terms.map((t) => t.toLowerCase());
  // A one-word query is an API name even when it's a plain word ("pluck").
  const ident = (terms.length === 1 ? terms : terms.filter(looksLikeIdentifier)).map((t) =>
    t.toLowerCase(),
  );
  const params = sourceParams(sources);
  const filter = sourceFilter('source', sources);

  const byName = db.prepare<Record<string, unknown>, { chunk_id: number }>(
    `SELECT chunk_id FROM symbols WHERE name_lc = @name AND chunk_id IS NOT NULL${filter}`,
  );
  // A word also names Godot's 2D/3D pair: "camera" -> Camera2D, Camera3D.
  const classes = db.prepare<Record<string, unknown>, { chunk_id: number; name_lc: string }>(
    `SELECT chunk_id, name_lc FROM symbols
      WHERE kind = 'class'
        AND (name_lc IN (@name, @name || '2d', @name || '3d') OR name_lc LIKE '%::' || @name)
        AND chunk_id IS NOT NULL${filter}
      LIMIT 10`,
  );
  const membersNamed = db.prepare<Record<string, unknown>, { chunk_id: number; name_lc: string }>(
    `SELECT chunk_id, name_lc FROM symbols WHERE member_lc = @name AND chunk_id IS NOT NULL${filter}`,
  );
  const byMember = db.prepare<Record<string, unknown>, { chunk_id: number }>(
    `SELECT chunk_id FROM symbols WHERE member_lc = @name AND chunk_id IS NOT NULL${filter} LIMIT 20`,
  );

  const ids: number[] = [];

  for (const t of ident.filter((t) => MEMBER_SEP.test(t))) {
    ids.push(...byName.all({ name: t, ...params }).map((r) => r.chunk_id));
  }

  const classHits = new Map<string, Array<{ chunk_id: number; name_lc: string }>>();
  for (const t of new Set(all)) {
    const hits = classes.all({ name: t, ...params });
    if (hits.length > 0) classHits.set(t, hits);
  }
  for (const [cls, hits] of classHits) {
    const owners = new Set(hits.map((h) => h.name_lc));
    for (const word of new Set(all)) {
      if (word === cls) continue;
      for (const m of membersNamed.all({ name: word, ...params })) {
        if (owners.has(ownerOf(m.name_lc))) ids.push(m.chunk_id);
      }
    }
  }
  for (const hits of classHits.values()) ids.push(...hits.map((h) => h.chunk_id));

  const bare = new Set(ident.flatMap((t) => t.split(/[.#:]+/)).filter((t) => t.length > 1));
  for (const name of bare) {
    ids.push(...byName.all({ name, ...params }).map((r) => r.chunk_id));
    ids.push(...byMember.all({ name, ...params }).map((r) => r.chunk_id));
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
  opts: { k?: number; sources?: string[]; mode?: SearchMode } = {},
): Promise<SearchResult[]> {
  const { k = 5, sources = [], mode = 'hybrid' } = opts;
  const terms = queryTerms(query);

  const lists: number[][] = [];
  if (mode !== 'fts') {
    const [vec] = await embed.embedBatch([`${QUERY_PREFIX}${query}`]);
    lists.push(vectorIds(db, vec, sources));
  }
  if (mode !== 'vector') {
    lists.push(ftsIds(db, terms, sources));
    lists.push(symbolIds(db, terms, sources));
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
