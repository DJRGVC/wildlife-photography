import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type LightboxPhoto = {
  src: string;
  srcSet?: readonly { src: string; width: number }[];
  width: number;
  height: number;
  alt: string;
  captionHtml: string;
  lqip?: string;
};

export type LightboxState = {
  photos: readonly LightboxPhoto[];
  index: number;
  fromRect: { left: number; top: number; width: number; height: number };
};

interface Props {
  state: LightboxState | null;
  onClose: () => void;
}

type Phase = 'closed' | 'opening' | 'open' | 'closing';

const OPEN_DURATION = 700;
const CLOSE_DURATION = 520;
const OPEN_EASING = 'cubic-bezier(0.22, 0.78, 0.18, 1)';
const CLOSE_EASING = 'cubic-bezier(0.4, 0.0, 0.2, 1)';

type Flip = { tx: number; ty: number; scale: number };

// Mirrors the CSS max-width / max-height rules on .lb__img so we can
// compute the rendered size from the photo's metadata alone, without
// needing the image bytes to be loaded. That lets us set explicit pixel
// width/height on the <img> at render time — which gives the element
// real layout dimensions on the first frame, so FLIP works on first
// click even for uncached images.
function expectedImageDims(photo: LightboxPhoto): { width: number; height: number } {
  const aspect = photo.width / photo.height;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1200;
  const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
  const isMobile = vw < 640;
  const maxWidth = isMobile ? vw - 60 : Math.min(1080, vw - 100);
  const maxHeight = isMobile ? vh - 240 : vh - 300;

  let width = Math.min(maxWidth, photo.width);
  let height = width / aspect;
  if (height > maxHeight) {
    height = maxHeight;
    width = height * aspect;
  }
  return { width, height };
}

function computeFlip(
  cardEl: HTMLElement,
  imgEl: HTMLElement,
  fr: { left: number; top: number; width: number; height: number },
): Flip | null {
  const cardRect = cardEl.getBoundingClientRect();
  const imgRect = imgEl.getBoundingClientRect();
  if (cardRect.width === 0 || imgRect.width === 0) return null;

  const scale = fr.width / imgRect.width;
  const imgOffsetX = imgRect.left - cardRect.left;
  const imgOffsetY = imgRect.top - cardRect.top;
  const tx = fr.left - imgOffsetX * scale - cardRect.left;
  const ty = fr.top - imgOffsetY * scale - cardRect.top;

  return { tx, ty, scale };
}

// How far the outgoing image slides (px) and the easing curves. Kept
// small so navigation feels snappy — total swap is ~440ms end-to-end.
const NAV_SLIDE_PX = 40;
const NAV_OUT_DURATION = 200;
const NAV_IN_DURATION = 260;
const NAV_OUT_EASING = 'cubic-bezier(0.4, 0, 1, 1)';
const NAV_IN_EASING = 'cubic-bezier(0, 0, 0.2, 1)';

