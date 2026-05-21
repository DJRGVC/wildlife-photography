import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

// Number of gallery thumbs to load eagerly (no lazy-loading attr) and
// render at high fetchpriority. 3 covers the realistic above-fold tile
// count across viewports; loading more competes with the LCP image
// for bandwidth without making subsequent tiles visible any sooner.
const EAGER_COUNT = 3;
// Number of items at the top of the gallery that get the staggered
// slide-up entrance. Beyond this they render at rest. 9 covers the
// realistic above-fold tile count across viewports.
const GALLERY_ENTRANCE_COUNT = 9;
// Fixed 200ms stagger between item entrances — each image starts
// 200ms after the previous, so the cascade reads as a visible wave
// rolling through the row rather than all-at-once. Each individual
// slide takes 1700ms (set in CSS below).
const GALLERY_STAGGER_MS = 200;

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

// Cache of thumb rects, populated on mouseenter and cleared on
// mouseleave. Without this, handleTilt would call
// getBoundingClientRect() on every mousemove (~60×/s/tile), forcing
// a layout read and stalling the main thread under the cursor.
const tiltRectCache = new WeakMap<HTMLElement, DOMRect>();

function handleTiltEnter(e: React.MouseEvent<HTMLAnchorElement>): void {
  tiltRectCache.set(e.currentTarget, e.currentTarget.getBoundingClientRect());
}

function handleTilt(e: React.MouseEvent<HTMLAnchorElement>): void {
  const el = e.currentTarget;
  const rect = tiltRectCache.get(el) ?? el.getBoundingClientRect();
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
  tiltRectCache.delete(el);
}

function handleImgLoad(e: React.SyntheticEvent<HTMLImageElement>): void {
  e.currentTarget.classList.add('is-loaded');
}

// Module-level cache of photos we've already preloaded. Persists for the
// life of the page so hovering a thumb a second time is a no-op.
const preloadedSrcs = new Set<string>();

/**
 * On hover / focus / touchstart, kick off a background fetch of both
 * lightbox-sized variants of this photo. By the time the user clicks,
 * the bytes are in the browser cache → the lightbox opens with no
 * decode-time LQIP flash.
 *
 * - Medium variant: desktop's progressive open animation shows this.
 *   Use srcset/sizes so the browser picks the same variant the
 *   lightbox will.
 * - Full-resolution: mobile shows this directly (no progressive); also
 *   what desktop settles to after the open animation. Pre-decode so
 *   the <img> doesn't pay decode cost on first paint.
 */
