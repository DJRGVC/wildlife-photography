import { getImage } from 'astro:assets';
import type { ImageMetadata } from 'astro';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import imageData from '../image-data.json';

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

export type GalleryPhoto = PhotoMeta & {
  key: string;
  fileName: string;
  src: string;
  srcSet: readonly { src: string; width: number; height: number }[];
  fullSrc: string;
  fullWidth: number;
  fullHeight: number;
};

const WILDLIFE_MODULES = import.meta.glob<{ default: ImageMetadata }>(
  '/src/photography/wildlife/*.{jpg,jpeg,JPG,JPEG}',
  { eager: true },
);
const MISC_MODULES = import.meta.glob<{ default: ImageMetadata }>(
  '/src/photography/misc/*.{jpg,jpeg,JPG,JPEG}',
  { eager: true },
);

const VARIANT_WIDTHS = [720, 1440] as const;
const FULL_MAX_WIDTH = 2200;
const FORMAT = 'webp' as const;
// Cloudflare Pages enforces a 25 MiB per-asset upload limit (hard
// ceiling, all plans). We serve the byte-for-byte original as fullSrc
// when it fits under that limit so the lightbox is genuinely
// lossless; anything larger falls back to the Astro-processed WebP
// variant. strip-originals.mjs uses the same threshold so its decisions
// stay in sync with this file's.
const CF_MAX_BYTES = 25 * 1024 * 1024;

function readMeta(key: string): PhotoMeta | null {
  const map = imageData as unknown as Record<string, PhotoMeta>;
  return map[key] ?? null;
}

async function buildPhoto(
  section: Section,
  absPath: string,
  mod: { default: ImageMetadata },
): Promise<GalleryPhoto | null> {
  const fileName = absPath.split('/').pop()!;
  const key = `${section}/${fileName}`;
  const meta = readMeta(key);
  if (!meta) {
    console.warn(
      `[lib/photos] no image-data.json entry for ${key}; run \`npm run build:photos\``,
    );
    return null;
  }

  const widths = VARIANT_WIDTHS.filter((w) => w <= mod.default.width);
  const variants = await Promise.all(
    widths.map((w) => getImage({ src: mod.default, width: w, format: FORMAT })),
  );

  // fullSrc: byte-for-byte original when it fits under Cloudflare's
  // per-asset limit, else an Astro-processed WebP fallback. The
  // original URL (`mod.default.src`) is unprocessed — Astro just
  // copies the file into dist/_astro/ with a content-hashed name, so
  // the bytes are identical to the source JPEG.
  let fullSrc: string;
  let fullWidth: number;
  let fullHeight: number;
  let originalSize = 0;
  try {
    const fsPath = path.resolve(process.cwd(), absPath.replace(/^\//, ''));
    originalSize = (await fs.stat(fsPath)).size;
  } catch {
    // unreadable — fall through to webp fallback
  }
  if (originalSize > 0 && originalSize <= CF_MAX_BYTES) {
    fullSrc = mod.default.src;
    fullWidth = mod.default.width;
    fullHeight = mod.default.height;
  } else {
    const capped = Math.min(FULL_MAX_WIDTH, mod.default.width);
    const fallback = await getImage({ src: mod.default, width: capped, format: FORMAT });
    fullSrc = fallback.src;
    fullWidth = capped;
    const h = Number(fallback.attributes.height);
    fullHeight = Number.isFinite(h) && h > 0
      ? h
      : Math.round((capped * mod.default.height) / mod.default.width);
  }

  const main = variants[variants.length - 1];
  const mainSrc = main?.src ?? fullSrc;
  const mainWidth = Number(main?.attributes.width) || mod.default.width;
  const mainHeight = Number(main?.attributes.height) || mod.default.height;

  return {
    ...meta,
    key,
    fileName,
    src: mainSrc,
    width: mainWidth,
    height: mainHeight,
    srcSet: variants.map((v) => ({
      src: v.src,
      width: Number(v.attributes.width) || mod.default.width,
      height: Number(v.attributes.height) || mod.default.height,
    })),
    fullSrc,
    fullWidth,
    fullHeight,
  } satisfies GalleryPhoto;
}

function shuffle<T>(items: readonly T[]): T[] {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function loadSection(
  section: Section,
  modules: Record<string, { default: ImageMetadata }>,
): Promise<GalleryPhoto[]> {
  const entries = await Promise.all(
    Object.entries(modules).map(([absPath, mod]) => buildPhoto(section, absPath, mod)),
  );
  return shuffle(entries.filter((x): x is GalleryPhoto => x !== null));
}

export async function loadGalleryPhotos(): Promise<{
  wildlife: GalleryPhoto[];
  misc: GalleryPhoto[];
}> {
  const [wildlife, misc] = await Promise.all([
    loadSection('wildlife', WILDLIFE_MODULES),
    loadSection('misc', MISC_MODULES),
  ]);
  return { wildlife, misc };
}
