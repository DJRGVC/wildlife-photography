#!/usr/bin/env tsx
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExifReader from 'exifreader';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PHOTO_DIR = path.join(PROJECT_ROOT, 'src', 'photography');
const OUTPUT = path.join(PROJECT_ROOT, 'src', 'image-data.json');

export const SECTIONS = ['wildlife', 'misc'] as const;
export type Section = typeof SECTIONS[number];

export type PhotoMeta = {
  section: Section;
  width: number;
  height: number;
  animal: string;
  location: string;
  date: string;
  dateFormatted: string;
  camera: string;
  lens: string;
  exposure: string;
  keywords: readonly string[];
  caption: string;
  lqip: string;
};

type ExifTag = { description?: unknown; value?: unknown } | undefined;

function pickString(tag: ExifTag): string {
  if (!tag) return '';
  if (typeof tag.description === 'string' && tag.description.length > 0) return tag.description;
  if (Array.isArray(tag.value)) {
    const first = tag.value[0];
    if (typeof first === 'string' || typeof first === 'number') return String(first);
  }
  if (typeof tag.value === 'string' || typeof tag.value === 'number') return String(tag.value);
  return '';
}

function pickStringList(tag: unknown): string[] {
  if (!tag) return [];
  if (Array.isArray(tag)) {
    return tag
      .map((entry) => (typeof entry === 'object' ? pickString(entry as ExifTag) : String(entry)))
      .filter(Boolean);
  }
  const single = pickString(tag as ExifTag);
  if (!single) return [];
  return single.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseExifDate(raw: string): string {
  if (!raw) return '';
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return '';
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).toISOString();
}

function formatExposure(exp: string, f: string, iso: string): string {
  const parts: string[] = [];
  if (exp) parts.push(exp.endsWith('s') ? exp : `${exp}s`);
  if (f) parts.push(`f/${f.replace(/^f\//i, '')}`);
  if (iso) parts.push(`ISO ${iso}`);
  return parts.join(' · ');
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

async function buildLqip(buffer: Buffer): Promise<string> {
  const lqip = await sharp(buffer)
    .resize(20, null, { fit: 'inside' })
    .jpeg({ quality: 40 })
    .toBuffer();
  return `data:image/jpeg;base64,${lqip.toString('base64')}`;
}

async function indexPhoto(section: Section, file: string): Promise<readonly [string, PhotoMeta] | null> {
  const abs = path.join(PHOTO_DIR, section, file);
  const buffer = await fs.readFile(abs);

  let tags: ExifReader.ExpandedTags;
  try {
    tags = ExifReader.load(buffer, { expanded: true });
  } catch (err) {
    console.warn(`[build-photo-index] ${section}/${file}: failed to read EXIF — ${(err as Error).message}`);
    return null;
  }

  const dim = await sharp(buffer).metadata();
  if (!dim.width || !dim.height) {
    console.warn(`[build-photo-index] ${section}/${file}: missing dimensions, skipping`);
    return null;
  }

  const exif = (tags.exif ?? {}) as Record<string, ExifTag>;
  const iptc = (tags.iptc ?? {}) as Record<string, unknown>;
  const xmp = (tags.xmp ?? {}) as Record<string, ExifTag>;

  const date = parseExifDate(pickString(exif.DateTimeOriginal));
  const animal = pickString(iptc.Headline as ExifTag);
  const location =
    pickString(iptc['Sub-location'] as ExifTag) ||
    pickString(iptc.City as ExifTag) ||
    pickString(xmp.Location);
  const caption = pickString(iptc['Caption-Abstract'] as ExifTag);
  const keywords = pickStringList(iptc.Keywords);

  const camera = [pickString(exif.Make), pickString(exif.Model)].filter(Boolean).join(' ');
  const lens = pickString(exif.LensModel);
  const exposure = formatExposure(
    pickString(exif.ExposureTime),
    pickString(exif.FNumber),
    pickString(exif.ISOSpeedRatings),
  );

  const lqip = await buildLqip(buffer);

  const meta: PhotoMeta = {
    section,
    width: dim.width,
    height: dim.height,
    animal,
    location,
    date,
    dateFormatted: formatDate(date),
    camera,
    lens,
    exposure,
    keywords,
    caption,
    lqip,
  };

  return [`${section}/${file}`, meta] as const;
}

async function listSection(section: Section): Promise<string[]> {
  const dir = path.join(PHOTO_DIR, section);
  await fs.mkdir(dir, { recursive: true });
  const entries = await fs.readdir(dir);
  return entries.filter((f) => /\.(jpe?g)$/i.test(f)).sort();
}

async function main(): Promise<void> {
  const start = Date.now();
  const index: Record<string, PhotoMeta> = {};
  let total = 0;

  for (const section of SECTIONS) {
    const files = await listSection(section);
    total += files.length;
    console.log(`[build-photo-index] indexing ${files.length} photo(s) in ${section}/`);
    const results = await Promise.all(files.map((f) => indexPhoto(section, f)));
    for (const r of results) {
      if (r) index[r[0]] = r[1];
    }
  }

  await fs.writeFile(OUTPUT, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  const ms = Date.now() - start;
  console.log(`[build-photo-index] wrote ${Object.keys(index).length}/${total} entries → ${path.relative(PROJECT_ROOT, OUTPUT)} (${ms}ms)`);
}

main().catch((err) => {
  console.error('[build-photo-index] failed:', err);
  process.exit(1);
});
