export interface EmbedClient {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

export interface EmbedOptions {
  baseUrl: string;
  model: string;
}

export function createEmbedClient(opts: EmbedOptions): EmbedClient {
  const { baseUrl, model } = opts;
  const url = `${baseUrl.replace(/\/$/, '')}/api/embed`;

  async function call(input: string | string[]): Promise<number[][]> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '<unreadable>');
      throw new Error(`Ollama embed failed: ${res.status} ${res.statusText} — ${body}`);
    }
    const data = (await res.json()) as { embeddings?: number[][] };
    if (!data.embeddings || !Array.isArray(data.embeddings)) {
      throw new Error('Ollama embed response missing `embeddings`');
    }
    return data.embeddings;
  }

  return {
    async embed(text) {
      const [vec] = await call(text);
      if (!vec) throw new Error('Ollama embed returned no vector');
      return vec;
    },
    async embedBatch(texts) {
      if (texts.length === 0) return [];
      return call(texts);
    },
  };
}
