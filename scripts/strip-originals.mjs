#!/usr/bin/env node
// Strip original JPG/JPEG files from dist/_astro/ before deploying to
// Cloudflare Workers (which has a 25 MiB per-asset limit). Astro emits the
// originals into the bundle because import.meta.glob references them, but
// the gallery only ever serves the WebP variants getImage() produces — so
// the originals are dead weight.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASTRO_DIR = path.join(ROOT, 'dist', '_astro');

let removed = 0;
let totalBytes = 0;

async function walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p);
    } else if (/\.(jpe?g)$/i.test(e.name)) {
      const stat = await fs.stat(p);
      await fs.unlink(p);
      removed++;
      totalBytes += stat.size;
    }
  }
}

try {
  await fs.access(ASTRO_DIR);
} catch {
  console.log('[strip-originals] dist/_astro not found, skipping');
  process.exit(0);
}

await walk(ASTRO_DIR);
const mb = (totalBytes / 1024 / 1024).toFixed(1);
console.log(`[strip-originals] removed ${removed} JPG file(s) (${mb} MiB) from dist/_astro/`);
