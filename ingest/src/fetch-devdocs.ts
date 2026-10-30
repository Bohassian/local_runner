import fs from 'node:fs';
import path from 'node:path';
import { env } from './util/env.js';

// Downloads DevDocs bundles into data/devdocs/<slug>/ for `format: devdocs`
// sources. This is the only networked step for them: ingest and search read
// the local files.
//
//   yarn fetch-docs rails~7.1 ruby~3.2
//
// Outbound: devdocs.io/docs.json (catalog, for the bundle's release + mtime),
// then documents.devdocs.io/<slug>/index.json and db.json. Re-running
// re-downloads only when the bundle's mtime changed.

interface CatalogEntry {
  name: string;
  slug: string;
  release?: string;
  mtime: number;
  db_size?: number;
}

const slugs = process.argv.slice(2);
if (slugs.length === 0) {
  console.error('Usage: yarn fetch-docs <slug>...   (e.g. rails~7.1 ruby~3.2)');
  process.exit(1);
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

const catalog = await getJson<CatalogEntry[]>('https://devdocs.io/docs.json');

for (const slug of slugs) {
  const entry = catalog.find((e) => e.slug === slug);
  if (!entry) {
    console.error(`[${slug}] not in the DevDocs catalog; skipping`);
    continue;
  }
  const dir = path.join(env.repoRoot, 'data', 'devdocs', slug);
  const metaPath = path.join(dir, 'meta.json');
  const existing = fs.existsSync(metaPath)
    ? (JSON.parse(fs.readFileSync(metaPath, 'utf8')) as CatalogEntry)
    : null;
  if (existing?.mtime === entry.mtime) {
    console.log(`[${slug}] up to date (${entry.name} ${entry.release ?? ''})`);
    continue;
  }

  fs.mkdirSync(dir, { recursive: true });
  for (const file of ['index.json', 'db.json']) {
    const url = `https://documents.devdocs.io/${slug}/${file}?${entry.mtime}`;
    process.stdout.write(`[${slug}] ${file} ... `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
    const body = Buffer.from(await res.arrayBuffer());
    JSON.parse(body.toString('utf8')); // fail before writing a truncated file
    fs.writeFileSync(path.join(dir, file), body);
    console.log(`${(body.length / 1e6).toFixed(1)} MB`);
  }
  // Written last, so an interrupted fetch is retried next time.
  fs.writeFileSync(metaPath, JSON.stringify(entry, null, 2) + '\n');
  console.log(`[${slug}] done: ${entry.name} ${entry.release ?? ''}`);
}
