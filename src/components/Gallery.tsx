import { useCallback, useMemo, useRef, useState } from 'react';
import {
  RowsPhotoAlbum,
  type Photo,
  type RenderImageContext,
} from 'react-photo-album';
import 'react-photo-album/rows.css';
import Lightbox, { type LightboxPhoto, type LightboxState } from './Lightbox';

export type AnimalEntry = {
  common_name: string;
  scientific_name: string;
  subject: string;
  notes: string;
};

export type GalleryPhoto = Photo & {
  key: string;
  fileName: string;
  date: string;
  dateFormatted: string;
  location: string;
  scene: string;
  animals: readonly AnimalEntry[];
  camera: string;
  lens: string;
  exposure: string;
  lqip: string;
  fullSrc: string;
  fullWidth: number;
  fullHeight: number;
};

interface Props {
  wildlife: readonly GalleryPhoto[];
  misc: readonly GalleryPhoto[];
}

const EAGER_COUNT = 6;

const escapeHtml = (raw: string): string =>
  raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function primaryAnimal(p: GalleryPhoto): AnimalEntry | null {
  return p.animals.find((a) => a.subject === 'primary') ?? p.animals[0] ?? null;
}

function altText(p: GalleryPhoto): string {
  const primary = primaryAnimal(p);
  if (primary?.common_name) return primary.common_name;
  if (p.scene) return p.scene;
  return p.fileName;
}

function renderCaption(p: GalleryPhoto, showAnimal: boolean): string {
  const meta: string[] = [];
  if (p.location) meta.push(`<span>${escapeHtml(p.location)}</span>`);
  if (p.dateFormatted) meta.push(`<span>${escapeHtml(p.dateFormatted)}</span>`);

  const exif: string[] = [];
  if (p.camera) exif.push(escapeHtml(p.camera));
  if (p.lens) exif.push(escapeHtml(p.lens));
  if (p.exposure) exif.push(escapeHtml(p.exposure));

  const parts: string[] = ['<div class="caption">'];
  const primary = primaryAnimal(p);
  if (showAnimal && primary?.common_name) {
    parts.push(`<div class="caption__title">${escapeHtml(primary.common_name)}</div>`);
    if (primary.scientific_name) {
      parts.push(`<div class="caption__sub"><i>${escapeHtml(primary.scientific_name)}</i></div>`);
    }
  }
  if (meta.length) parts.push(`<div class="caption__meta">${meta.join('')}</div>`);
  if (p.scene) parts.push(`<div class="caption__scene">${escapeHtml(p.scene)}</div>`);
  if (exif.length) parts.push(`<div class="caption__exif">${exif.join(' · ')}</div>`);
  parts.push('</div>');
  return parts.join('');
}

function handleTilt(e: React.MouseEvent<HTMLAnchorElement>): void {
  const el = e.currentTarget;
  const rect = el.getBoundingClientRect();
  const px = (e.clientX - rect.left) / rect.width;
  const py = (e.clientY - rect.top) / rect.height;
  const ry = (px - 0.5) * 5;
  const rx = (0.5 - py) * 5;
  el.style.setProperty('--tilt-x', `${rx.toFixed(2)}deg`);
  el.style.setProperty('--tilt-y', `${ry.toFixed(2)}deg`);
}

function resetTilt(e: React.MouseEvent<HTMLAnchorElement>): void {
  const el = e.currentTarget;
  el.style.setProperty('--tilt-x', '0deg');
  el.style.setProperty('--tilt-y', '0deg');
}

function handleImgLoad(e: React.SyntheticEvent<HTMLImageElement>): void {
  e.currentTarget.classList.add('is-loaded');
}

// Module-level cache of photos we've already preloaded. Persists for the
// life of the page so hovering a thumb a second time is a no-op.
const preloadedSrcs = new Set<string>();

/**
 * On hover, kick off a background fetch of the lightbox-sized variant of
 * this photo. By the time the user clicks, the image is in the browser
 * cache → the lightbox opens with zero load delay.
 *
 * Matches the lightbox's own srcset + sizes so the browser picks the
 * same variant for both. Cheap if the user just glances past — browser
 * queues, then drops the request once they leave the page.
 */
