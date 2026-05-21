#!/usr/bin/env tsx
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExifReader from 'exifreader';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const PHOTO_DIR = path.join(PROJECT_ROOT, 'src', 'photography');
const OUTPUT = path.join(PROJECT_ROOT, 'src', 'image-data.json');

export const SECTIONS = ['wildlife', 'misc'] as const;
export type Section = (typeof SECTIONS)[number];

export type AnimalEntry = {
  common_name: string;
  scientific_name: string;
  subject: string;
  notes: string;
};

export type PhotoMeta = {
  section: Section;
  width: number;
  height: number;
  date: string;
  dateFormatted: string;
  location: string;
  locationCoords?: { lat: number; lng: number };
  scene: string;
  animals: readonly AnimalEntry[];
  notes: string;
  confidence: string;
  camera: string;
  lens: string;
  exposure: string;
  lqip: string;
};

type RawAnimalEntry = {
  common_name?: string;
  scientific_name?: string;
  subject?: string;
  notes?: string | null;
};

type RawAnimalIds = Record<
  string,
  {
    filename?: string;
    categories?: string[];
    date?: string;
    datetime?: string;
    width?: number;
    height?: number;
    location?: { name?: string; lat?: number; lng?: number };
    scene?: string;
    animals?: RawAnimalEntry[];
    confidence?: string;
    notes?: string | null;
  }
>;

type RawLocations = Record<
  string,
  { location?: string; lat?: number; lng?: number }
>;

type Decisions = Record<string, 'keep' | 'reject'>;

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

function parseExifDate(raw: string): string {
  if (!raw) return '';
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return '';
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).toISOString();
}

function dateFromFilename(name: string): string {
  const m = name.match(/^(\d{4})(\d{2})(\d{2})/);
  if (!m) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function isoFromDateString(date: string): string {
  if (!date) return '';
  if (date.includes('T')) return date;
  const m = date.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const [, y, mo, d] = m;
  return new Date(Number(y), Number(mo) - 1, Number(d), 12, 0, 0).toISOString();
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
  // mozjpeg + a tiny 12px-wide source gives a usable backdrop colour
  // map at minimum byte cost. JPEG header overhead dominates at this
  // size, so further reduction of the pixel grid has little effect;
  // mozjpeg's better Huffman tables get most of the win. The LQIP is
  // rendered as a CSS background and only visible briefly while the
  // real image decodes, so the lower fidelity isn't noticeable.
  const lqip = await sharp(buffer)
    .resize(12, null, { fit: 'inside' })
    .jpeg({ quality: 25, mozjpeg: true })
    .toBuffer();
  return `data:image/jpeg;base64,${lqip.toString('base64')}`;
}

async function readJsonOrEmpty<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function indexPhoto(
  section: Section,
  file: string,
  animalIds: RawAnimalIds,
  locations: RawLocations,
): Promise<readonly [string, PhotoMeta] | null> {
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
  const meta = animalIds[file];

  const exifDate = parseExifDate(pickString(exif.DateTimeOriginal));
  const metaDate = meta?.date ? isoFromDateString(meta.date) : '';
  const filenameDate = isoFromDateString(dateFromFilename(file));
  const dateIso = metaDate || exifDate || filenameDate;

  const dateKey = dateIso ? dateIso.slice(0, 10) : '';
  const locationFromMeta = meta?.location?.name ?? '';
  const locationFromDate = dateKey ? locations[dateKey]?.location ?? '' : '';
  const location = locationFromMeta || locationFromDate || '';

  const coords =
    meta?.location?.lat != null && meta?.location?.lng != null
      ? { lat: meta.location.lat, lng: meta.location.lng }
      : dateKey && locations[dateKey]?.lat != null && locations[dateKey]?.lng != null
        ? { lat: locations[dateKey].lat as number, lng: locations[dateKey].lng as number }
        : undefined;

  const animals: AnimalEntry[] = (meta?.animals ?? []).map((a) => ({
    common_name: a.common_name ?? '',
    scientific_name: a.scientific_name ?? '',
    subject: a.subject ?? 'primary',
    notes: a.notes ?? '',
  }));

  const make = pickString(exif.Make);
  const model = pickString(exif.Model);
  const camera = !model
    ? make
    : !make || model.toLowerCase().startsWith(make.toLowerCase())
      ? model
      : `${make} ${model}`;
  const lens = pickString(exif.LensModel);
  const exposure = formatExposure(
    pickString(exif.ExposureTime),
    pickString(exif.FNumber),
    pickString(exif.ISOSpeedRatings),
  );

  const lqip = await buildLqip(buffer);

  const photoMeta: PhotoMeta = {
    section,
    width: meta?.width ?? dim.width,
    height: meta?.height ?? dim.height,
    date: dateIso,
    dateFormatted: formatDate(dateIso),
    location,
    ...(coords ? { locationCoords: coords } : {}),
    scene: meta?.scene ?? '',
    animals,
    notes: meta?.notes ?? '',
    confidence: meta?.confidence ?? '',
    camera,
    lens,
    exposure,
    lqip,
  };

  return [`${section}/${file}`, photoMeta] as const;
}

async function main(): Promise<void> {
  const start = Date.now();
  const animalIds = await readJsonOrEmpty<RawAnimalIds>(path.join(DATA_DIR, 'animal_ids.json'), {});
  const locations = await readJsonOrEmpty<RawLocations>(path.join(DATA_DIR, 'locations.json'), {});

  const index: Record<string, PhotoMeta> = {};
  let total = 0;
  let unknownInDecisions = 0;

  for (const section of SECTIONS) {
    const dir = path.join(PHOTO_DIR, section);
    await fs.mkdir(dir, { recursive: true });
    const decisions = await readJsonOrEmpty<Decisions>(
      path.join(DATA_DIR, `decisions_${section}.json`),
      {},
    );
    const keepers = new Set(
      Object.entries(decisions)
        .filter(([, v]) => v === 'keep')
        .map(([k]) => k),
    );

    const onDisk = (await fs.readdir(dir)).filter((f) => /\.(jpe?g)$/i.test(f)).sort();
    total += onDisk.length;

    let missingMeta = 0;
    const promises: Promise<readonly [string, PhotoMeta] | null>[] = [];
    for (const file of onDisk) {
      if (keepers.size > 0 && !keepers.has(file)) {
        unknownInDecisions++;
      }
      if (!animalIds[file]) missingMeta++;
      promises.push(indexPhoto(section, file, animalIds, locations));
    }

    const results = await Promise.all(promises);
    let written = 0;
    for (const r of results) {
      if (r) {
        index[r[0]] = r[1];
        written++;
      }
    }
    console.log(
      `[build-photo-index] ${section}/: indexed ${written}/${onDisk.length}` +
        (missingMeta > 0 ? ` (${missingMeta} without animal_ids entry)` : ''),
    );
  }

  await fs.writeFile(OUTPUT, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  if (unknownInDecisions > 0) {
    console.warn(
      `[build-photo-index] note: ${unknownInDecisions} on-disk file(s) not present in decisions JSON; ` +
        'they were still indexed but consider running `npm run sync-portfolio` to reconcile',
    );
  }
  const ms = Date.now() - start;
  console.log(`[build-photo-index] wrote ${Object.keys(index).length}/${total} entries → ${path.relative(PROJECT_ROOT, OUTPUT)} (${ms}ms)`);
}

main().catch((err) => {
  console.error('[build-photo-index] failed:', err);
  process.exit(1);
});
