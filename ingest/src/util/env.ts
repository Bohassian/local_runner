import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');

config({ path: path.join(repoRoot, '.env') });

function required(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

export const env = {
  dbPath: path.resolve(repoRoot, required('INGEST_DB_PATH', './data/mcp-memory.db')),
  embedBaseUrl: required('INGEST_EMBED_BASE_URL', 'http://localhost:11434'),
  embedModel: required('EMBED_MODEL', 'nomic-embed-text'),
  repoRoot,
};
