import type { EmbedClient } from './embed.js';

// Text sent to the embedding model (the stored chunk keeps the original).
// RST grid tables and section underlines are long runs of -, =, +, | that
// tokenize to roughly one token per character: a 4k-char table blew past
// nomic-embed-text's 2048-token context. They carry no meaning, so collapse
// them and squeeze whitespace before embedding.
export function embeddingText(chunk: string): string {
  return chunk
    .replace(/[-=+|~^*#_]{3,}/g, ' ')
    .replace(/[ \t]*\|[ \t]*/g, ' | ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function isContextLengthError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('exceeds the context length');
}

// Embed a batch; if Ollama rejects it for length, fall back to one-by-one and
// halve any single input that still doesn't fit. Logs each truncation so it's
// visible rather than silent.
export async function embedWithFallback(
  embed: EmbedClient,
  texts: string[],
  label: (j: number) => string,
): Promise<number[][]> {
  try {
    return await embed.embedBatch(texts);
  } catch (err) {
    if (!isContextLengthError(err)) throw err;
  }
  const out: number[][] = [];
  for (let j = 0; j < texts.length; j++) {
    let text = texts[j];
    for (;;) {
      try {
        out.push((await embed.embedBatch([text]))[0]);
        break;
      } catch (err) {
        if (!isContextLengthError(err) || text.length < 200) throw err;
        text = text.slice(0, Math.floor(text.length / 2));
        process.stdout.write(
          `\n[warn] ${label(j)} too long to embed; truncated embedding input to ${text.length} chars\n`,
        );
      }
    }
  }
  return out;
}