function preloadLightboxImage(p: GalleryPhoto): void {
  if (!preloadedSrcs.has(p.src)) {
    preloadedSrcs.add(p.src);
    const img = new Image();
    if (p.srcSet && p.srcSet.length > 0) {
      img.srcset = p.srcSet.map((v) => `${v.src} ${v.width}w`).join(', ');
      img.sizes = '100vw';
    }
    img.src = p.src;
  }
  if (!preloadedSrcs.has(p.fullSrc)) {
    preloadedSrcs.add(p.fullSrc);
    const img = new Image();
    img.fetchPriority = 'high';
    img.src = p.fullSrc;
    img.decode().catch(() => {});
  }
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
    // Progressive loading: the medium variant + srcSet drives the
    // open animation and the morph between photos (smaller bitmap =
    // smoother re-rasterization at varying sizes). The lightbox
    // swaps to `fullSrc` once it settles, so the user gets the
    // full-resolution original for stationary viewing without paying
    // its render cost during animations.
    src: p.src,
    srcSet: p.srcSet,
    fullSrc: p.fullSrc,
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
}: {
  photos: readonly GalleryPhoto[];
  globalIndexBase: number;
  onPick: (p: GalleryPhoto, target: HTMLElement, globalIndex: number) => void;
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
            const srcSet = (p.srcSet ?? [])
              .map((v) => `${v.src} ${v.width}w`)
              .join(', ');
            const alt = altText(p);
            return (
              <a
                className={`gallery__item${
                  globalIdx < GALLERY_ENTRANCE_COUNT ? ' gallery__item--entrance' : ''
                }`}
                data-photo-key={p.key}
                data-cursor="photo"
                data-cursor-label="View"
                href={p.fullSrc}
                aria-label={alt}
                style={{
                  display: 'block',
                  width: ctx.width,
                  height: ctx.height,
                  backgroundImage: `url(${p.lqip})`,
                  backgroundSize: 'cover',
                  backgroundPosition: 'center',
                  // Staggered slide-up cascade for the first N items.
                  // --i and --stagger-ms together drive animation-delay
                  // for the .gallery__item--entrance CSS rule.
                  ['--i' as string]: globalIdx,
                  ['--stagger-ms' as string]: `${GALLERY_STAGGER_MS.toFixed(3)}ms`,
                }}
                onClick={(e) => {
                  e.preventDefault();
                  onPick(p, e.currentTarget, globalIdx);
                }}
                onMouseEnter={(e) => {
                  handleTiltEnter(e);
                  preloadLightboxImage(p);
                }}
                onFocus={() => preloadLightboxImage(p)}
                // Mobile equivalent of hover-preload: kick off the
                // fullSrc fetch + decode as soon as the finger lands,
                // so the lightbox's <img> finds bytes ready by the
                // time the tap completes and React mounts the
                // portal. Without this, mobile's first open shows
                // the LQIP backdrop for ~100ms while the new full-
                // res JPEG decodes.
                onTouchStart={() => preloadLightboxImage(p)}
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

// Imperative thumb-hide: avoids the React state path that would
// re-render every PhotoAlbumBlock (and RowsPhotoAlbum's row layout)
// each open/close/nav. We toggle visibility + a11y attributes by
// querying the data-photo-key directly. React doesn't manage the
// `visibility` style or these a11y attributes (they're not in JSX),
// so its reconciliation can't fight our imperative writes.
function setHiddenThumb(prevKey: string | null, nextKey: string | null): void {
  if (prevKey && prevKey !== nextKey) {
    const el = document.querySelector<HTMLElement>(
      `[data-photo-key="${CSS.escape(prevKey)}"]`,
    );
    if (el) {
      el.style.visibility = '';
      el.removeAttribute('aria-hidden');
      el.removeAttribute('tabindex');
    }
  }
  if (nextKey && nextKey !== prevKey) {
    const el = document.querySelector<HTMLElement>(
      `[data-photo-key="${CSS.escape(nextKey)}"]`,
    );
    if (el) {
      el.style.visibility = 'hidden';
      el.setAttribute('aria-hidden', 'true');
      el.setAttribute('tabindex', '-1');
    }
  }
}

export default function Gallery({ wildlife, misc }: Props) {
  const [lbState, setLbState] = useState<LightboxState | null>(null);
  // Tracks the currently-hidden thumb key without participating in
  // React state — see setHiddenThumb above.
  const hiddenKeyRef = useRef<string | null>(null);

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
  // Eagerly preload + decode fullSrc for the top N photos on page-
  // load idle. The user reports that the FIRST click of the session
  // lags (close FLIP teleports, swap stutters), then subsequent
  // opens/navs feel fine — and that waiting 3-5 seconds after the
  // first click also makes the close smooth. That pattern is JPEG
  // decoding blocking the main thread: a 5-15MB byte-for-byte
  // original takes a couple hundred ms to decode the first time,
  // and that decode work spills into whatever animation is running
  // when the user clicks/navigates. Pre-decoding at idle warms the
  // decoded-image cache so the bitmap is already ready by the time
  // an animation needs it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const photos = [...wildlife, ...misc].slice(0, 12);
    if (photos.length === 0) return;

    const refs: HTMLImageElement[] = [];
    const win = window as Window & {
      requestIdleCallback?: (cb: IdleRequestCallback, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const schedule = win.requestIdleCallback ?? ((cb) => window.setTimeout(cb, 200));
    const cancel = win.cancelIdleCallback ?? window.clearTimeout;

    let handle: number | null = null;
    let cancelled = false;
    handle = schedule(() => {
      if (cancelled) return;
      for (const p of photos) {
        const im = new Image();
        im.fetchPriority = 'low';
        im.src = p.fullSrc;
        im.decode().catch(() => {});
        refs.push(im);
      }
    });

    return () => {
      cancelled = true;
      if (handle !== null) cancel(handle);
    };
  }, [wildlife, misc]);

  // Pre-warm the lightbox paint pipeline on page-load idle. The user
  // sees the close FLIP lag the first 1-2 cycles, then any image is
  // smooth — the pattern points to browser-side warmup: compositor
  // layer allocation, V8 JIT of the lightbox CSS paths, paint-record
  // caching for the .lb / .lb__card / .lb__media / .lb__img element
  // tree. None of that happens during a passive page load; it
  // happens only when the structure actually mounts and renders.
  // Briefly creating and destroying a structurally-equivalent hidden
  // div on page idle triggers the same setup, so the first real
  // click opens against an already-warm pipeline.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const win = window as Window & {
      requestIdleCallback?: (cb: IdleRequestCallback, opts?: { timeout?: number }) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const schedule = win.requestIdleCallback ?? ((cb) => window.setTimeout(cb, 600));
    const cancel = win.cancelIdleCallback ?? window.clearTimeout;

    let handle: number | null = null;
    let cleanupNode: (() => void) | null = null;

    handle = schedule(() => {
      const div = document.createElement('div');
      div.setAttribute('aria-hidden', 'true');
      div.style.cssText =
        'position:fixed;inset:0;visibility:hidden;pointer-events:none;z-index:-1;';
      // Match the .lb / .lb__card / .lb__media / .lb__img structure
      // closely enough that the browser allocates the same compositor
      // layers and runs the same paint paths.
      div.innerHTML = `
        <div class="lb lb--opening">
          <div class="lb__bg"></div>
          <div class="lb__card">
            <div class="lb__card-bg"></div>
            <div class="lb__media" style="width:600px;height:400px;">
              <img class="lb__img" alt="" decoding="async" />
            </div>
            <div class="lb__caption"></div>
          </div>
        </div>
      `;
      document.body.appendChild(div);
      // Force layout + initial paint so the browser actually allocates
      // the layers (not just parses HTML).
      void div.offsetHeight;

      let frames = 0;
      const tick = () => {
        frames++;
        if (frames >= 3) {
          div.remove();
        } else {
          requestAnimationFrame(tick);
        }
      };
      const rafId = requestAnimationFrame(tick);
      cleanupNode = () => {
        cancelAnimationFrame(rafId);
        div.remove();
      };
    }, { timeout: 1500 });

    return () => {
      if (handle !== null) cancel(handle);
      cleanupNode?.();
    };
  }, []);

  // RAF id of the in-flight smooth-scroll, so a fast second nav can
  // cancel the previous animation before starting a new one.
  const scrollRafRef = useRef<number | null>(null);
  // Final Y of the in-flight smooth-scroll. If the user closes the
  // lightbox mid-scroll we cancel the RAF and snap window.scrollY
  // straight here — otherwise the close FLIP lands at fromRect
  // coords that don't match the actual thumb position (because the
  // page is still moving toward them), which reads as the image
  // "teleporting" to its final spot once the page catches up.
  const scrollTargetRef = useRef<number | null>(null);

  const pick = useCallback(
    (p: GalleryPhoto, sourceEl: HTMLElement, globalIndex: number) => {
      const r = sourceEl.getBoundingClientRect();
      setHiddenThumb(hiddenKeyRef.current, p.key);
      hiddenKeyRef.current = p.key;
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
      setHiddenThumb(hiddenKeyRef.current, newPhoto.key);
      hiddenKeyRef.current = newPhoto.key;
      const prev = lbStateRef.current;
      if (!prev) return;
      if (!node) {
        setLbState({ ...prev, index: newIndex });
        return;
      }

      // Center the thumb in the viewport if it isn't comfortably
      // visible. The lightbox covers the page, so the scroll is
      // hidden until close — but we still smooth it so the page
      // doesn't snap underneath when the user dismisses mid-scroll.
      //
      // We drive the smooth motion ourselves with rAF rather than
      // Lenis's scrollTo: Lenis is `stop()`ed while the lightbox is
      // open, and `force: true` proved unreliable for actually
      // moving the wrapper in that state. window.scrollTo() works
      // through Lenis's stopped state (verified by the previous
      // instant version), so each frame just sets a new position.
      const r0 = node.getBoundingClientRect();
      const vh = window.innerHeight;
      const margin = Math.max(64, r0.height / 2);
      let scrollDelta = 0;
      if (r0.top < margin || r0.bottom > vh - margin) {
        const targetY = Math.max(
          0,
          window.scrollY + r0.top + r0.height / 2 - vh / 2,
        );
        scrollDelta = targetY - window.scrollY;

        if (scrollRafRef.current !== null) {
          cancelAnimationFrame(scrollRafRef.current);
        }
        scrollTargetRef.current = targetY;
        const startY = window.scrollY;
        const startTime = performance.now();
        const dur = 460;
        const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
        const step = (now: number) => {
          const t = Math.min(1, (now - startTime) / dur);
          window.scrollTo(0, startY + scrollDelta * easeOutCubic(t));
          if (t < 1) {
            scrollRafRef.current = requestAnimationFrame(step);
          } else {
            scrollRafRef.current = null;
            scrollTargetRef.current = null;
          }
        };
        scrollRafRef.current = requestAnimationFrame(step);
      }

      // fromRect = thumb's location AFTER the smooth scroll lands.
      // Close FLIPs to this target regardless of when the user
      // dismisses; by the time the close animation finishes (~520ms),
      // the page is positioned to match, so the image lands on the
      // actual thumbnail.
      setLbState({
        ...prev,
        index: newIndex,
        fromRect: {
          left: r0.left,
          top: r0.top - scrollDelta,
          width: r0.width,
          height: r0.height,
        },
      });
    },
    [allPhotos],
  );

  const close = useCallback(() => {
    setHiddenThumb(hiddenKeyRef.current, null);
    hiddenKeyRef.current = null;
    setLbState(null);
  }, []);

  // Fires when Lightbox's close FLIP *starts* (vs `close` above, which
  // fires when it finishes). If a smooth-scroll animation is still in
  // flight from a recent arrow-nav, we cancel its RAF and snap the
  // page to the target Y. Without this, the close FLIP lands at
  // fromRect coords computed against the post-scroll position while
  // the page is still mid-scroll — visible as the image jumping the
  // remaining stretch once the scroll catches up.
  const handleCloseStart = useCallback(() => {
    if (scrollRafRef.current !== null) {
      cancelAnimationFrame(scrollRafRef.current);
      scrollRafRef.current = null;
    }
    if (scrollTargetRef.current !== null) {
      window.scrollTo(0, scrollTargetRef.current);
      scrollTargetRef.current = null;
    }
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
        />,
      );
    }
    return blocks;
  }, [wildlife, misc, pick]);

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
      <Lightbox
        state={lbState}
        onClose={close}
        onCloseStart={handleCloseStart}
        onIndexChange={handleIndexChange}
      />
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
    cursor: pointer;
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
    /* Match the parent .gallery__item border-radius so the image is
       rounded throughout the entrance slide-up, not just once it has
       come to rest inside the rounded clip mask. */
    border-radius: inherit;
  }
  .gallery__img.is-loaded { opacity: 1; }

  /* Mask + slide-up entrance for the first row of thumbs. Same
     primitive as the header name, applied to .gallery__img inside
     the already-overflow-hidden .gallery__item. --i (set inline
     per item from globalIdx) and --stagger-ms (computed in JSX to
     fit the cascade in ~220ms) together drive a left-to-right
     cascade. Items beyond GALLERY_ENTRANCE_COUNT don't carry this
     class and start at rest. */
  .gallery__item--entrance {
    /* During the entrance, suppress both the LQIP backdrop and the
       cream-deep placeholder colour. The slide reveals the image
       against the page background — nothing visible "behind" it. */
    background-image: none !important;
    background-color: transparent !important;
  }
  .gallery__item--entrance .gallery__img {
    transform: translateY(120%);
    animation: galleryImgEntrance 1700ms cubic-bezier(0.2, 0.8, 0.2, 1) forwards;
    animation-delay: calc(var(--i, 0) * var(--stagger-ms, 0ms));
  }
  @keyframes galleryImgEntrance {
    to { transform: translateY(0); }
  }
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
      animation: none !important;
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