export default function Lightbox({ state, onClose }: Props) {
  const [active, setActive] = useState<LightboxState | null>(null);
  const [phase, setPhase] = useState<Phase>('closed');
  const [mounted, setMounted] = useState(false);
  // Set during an arrow-key navigation; cleared once the in-animation
  // for the new photo finishes. Acts as a guard so spamming arrows
  // doesn't overlap animations.
  const [navInfo, setNavInfo] = useState<{ direction: 1 | -1 } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const cardBgRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  useEffect(() => setMounted(true), []);

  // useLayoutEffect (not useEffect) so the state→active mapping happens
  // synchronously in the same paint cycle as the parent's state update.
  // Otherwise there's a 1-frame gap between Gallery setting the clicked
  // thumb to visibility:hidden and Lightbox actually rendering its
  // portal — the user sees the empty cream gap where the thumb was for a
  // single frame, which reads as a white flicker on click.
  useLayoutEffect(() => {
    if (state && !active) {
      setActive(state);
      setPhase('opening');
    }
  }, [state, active]);

  const close = useCallback(() => {
    if (phase === 'closing' || phase === 'closed' || !active) return;

    // Cancel any in-flight navigation animations on the img/caption so
    // their leftover transforms don't compose with the card's close
    // transform (which would visually offset the image during the FLIP
    // shrink back to the thumbnail).
    if (navInfo) {
      imgRef.current?.getAnimations().forEach((a) => a.cancel());
      captionRef.current?.getAnimations().forEach((a) => a.cancel());
      setNavInfo(null);
    }

    setPhase('closing');

    const card = cardRef.current;
    const img = imgRef.current;
    const cardBg = cardBgRef.current;
    const bg = bgRef.current;
    const caption = captionRef.current;
    const closeBtn = closeBtnRef.current;

    let toTransform = 'translate(0, 0) scale(1)';
    if (card && img) {
      const flip = computeFlip(card, img, active.fromRect);
      if (flip) {
        toTransform = `translate(${flip.tx.toFixed(2)}px, ${flip.ty.toFixed(2)}px) scale(${flip.scale.toFixed(4)})`;
      }
    }

    const opts: KeyframeAnimationOptions = {
      duration: CLOSE_DURATION,
      easing: CLOSE_EASING,
      fill: 'forwards',
    };

    bg?.animate(
      [
        {
          opacity: 1,
          backdropFilter: 'blur(28px) saturate(115%)',
          WebkitBackdropFilter: 'blur(28px) saturate(115%)',
        },
        {
          opacity: 0,
          backdropFilter: 'blur(0px) saturate(100%)',
          WebkitBackdropFilter: 'blur(0px) saturate(100%)',
        },
      ],
      opts,
    );
    closeBtn?.animate([{ opacity: 1 }, { opacity: 0 }], { ...opts, duration: 220 });
    caption?.animate([{ opacity: 1 }, { opacity: 0 }], { ...opts, duration: 240 });
    cardBg?.animate([{ opacity: 1 }, { opacity: 0 }], {
      ...opts,
      duration: CLOSE_DURATION * 0.85,
    });
    card?.animate(
      [
        { transform: 'translate(0, 0) scale(1)' },
        { transform: toTransform },
      ],
      opts,
    );

    window.setTimeout(() => {
      setPhase('closed');
      setActive(null);
      onClose();
    }, CLOSE_DURATION);
  }, [phase, active, onClose, navInfo]);

  // Arrow-key navigation between photos. Runs as two phases:
  //   1. Slide the current img + caption out (translateX + opacity)
  //   2. Swap to the new photo, slide the new img + caption in from the
  //      opposite side
  // Phase 2 is handled by a useLayoutEffect that fires when active.index
  // changes while navInfo is set — that way the in-animation starts
  // synchronously in the same paint cycle as React commits the new src,
  // so there's no flash of the new image at rest before the slide.
  const navigate = useCallback(
    (direction: 1 | -1) => {
      if (!active || phase !== 'open' || navInfo) return;
      const newIndex = active.index + direction;
      if (newIndex < 0 || newIndex >= active.photos.length) return;

      const img = imgRef.current;
      const caption = captionRef.current;
      if (!img) return;

      setNavInfo({ direction });

      const slideOutPx = direction === 1 ? -NAV_SLIDE_PX : NAV_SLIDE_PX;
      const outOpts: KeyframeAnimationOptions = {
        duration: NAV_OUT_DURATION,
        easing: NAV_OUT_EASING,
        fill: 'forwards',
      };
      const outKeyframes: Keyframe[] = [
        { transform: 'translateX(0)', opacity: 1 },
        { transform: `translateX(${slideOutPx}px)`, opacity: 0 },
      ];

      const imgOut = img.animate(outKeyframes, outOpts);
      caption?.animate(outKeyframes, outOpts);

      imgOut.finished
        .then(() => {
          setActive((prev) => (prev ? { ...prev, index: newIndex } : prev));
        })
        .catch(() => {});
    },
    [active, phase, navInfo],
  );

  // Phase 2 of arrow-key navigation: after the new photo commits, slide
  // the img + caption in from the opposite side.
  useLayoutEffect(() => {
    if (!navInfo || !active) return;
    const img = imgRef.current;
    const caption = captionRef.current;
    if (!img) return;

    const slideInPx = navInfo.direction === 1 ? NAV_SLIDE_PX : -NAV_SLIDE_PX;
    const inOpts: KeyframeAnimationOptions = {
      duration: NAV_IN_DURATION,
      easing: NAV_IN_EASING,
      fill: 'both',
    };
    const inKeyframes: Keyframe[] = [
      { transform: `translateX(${slideInPx}px)`, opacity: 0 },
      { transform: 'translateX(0)', opacity: 1 },
    ];

    const imgIn = img.animate(inKeyframes, inOpts);
    caption?.animate(inKeyframes, inOpts);

    imgIn.finished
      .then(() => {
        setNavInfo(null);
      })
      .catch(() => {});
    // active?.index in deps: this effect should fire exactly when the
    // index changes (i.e. after navigate commits the new photo). navInfo
    // gates whether to animate; without the index dep, the effect
    // wouldn't re-run on swap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.index]);

  // useLayoutEffect (not useEffect) so the WAAPI animations are applied
  // synchronously after React commits but BEFORE the browser paints — no
  // 1-frame flash of the card at its final centered position before the
  // FLIP transform "snaps" it back to the thumbnail.
  //
  // Animations run IMMEDIATELY — never wait for the image to load. The
  // <img> has aspect-ratio set inline (from photo.width/height), so the
  // browser computes its constrained rendered size before the bytes
  // arrive. That makes getBoundingClientRect return real numbers on
  // first click, so FLIP works on uncached images too, and the LQIP
  // background fills the space until the WebP arrives.
  useLayoutEffect(() => {
    if (phase !== 'opening' || !active) return;
    const card = cardRef.current;
    const img = imgRef.current;
    const cardBg = cardBgRef.current;
    const bg = bgRef.current;
    const caption = captionRef.current;
    const closeBtn = closeBtnRef.current;
    if (!card || !img || !bg) return;

    // Fade the backdrop immediately so something happens on click even
    // if the card is waiting for the image to load. The blur radius
    // interpolates 0px -> 28px alongside the opacity, so the page
    // behind goes gradually crisp -> blurry instead of full blur
    // snapping in with the tint.
    bg.animate(
      [
        {
          opacity: 0,
          backdropFilter: 'blur(0px) saturate(100%)',
          WebkitBackdropFilter: 'blur(0px) saturate(100%)',
        },
        {
          opacity: 1,
          backdropFilter: 'blur(28px) saturate(115%)',
          WebkitBackdropFilter: 'blur(28px) saturate(115%)',
        },
      ],
      { duration: 500, easing: 'ease-out', fill: 'both' },
    );

    // Run card animations immediately — never wait for image load.
    // The img has aspect-ratio set inline, so getBoundingClientRect
    // returns its final constrained size from frame zero. The LQIP
    // background shows in the space until the WebP arrives.
    const flip = computeFlip(card, img, active.fromRect);
    const cardFromTransform = flip
      ? `translate(${flip.tx.toFixed(2)}px, ${flip.ty.toFixed(2)}px) scale(${flip.scale.toFixed(4)})`
      : 'scale(0.88)';

    const cardAnim = card.animate(
      [
        { transform: cardFromTransform, opacity: 1 },
        { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      ],
      { duration: OPEN_DURATION, easing: OPEN_EASING, fill: 'both' },
    );

    cardBg?.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      {
        duration: OPEN_DURATION * 0.85,
        easing: 'ease-out',
        fill: 'both',
      },
    );

    caption?.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      {
        duration: OPEN_DURATION * 0.5,
        delay: OPEN_DURATION * 0.55,
        easing: 'ease-out',
        fill: 'both',
      },
    );

    closeBtn?.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 320, delay: 320, easing: 'ease-out', fill: 'both' },
    );

    cardAnim.finished.then(() => setPhase('open')).catch(() => {});
  }, [phase, active]);

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') {
        e.preventDefault();
        navigate(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        navigate(-1);
      }
    };
    document.addEventListener('keydown', onKey);

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const lenis = (window as unknown as { __lenis?: { stop(): void; start(): void } }).__lenis;
    lenis?.stop();

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      lenis?.start();
    };
  }, [active, close, navigate]);

  // Preload the immediate neighbors so left/right arrow swaps are
  // instant — by the time the slide-in animation runs, the WebP for the
  // new photo is already cached.
  useEffect(() => {
    if (!active) return;
    const preload = (p: LightboxPhoto): void => {
      const im = new Image();
      if (p.srcSet && p.srcSet.length > 0) {
        im.srcset = p.srcSet.map((v) => `${v.src} ${v.width}w`).join(', ');
        im.sizes = '100vw';
      }
      im.src = p.src;
    };
    const photos = active.photos;
    const i = active.index;
    if (i + 1 < photos.length) preload(photos[i + 1]);
    if (i - 1 >= 0) preload(photos[i - 1]);
  }, [active]);

  if (!mounted || !active || phase === 'closed') return null;

  const photo = active.photos[active.index];
  const srcSet = photo.srcSet?.map((v) => `${v.src} ${v.width}w`).join(', ');
  // Compute the exact rendered px size now, before the <img> mounts, so
  // it has real layout dimensions from frame zero — FLIP works on first
  // click for uncached images. When the WebP arrives, object-fit:
  // contain keeps it sized identically, no reflow.
  const renderedDims = expectedImageDims(photo);

  return createPortal(
    <div
      className={`lb lb--${phase}`}
      role="dialog"
      aria-modal="true"
      aria-label={photo.alt}
      onClick={close}
    >
      <div className="lb__bg" ref={bgRef} aria-hidden="true" />
      <div
        className="lb__card"
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lb__card-bg" ref={cardBgRef} aria-hidden="true" />
        <div className="lb__media">
          <img
            ref={imgRef}
            className="lb__img"
            src={photo.src}
            srcSet={srcSet}
            sizes="100vw"
            width={photo.width}
            height={photo.height}
            alt={photo.alt}
            draggable={false}
            fetchPriority="high"
            style={{
              // Explicit pixel size overrides .lb__img's width:auto/
              // height:auto, forcing the browser to reserve layout space
              // even before the image bytes are decoded. Without this,
              // an uncached <img> renders 0×0 (aspect-ratio alone isn't
              // enough when both axes are auto and there's no intrinsic
              // size), so getBoundingClientRect returns 0 inside the
              // FLIP useLayoutEffect and the animation falls back to a
              // center scale instead of starting at the thumb. Once the
              // WebP loads, object-fit: contain keeps it sized exactly
              // to this box — no reflow, no animation glitch.
              width: `${renderedDims.width}px`,
              height: `${renderedDims.height}px`,
              ...(photo.lqip
                ? {
                    backgroundImage: `url(${photo.lqip})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  }
                : {}),
            }}
          />
        </div>
        <div
          className="lb__caption"
          ref={captionRef}
          dangerouslySetInnerHTML={{ __html: photo.captionHtml }}
        />
      </div>
      <button
        type="button"
        className="lb__close"
        ref={closeBtnRef}
        aria-label="Close"
        onClick={(e) => {
          e.stopPropagation();
          close();
        }}
      >
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
          <path
            d="M4 4 L16 16 M16 4 L4 16"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </button>
    </div>,
    document.body,
  );
}
// Lightbox CSS lives in src/styles/global.css so it's part of the page's
// initial stylesheet — avoids the FOUC flash that an inline <style> tag
// would produce on first portal mount (card-bg briefly painting cream
// before its opacity: 0 rule applies).
