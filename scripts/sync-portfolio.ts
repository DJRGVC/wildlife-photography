#!/usr/bin/env tsx
import { promises as fs } from 'node:fs';
import { constants as fsConst } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const PHOTO_DIR = path.join(PROJECT_ROOT, 'src', 'photography');

const SOURCE =
  process.env.PORTFOLIO_SOURCE ??
  path.join(os.homedir(), 'Pictures', 'portfolio_images');

const JSON_FILES = [
  'decisions_wildlife.json',
  'decisions_misc.json',
  'animal_ids.json',
  'locations.json',
] as const;

const SECTIONS = ['wildlife', 'misc'] as const;
type Section = (typeof SECTIONS)[number];

type Decisions = Record<string, 'keep' | 'reject'>;

async function copyIfDifferent(src: string, dest: string): Promise<boolean> {
  try {
    const [s, d] = await Promise.all([fs.stat(src), fs.stat(dest).catch(() => null)]);
    if (d && d.size === s.size && d.mtimeMs >= s.mtimeMs) return false;
  } catch {
    /* src doesn't exist — caller handles */
  }
  await fs.copyFile(src, dest, fsConst.COPYFILE_FICLONE);
  return true;
}

async function syncJsonFiles(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const file of JSON_FILES) {
    const src = path.join(SOURCE, file);
    const dest = path.join(DATA_DIR, file);
    try {
      const updated = await copyIfDifferent(src, dest);
      console.log(`[sync-portfolio] ${updated ? 'updated' : 'unchanged'}: data/${file}`);
    } catch (err) {
      console.warn(`[sync-portfolio] missing in source: ${file} (${(err as Error).message})`);
    }
  }
}

async function readDecisions(section: Section): Promise<Set<string>> {
  const text = await fs.readFile(path.join(DATA_DIR, `decisions_${section}.json`), 'utf8');
  const dec = JSON.parse(text) as Decisions;
  return new Set(
    Object.entries(dec)
      .filter(([, v]) => v === 'keep')
      .map(([k]) => k),
  );
}

async function syncSection(section: Section): Promise<void> {
  const dir = path.join(PHOTO_DIR, section);
  await fs.mkdir(dir, { recursive: true });

  const keepers = await readDecisions(section);
  const existing = new Set(
    (await fs.readdir(dir)).filter((f) => /\.(jpe?g)$/i.test(f)),
  );

  let added = 0;
  let missing = 0;
  let copied = 0;
  for (const file of keepers) {
    const src = path.join(SOURCE, file);
    const dest = path.join(dir, file);
    try {
      const updated = await copyIfDifferent(src, dest);
      if (!existing.has(file)) {
        added++;
      } else if (updated) {
        copied++;
      }
    } catch {
      missing++;
      console.warn(`[sync-portfolio] missing in source: ${file}`);
    }
  }

  let removed = 0;
  for (const file of existing) {
    if (!keepers.has(file)) {
      await fs.unlink(path.join(dir, file));
      removed++;
    }
  }

  console.log(
    `[sync-portfolio] ${section}/: ${keepers.size} keepers, +${added} added, ~${copied} updated, -${removed} removed` +
      (missing > 0 ? `, ${missing} missing in source` : ''),
  );
}

async function main(): Promise<void> {
  try {
    await fs.access(SOURCE);
  } catch {
    console.error(`[sync-portfolio] source dir not found: ${SOURCE}`);
    console.error('Set PORTFOLIO_SOURCE env var if it lives somewhere else.');
    process.exit(1);
  }

  console.log(`[sync-portfolio] source: ${SOURCE}`);
  await syncJsonFiles();
  for (const section of SECTIONS) {
    await syncSection(section);
  }
  console.log('[sync-portfolio] done. Run `npm run build:photos` (or `npm run dev`) to regenerate image-data.json.');
}

main().catch((err) => {
  console.error('[sync-portfolio] failed:', err);
  process.exit(1);
});
