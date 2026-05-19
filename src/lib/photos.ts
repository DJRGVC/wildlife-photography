import { getImage } from 'astro:assets';
import type { ImageMetadata } from 'astro';
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

const VARIANT_WIDTHS = [640, 960, 1280, 1920] as const;
const FULL_MAX_WIDTH = 2560;
const FORMAT = 'avif' as const;

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

  const fullWidth = Math.min(FULL_MAX_WIDTH, mod.default.width);
  const full = await getImage({ src: mod.default, width: fullWidth, format: FORMAT });
  const fullHeightAttr = Number(full.attributes.height);
  const fullHeight =
    Number.isFinite(fullHeightAttr) && fullHeightAttr > 0
      ? fullHeightAttr
      : Math.round((fullWidth * mod.default.height) / mod.default.width);

  const main = variants[variants.length - 1] ?? full;
  const mainWidth = Number(main.attributes.width) || mod.default.width;
  const mainHeight = Number(main.attributes.height) || mod.default.height;

  return {
    ...meta,
    key,
    fileName,
    src: main.src,
    width: mainWidth,
    height: mainHeight,
    srcSet: variants.map((v) => ({
      src: v.src,
      width: Number(v.attributes.width) || mod.default.width,
      height: Number(v.attributes.height) || mod.default.height,
    })),
    fullSrc: full.src,
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
