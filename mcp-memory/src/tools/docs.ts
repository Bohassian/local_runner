import type { DocsDb } from '../store/docs.js';
import type { EmbedClient } from '../embed/ollama.js';
import { searchDocs } from '../search.js';

// Phase 2.5 docs tools over the docs store (data/docs.db): list_docs,
// search_docs, lookup_symbol, read_doc. Descriptions are directive on
// purpose: local models under-call retrieval unless told when to use it.

export interface DocsDeps {
  db: DocsDb;
  embed: EmbedClient;
}

type ToolResult = { content: Array<{ type: 'text'; text: string }> };

const text = (t: string): ToolResult => ({ content: [{ type: 'text', text: t }] });

interface SourceRow {
  id: string;
  name: string;
  version: string | null;
  description: string | null;
  page_count: number;
  chunk_count: number;
  symbol_count: number;
}

function sourceIds(db: DocsDb): string[] {
  return db
    .prepare<[], { id: string }>(`SELECT id FROM sources ORDER BY id`)
    .all()
    .map((r) => r.id);
}

// Tool definitions are built per request so `source` enums track whatever
// is currently ingested.
export function docsToolDefinitions(db: DocsDb) {
  const ids = sourceIds(db);
  const source = {
    type: 'string',
    description: 'Limit to one docs source (see list_docs). Omit to search all.',
    ...(ids.length > 0 ? { enum: ids } : {}),
  };

  return [
    {
      name: 'list_docs',
      description:
        'List the local documentation sources available to search_docs, ' +
        'lookup_symbol and read_doc, with what each covers and its version.',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'search_docs',
      description:
        'Search local documentation (guides, manuals and API references; see ' +
        'list_docs). Combines keyword and semantic search, so both "how do I ' +
        '..." questions and exact API names work. CALL THIS BEFORE writing code ' +
        'against an API these docs cover, and before making claims about its ' +
        'behavior. Prefer it over guessing names or signatures.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'A question, or API names, e.g. "move_and_slide floor detection".',
          },
          source,
          k: {
            type: 'integer',
            description: 'How many results to return. Default 5, max 20.',
            default: 5,
            minimum: 1,
            maximum: 20,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'lookup_symbol',
      description:
        'Look up an API symbol by name and return its reference entry ' +
        '(signature and description). Accepts "Class.member" (e.g. ' +
        '"CharacterBody2D.move_and_slide"), a bare member ("move_and_slide"), ' +
        'or a class name ("Node2D", which also lists its members). Use it to ' +
        'confirm exact names and signatures before using them.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Symbol name, e.g. "Tween.tween_property".' },
          source,
        },
        required: ['name'],
      },
    },
    {
      name: 'read_doc',
      description:
        'Read a whole documentation page (or one section of it) found via ' +
        'search_docs or lookup_symbol, when a result is cut off or more ' +
        'context is needed. Long pages are truncated with an outline.',
      inputSchema: {
        type: 'object',
        properties: {
          source: { ...source, description: 'The source of the page (from a search result).' },
          path: { type: 'string', description: 'Page path, as shown in a search result.' },
          section: {
            type: 'string',
            description: 'Optional: only return sections whose heading contains this text.',
          },
        },
        required: ['source', 'path'],
      },
    },
  ];
}

export const DOCS_TOOL_NAMES = new Set(['list_docs', 'search_docs', 'lookup_symbol', 'read_doc']);

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const optSource = (v: unknown) => str(v) || undefined;

function handleListDocs(db: DocsDb): ToolResult {
  const rows = db
    .prepare<[], SourceRow>(
      `SELECT id, name, version, description, page_count, chunk_count, symbol_count
         FROM sources ORDER BY id`,
    )
    .all();
  if (rows.length === 0) return text('No docs sources are ingested yet.');
  return text(
    rows
      .map((r) => {
        const version = r.version ? ` (${r.version})` : '';
        const symbols = r.symbol_count ? `, ${r.symbol_count} symbols` : '';
        return `- ${r.id}: ${r.name}${version}. ${r.description ?? ''} [${r.page_count} pages${symbols}]`;
      })
      .join('\n'),
  );
}

async function handleSearchDocs(deps: DocsDeps, args: Record<string, unknown>): Promise<ToolResult> {
  const query = str(args.query);
  if (!query) throw new Error('`query` must be a non-empty string');
  const kRaw = typeof args.k === 'number' ? args.k : 5;
  const k = Math.max(1, Math.min(20, Math.floor(kRaw)));
  const source = optSource(args.source);

  const results = await searchDocs(deps.db, deps.embed, query, { k, source });
  if (results.length === 0) {
    return text(`No matches for "${query}"${source ? ` in ${source}` : ''}. Try other wording, or list_docs to see what is indexed.`);
  }
  return text(
    results
      .map(
        (r, i) =>
          `### ${i + 1}. ${r.heading ?? r.title ?? r.path}\n` +
          `source: ${r.source} | path: ${r.path}\n\n${r.text}`,
      )
      .join('\n\n---\n\n'),
  );
}

const MEMBERS_PER_KIND = 60;

interface SymbolRow {
  name: string;
  kind: string;
  source: string;
  path: string;
  chunk_id: number | null;
}

