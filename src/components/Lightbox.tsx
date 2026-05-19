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
  photo: LightboxPhoto;
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

export default function Lightbox({ state, onClose }: Props) {
  const [active, setActive] = useState<LightboxState | null>(null);
  const [phase, setPhase] = useState<Phase>('closed');
  const [mounted, setMounted] = useState(false);
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
  }, [phase, active, onClose]);

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
  }, [active, close]);

  if (!mounted || !active || phase === 'closed') return null;

  const photo = active.photo;
  const srcSet = photo.srcSet?.map((v) => `${v.src} ${v.width}w`).join(', ');

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
              // Setting aspect-ratio explicitly (in addition to width/
              // height attrs) is the most reliable way to get the browser
              // — Firefox in particular — to compute the constrained
              // rendered size from CSS max-width/max-height BEFORE the
              // image data is loaded. Without this, getBoundingClientRect
              // returns 0 on first click for uncached images, which
              // breaks the FLIP scale calculation.
              aspectRatio:
                photo.width && photo.height
                  ? `${photo.width} / ${photo.height}`
                  : undefined,
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
