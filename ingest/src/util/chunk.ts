// Naive paragraph-aware chunker. Targets ~500 tokens per chunk with one
// paragraph of overlap between adjacent chunks. We approximate tokens as
// chars/4 — close enough for retrieval; precision doesn't matter here, the
// vec0 index doesn't care about chunk boundaries.

const CHARS_PER_TOKEN = 4;

export function chunkText(text: string, targetTokens = 500): string[] {
  const targetChars = targetTokens * CHARS_PER_TOKEN;
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+$/g, ''))
    .filter((p) => p.trim().length > 0);

  if (paragraphs.length === 0) return [];

  const chunks: string[] = [];
  let buf: string[] = [];
  let bufLen = 0;

  for (const p of paragraphs) {
    buf.push(p);
    bufLen += p.length + 2;
    if (bufLen >= targetChars) {
      chunks.push(buf.join('\n\n'));
      // Carry the last paragraph as overlap into the next chunk so that
      // context isn't sliced mid-thought across chunk boundaries.
      buf = [p];
      bufLen = p.length + 2;
    }
  }

  // Flush the tail unless it's just the leftover overlap paragraph from the
  // last emit (which would duplicate content already in the previous chunk).
  if (buf.length > 1 || chunks.length === 0) {
    chunks.push(buf.join('\n\n'));
  }

  return chunks;
}