function preloadLightboxImage(p: GalleryPhoto): void {
  if (preloadedSrcs.has(p.src)) return;
  preloadedSrcs.add(p.src);
  const img = new Image();
  if (p.srcSet && p.srcSet.length > 0) {
    img.srcset = p.srcSet.map((v) => `${v.src} ${v.width}w`).join(', ');
    img.sizes = '100vw';
  }
  img.src = p.src;
}

/**
 * Callback ref that handles the SSR-then-hydrate race: if an image was
 * already loaded by the browser before React hydrated (i.e. anything in
 * the initial viewport), its onLoad event has already fired and will not
 * fire again — so we'd miss adding the .is-loaded class and the image
 * would stay at opacity:0 forever, showing only the LQIP placeholder.
 * Check `complete` (+ naturalWidth to filter broken images) and add the
 * class synchronously on mount when that's the case.
 */
function handleImgRef(node: HTMLImageElement | null): void {
  if (node && node.complete && node.naturalWidth > 0) {
    node.classList.add('is-loaded');
  }
}

function buildLightboxPhoto(p: GalleryPhoto, showAnimal: boolean): LightboxPhoto {
  return {
    src: p.src,
    srcSet: p.srcSet,
    width: p.fullWidth,
    height: p.fullHeight,
    alt: altText(p),
    captionHtml: renderCaption(p, showAnimal),
    lqip: p.lqip,
  };
}

