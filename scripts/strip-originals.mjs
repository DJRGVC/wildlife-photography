#!/usr/bin/env node
// Strip original JPG/JPEG files from dist/_astro/ that exceed
// Cloudflare Pages' 25 MiB per-asset upload limit. Files at or under
// the limit are kept — the lightbox serves them as fullSrc for
// genuinely lossless full-res viewing (see src/lib/photos.ts). Files
// over the limit are dropped here; src/lib/photos.ts has matching
// logic that falls those photos back to the WebP variant.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ASTRO_DIR = path.join(ROOT, 'dist', '_astro');
const CF_MAX_BYTES = 25 * 1024 * 1024;

let removed = 0;
let kept = 0;
let removedBytes = 0;
let keptBytes = 0;

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
      if (stat.size > CF_MAX_BYTES) {
        await fs.unlink(p);
        removed++;
        removedBytes += stat.size;
      } else {
        kept++;
        keptBytes += stat.size;
      }
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
const keptMb = (keptBytes / 1024 / 1024).toFixed(1);
const removedMb = (removedBytes / 1024 / 1024).toFixed(1);
console.log(
  `[strip-originals] kept ${kept} original JPG file(s) (${keptMb} MiB) for lossless lightbox; ` +
    `stripped ${removed} that exceeded the ${CF_MAX_BYTES / 1024 / 1024} MiB Cloudflare limit (${removedMb} MiB).`,
);