function handleLookupSymbol(db: DocsDb, args: Record<string, unknown>): ToolResult {
  const name = str(args.name).replace(/\(\)$/, '');
  if (!name) throw new Error('`name` must be a non-empty string');
  const source = optSource(args.source);
  const lc = name.toLowerCase();
  const filter = source ? ' AND s.source = @source' : '';
  const params = { lc, ...(source ? { source } : {}) };
  const select = `SELECT s.name, s.kind, s.source, p.path, s.chunk_id
                    FROM symbols s JOIN pages p ON p.id = s.page_id`;

  let rows = db.prepare<typeof params, SymbolRow>(`${select} WHERE s.name_lc = @lc${filter}`).all(params);
  if (rows.length === 0) {
    rows = db
      .prepare<typeof params, SymbolRow>(`${select} WHERE s.member_lc = @lc${filter} ORDER BY s.name LIMIT 50`)
      .all(params);
  }
  if (rows.length === 0) {
    // Prefix of the full name ("tween.tween_") or of the member ("tween_prop").
    const prefix = db
      .prepare<typeof params, SymbolRow>(
        `${select}
          WHERE (s.name_lc LIKE @lc || '%' ESCAPE '\\' OR s.member_lc LIKE @lc || '%' ESCAPE '\\')${filter}
          ORDER BY length(s.name) LIMIT 20`,
      )
      .all({ ...params, lc: lc.replace(/[\\%_]/g, '\\$&') });
    if (prefix.length === 0) {
      return text(`No symbol named "${name}". Try search_docs with a description of what you need.`);
    }
    return text(
      `No exact match for "${name}". Symbols starting with it:\n` +
        prefix.map((r) => `- ${r.name} (${r.kind}, ${r.source})`).join('\n'),
    );
  }

  // A bare member name can match many classes (e.g. "play"): list them
  // rather than dumping every entry.
  if (rows.length > 3) {
    return text(
      `"${name}" matches ${rows.length} symbols. Call lookup_symbol again with the full name:\n` +
        rows.map((r) => `- ${r.name} (${r.kind}, ${r.source})`).join('\n'),
    );
  }

  const chunk = db.prepare<[number], { text: string }>(`SELECT text FROM chunks WHERE id = ?`);
  const members = db.prepare<{ prefix: string; source: string }, { name: string; kind: string }>(
    `SELECT name, kind FROM symbols
      WHERE source = @source AND name_lc LIKE @prefix ESCAPE '\\' ORDER BY kind, name`,
  );

  return text(
    rows
      .map((r) => {
        const body = r.chunk_id != null ? chunk.get(r.chunk_id)?.text ?? '' : '';
        let out = `### ${r.name} (${r.kind})\nsource: ${r.source} | path: ${r.path}\n\n${body}`;
        if (r.kind === 'class') {
          const prefix = `${r.name.toLowerCase().replace(/[\\%_]/g, '\\$&')}.%`;
          const list = members.all({ prefix, source: r.source });
          if (list.length > 0) {
            const byKind = new Map<string, string[]>();
            for (const m of list) {
              const short = m.name.slice(r.name.length + 1);
              byKind.set(m.kind, [...(byKind.get(m.kind) ?? []), short]);
            }
            // Capped per kind: @GlobalScope alone has hundreds of constants.
            const shown = (names: string[]) =>
              names.length <= MEMBERS_PER_KIND
                ? names.join(', ')
                : `${names.slice(0, MEMBERS_PER_KIND).join(', ')}, ... (+${names.length - MEMBERS_PER_KIND} more)`;
            out +=
              `\n\nMembers (own only; see "Inherits" above for parent classes):\n` +
              [...byKind].map(([kind, names]) => `- ${kind}: ${shown(names)}`).join('\n');
          }
        }
        return out;
      })
      .join('\n\n---\n\n'),
  );
}

const READ_LIMIT = 16_000;

function handleReadDoc(db: DocsDb, args: Record<string, unknown>): ToolResult {
  const source = str(args.source);
  const path = str(args.path);
  const section = str(args.section).toLowerCase();
  if (!source || !path) throw new Error('`source` and `path` are required');

  const page = db
    .prepare<[string, string], { id: number; title: string | null; body: string }>(
      `SELECT id, title, body FROM pages WHERE source = ? AND path = ?`,
    )
    .get(source, path);
  if (!page) return text(`No page "${path}" in ${source}. Use a path from a search_docs result.`);

  const chunks = db
    .prepare<[number], { heading: string | null; text: string }>(
      `SELECT heading, text FROM chunks WHERE page_id = ? ORDER BY id`,
    )
    .all(page.id);
  const headings = [...new Set(chunks.map((c) => c.heading ?? ''))].filter(Boolean);

  let body: string;
  if (section) {
    const matching = chunks.filter((c) => (c.heading ?? '').toLowerCase().includes(section));
    if (matching.length === 0) {
      return text(`No section matching "${args.section}" in ${path}. Sections:\n${headings.map((h) => `- ${h}`).join('\n')}`);
    }
    body = matching.map((c) => `## ${c.heading}\n\n${c.text}`).join('\n\n');
  } else {
    body = page.body;
  }

  const header = `# ${page.title ?? path}\nsource: ${source} | path: ${path}\n\n`;
  if (body.length <= READ_LIMIT) return text(header + body);
  return text(
    header +
      body.slice(0, READ_LIMIT) +
      `\n\n[Truncated at ${READ_LIMIT} of ${body.length} chars. Read one section with the ` +
      `\`section\` argument. Sections:\n${headings.map((h) => `- ${h}`).join('\n')}]`,
  );
}

export async function handleDocsTool(
  deps: DocsDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case 'list_docs':
      return handleListDocs(deps.db);
    case 'search_docs':
      return handleSearchDocs(deps, args);
    case 'lookup_symbol':
      return handleLookupSymbol(deps.db, args);
    case 'read_doc':
      return handleReadDoc(deps.db, args);
    default:
      throw new Error(`Unknown docs tool: ${name}`);
  }
}
