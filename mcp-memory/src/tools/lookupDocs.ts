import type { DocsDb } from '../store/db.js';
import { embeddingToBuffer } from '../store/db.js';
import type { EmbedClient } from '../embed/ollama.js';

export interface LookupDocsDeps {
  db: DocsDb;
  embed: EmbedClient;
}

export const lookupDocsToolDefinition = {
  name: 'lookup_docs',
  // Description is directive on purpose: small local models tend to under-call
  // retrieval tools unless told plainly when to use them.
  description:
    'Retrieve relevant local-doc chunks (Godot 4 manual + tutorials, curated ' +
    'reference notes) by semantic similarity. CALL THIS BEFORE writing ' +
    'GDScript, before referencing any Godot engine class, node, method, ' +
    'signal, or property, or whenever you are about to make a claim about ' +
    'Godot APIs or behavior. Returns the top-k matching chunks with their ' +
    'source. Prefer calling this over guessing API names or signatures.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural-language description of what you need to know.',
      },
      k: {
        type: 'integer',
        description: 'How many chunks to return. Default 5, max 20.',
        default: 5,
        minimum: 1,
        maximum: 20,
      },
    },
    required: ['query'],
  },
} as const;

interface LookupRow {
  distance: number;
  source: string;
  chunk: string;
  metadata: string | null;
}

export async function handleLookupDocs(
  deps: LookupDocsDeps,
  args: { query?: unknown; k?: unknown },
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) throw new Error('`query` must be a non-empty string');

  const kRaw = typeof args.k === 'number' ? args.k : 5;
  const k = Math.max(1, Math.min(20, Math.floor(kRaw)));

  const vec = await deps.embed.embed(query);
  const stmt = deps.db.prepare<[Buffer, number], LookupRow>(
    `SELECT distance, source, chunk, metadata
       FROM docs
      WHERE embedding MATCH ?
        AND k = ?
      ORDER BY distance`,
  );
  const rows = stmt.all(embeddingToBuffer(vec), k);

  if (rows.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `No matches for query: "${query}". The docs index may be empty — run the ingest scripts.`,
        },
      ],
    };
  }

  const formatted = rows
    .map((row, i) => {
      const meta = row.metadata ? ` ${row.metadata}` : '';
      const score = row.distance.toFixed(4);
      return `### Result ${i + 1} (source: ${row.source}${meta}, distance: ${score})\n\n${row.chunk}`;
    })
    .join('\n\n---\n\n');

  return { content: [{ type: 'text', text: formatted }] };
}