function PhotoAlbumBlock({
  photos,
  globalIndexBase,
  onPick,
  hiddenKey,
}: {
  photos: readonly GalleryPhoto[];
  globalIndexBase: number;
  onPick: (p: GalleryPhoto, target: HTMLElement, globalIndex: number) => void;
  hiddenKey: string | null;
}) {
  return (
    <div className="gallery__inner">
      <RowsPhotoAlbum
        photos={photos as unknown as Photo[]}
        targetRowHeight={340}
        spacing={20}
        padding={0}
        defaultContainerWidth={1152}
        rowConstraints={{ singleRowMaxHeight: 480 }}
        render={{
          image: (imgProps, ctx: RenderImageContext<Photo>) => {
            const p = ctx.photo as GalleryPhoto;
            const globalIdx = globalIndexBase + ctx.index;
            const eager = globalIdx < EAGER_COUNT;
            const isHidden = hiddenKey === p.key;
            const srcSet = (p.srcSet ?? [])
              .map((v) => `${v.src} ${v.width}w`)
              .join(', ');
            const alt = altText(p);
            return (
              <a
                className="gallery__item"
                data-photo-key={p.key}
                href={p.fullSrc}
                aria-label={alt}
                aria-hidden={isHidden || undefined}
                tabIndex={isHidden ? -1 : undefined}
                style={{
                  display: 'block',
                  width: ctx.width,
                  height: ctx.height,
                  backgroundImage: `url(${p.lqip})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  visibility: isHidden ? 'hidden' : 'visible',
                }}
                onClick={(e) => {
                  e.preventDefault();
                  onPick(p, e.currentTarget, globalIdx);
                }}
                onMouseEnter={() => preloadLightboxImage(p)}
                onFocus={() => preloadLightboxImage(p)}
                onMouseMove={handleTilt}
                onMouseLeave={resetTilt}
              >
                <img
                  {...imgProps}
                  className="gallery__img"
                  ref={handleImgRef}
                  src={p.src}
                  srcSet={srcSet || undefined}
                  sizes={`(max-width: 600px) 100vw, ${Math.round(ctx.width)}px`}
                  alt={alt}
                  width={ctx.width}
                  height={ctx.height}
                  loading={eager ? 'eager' : 'lazy'}
                  decoding="async"
                  fetchPriority={eager ? 'high' : 'auto'}
                  onLoad={handleImgLoad}
                />
              </a>
            );
          },
        }}
      />
    </div>
  );
}

export default function Gallery({ wildlife, misc }: Props) {
  const [lbState, setLbState] = useState<LightboxState | null>(null);
  const [hiddenKey, setHiddenKey] = useState<string | null>(null);

  // One flat ordered list of every photo the lightbox can show, in the
  // same order they appear visually (wildlife first, then misc). Arrow
  // keys cycle through this list. Wildlife photos render with the
  // species title; misc don't.
  const lightboxPhotos = useMemo<readonly LightboxPhoto[]>(() => {
    const list: LightboxPhoto[] = [];
    for (const p of wildlife) list.push(buildLightboxPhoto(p, true));
    for (const p of misc) list.push(buildLightboxPhoto(p, false));
    return list;
  }, [wildlife, misc]);

  // Parallel ordered list of source GalleryPhotos — index here matches
  // the index used by the Lightbox. Lets us look up the corresponding
  // thumb's key on arrow-key navigation so we can hide it / measure it.
  const allPhotos = useMemo<readonly GalleryPhoto[]>(
    () => [...wildlife, ...misc],
    [wildlife, misc],
  );
  // Latest lbState mirror — needed so `handleIndexChange` can read the
  // current state without re-creating its callback on every nav.
  const lbStateRef = useRef<LightboxState | null>(null);
  lbStateRef.current = lbState;

  const pick = useCallback(
    (p: GalleryPhoto, sourceEl: HTMLElement, globalIndex: number) => {
      const r = sourceEl.getBoundingClientRect();
      setHiddenKey(p.key);
      setLbState({
        photos: lightboxPhotos,
        index: globalIndex,
        fromRect: { left: r.left, top: r.top, width: r.width, height: r.height },
      });
    },
    [lightboxPhotos],
  );

  // Called by Lightbox when the user arrows to a new photo. Hide the
  // new thumb (reveals the previously-hidden one), bring it into view
  // if it's scrolled off-screen, and refresh fromRect to its current
  // location — so an Esc close FLIPs back to the thumb the user is
  // actually viewing, and so the page is positioned at it when the
  // lightbox dismisses.
  const handleIndexChange = useCallback(
    (newIndex: number) => {
      const newPhoto = allPhotos[newIndex];
      if (!newPhoto) return;
      const node = document.querySelector<HTMLElement>(
        `[data-photo-key="${CSS.escape(newPhoto.key)}"]`,
      );
      setHiddenKey(newPhoto.key);
      const prev = lbStateRef.current;
      if (!prev) return;

      // Center the thumb in the viewport if it's not comfortably
      // visible. The lightbox covers the page, so an instant scroll
      // is invisible until close. Lenis is stopped while open, so a
      // native scrollTo lands cleanly.
      if (node) {
        const r0 = node.getBoundingClientRect();
        const vh = window.innerHeight;
        const margin = Math.max(64, r0.height / 2);
        if (r0.top < margin || r0.bottom > vh - margin) {
          const targetY = Math.max(
            0,
            window.scrollY + r0.top + r0.height / 2 - vh / 2,
          );
          window.scrollTo({ top: targetY, behavior: 'auto' });
        }
      }

      const r = node?.getBoundingClientRect();
      setLbState({
        ...prev,
        index: newIndex,
        fromRect: r
          ? { left: r.left, top: r.top, width: r.width, height: r.height }
          : prev.fromRect,
      });
    },
    [allPhotos],
  );

  const close = useCallback(() => {
    setLbState(null);
    setHiddenKey(null);
  }, []);

  const sectionBlocks = useMemo(() => {
    const blocks: React.ReactNode[] = [];
    if (wildlife.length > 0) {
      blocks.push(
        <PhotoAlbumBlock
          key="wildlife"
          photos={wildlife}
          globalIndexBase={0}
          onPick={pick}
          hiddenKey={hiddenKey}
        />,
      );
    }
    if (wildlife.length > 0 && misc.length > 0) {
      blocks.push(
        <div key="sep" className="gallery__sep" role="separator" aria-hidden="true">
          <span className="gallery__sep-line" />
          <span className="gallery__sep-diamond gallery__sep-diamond--side" />
          <span className="gallery__sep-diamond gallery__sep-diamond--center" />
          <span className="gallery__sep-diamond gallery__sep-diamond--side" />
          <span className="gallery__sep-line" />
        </div>,
      );
    }
    if (misc.length > 0) {
      blocks.push(
        <PhotoAlbumBlock
          key="misc"
          photos={misc}
          globalIndexBase={wildlife.length}
          onPick={pick}
          hiddenKey={hiddenKey}
        />,
      );
    }
    return blocks;
  }, [wildlife, misc, pick, hiddenKey]);

  if (wildlife.length === 0 && misc.length === 0) {
    return (
      <section className="gallery gallery--empty" aria-label="Photography gallery">
        <p className="gallery__empty">
          No photos yet. Drop JPEGs into <code>src/photography/wildlife/</code> or{' '}
          <code>src/photography/misc/</code> and they will appear here.
        </p>
        <style>{galleryStyles}</style>
      </section>
    );
  }

  return (
    <>
      <section className="gallery" aria-label="Photography gallery">
        {sectionBlocks}
        <style>{galleryStyles}</style>
      </section>
      <Lightbox state={lbState} onClose={close} onIndexChange={handleIndexChange} />
    </>
  );
}

const galleryStyles = `
  .gallery {
    padding-block: 16px 96px;
    padding-inline: max(24px, calc((100% - 1200px) / 2 + 24px));
  }
  .gallery--empty {
    padding-block: 32px 96px;
  }
  .gallery__empty {
    font-family: var(--font-sans);
    font-size: 14px;
    color: var(--color-ink-soft);
    max-width: 640px;
  }
  .gallery__empty code {
    font-family: ui-monospace, "SF Mono", Menlo, monospace;
    font-size: 13px;
    background: var(--color-cream-deep);
    padding: 1px 5px;
    border-radius: 3px;
  }
  .gallery__inner { margin: 0; }
  .gallery__sep {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 18px;
    margin-block: 104px;
    color: color-mix(in oklab, var(--color-ink) 38%, var(--color-cream-bottom) 62%);
    user-select: none;
  }
  .gallery__sep-line {
    flex: 0 0 auto;
    width: 150px;
    height: 2.5px;
    background: currentColor;
    opacity: 0.55;
    border-radius: 1.5px;
  }
  .gallery__sep-diamond {
    display: inline-block;
    transform: rotate(45deg);
    background: color-mix(in oklab, var(--color-ink) 55%, var(--color-cream-bottom) 45%);
    flex: 0 0 auto;
  }
  .gallery__sep-diamond--side {
    width: 5px;
    height: 5px;
    border-radius: 1.2px;
  }
  .gallery__sep-diamond--center {
    width: 9px;
    height: 9px;
    border-radius: 2px;
  }
  .gallery__item {
    display: block;
    overflow: hidden;
    text-decoration: none;
    cursor: zoom-in;
    border-radius: 6px;
    transform: perspective(900px) rotateX(var(--tilt-x, 0deg)) rotateY(var(--tilt-y, 0deg));
    transform-style: preserve-3d;
    transition: transform 220ms cubic-bezier(0.2, 0.7, 0.2, 1), box-shadow 220ms ease;
    will-change: transform;
    background-color: var(--color-cream-deep);
  }
  .gallery__img {
    opacity: 0;
    transition: opacity 360ms ease, transform 320ms cubic-bezier(0.2, 0.7, 0.2, 1);
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .gallery__img.is-loaded { opacity: 1; }
  @media (hover: hover) {
    .gallery__item:hover {
      box-shadow: 0 18px 38px -22px rgba(20, 20, 18, 0.35);
    }
    .gallery__item:hover .gallery__img {
      transform: scale(1.012);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .gallery__item,
    .gallery__img {
      transform: none !important;
      transition: opacity 80ms linear !important;
    }
  }
  @media (max-width: 600px) {
    .gallery {
      padding-block: 8px 64px;
    }
    .gallery__sep {
      margin-block: 56px;
      gap: 14px;
    }
    .gallery__sep { gap: 12px; margin-block: 64px; }
    .gallery__sep-line { width: 80px; height: 2px; }
    .gallery__sep-diamond--center { width: 7px; height: 7px; border-radius: 1.6px; }
    .gallery__sep-diamond--side { width: 4px; height: 4px; border-radius: 1px; }
    .gallery__item {
      border-radius: 4px;
    }
  }
`;
