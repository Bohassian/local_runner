// Mirror of mcp-memory/src/embed/ollama.ts. Kept duplicated rather than shared
// across packages — the ingest package stays standalone (no workspace setup).

export interface EmbedClient {
  embedBatch(texts: string[]): Promise<number[][]>;
}

export function createEmbedClient(opts: {
  baseUrl: string;
  model: string;
}): EmbedClient {
  const url = `${opts.baseUrl.replace(/\/$/, '')}/api/embed`;
  return {
    async embedBatch(texts) {
      if (texts.length === 0) return [];
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: opts.model, input: texts }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '<unreadable>');
        throw new Error(
          `Ollama embed failed: ${res.status} ${res.statusText} — ${body}`,
        );
      }
      const data = (await res.json()) as { embeddings?: number[][] };
      if (!data.embeddings || data.embeddings.length !== texts.length) {
        throw new Error(
          `Ollama embed returned ${data.embeddings?.length ?? 0} vectors for ${texts.length} inputs`,
        );
      }
      return data.embeddings;
    },
  };
}
