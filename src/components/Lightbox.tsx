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

    bg?.animate([{ opacity: 1 }, { opacity: 0 }], opts);
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
  // synchronously after React commits but BEFORE the browser paints — so
  // there is no 1-frame flash of the card at its final centered position
  // before the FLIP transform "snaps" it back to the thumbnail.
  //
  // For first-click on a photo, the WebP variant isn't cached yet — the
  // <img>'s layout isn't fully computed, so getBoundingClientRect returns
  // 0 and computeFlip() returns null. Previously we bailed entirely, which
  // meant NO animation ran (card popped to center with no transition).
  // Now we always fade the backdrop in immediately for visual feedback,
  // then defer the card animations until the image is actually loaded so
  // the FLIP can compute correctly. The card stays hidden (opacity: 0 in
  // CSS) until its WAAPI starts.
  useLayoutEffect(() => {
    if (phase !== 'opening' || !active) return;
    const card = cardRef.current;
    const img = imgRef.current;
    const cardBg = cardBgRef.current;
    const bg = bgRef.current;
    const caption = captionRef.current;
    const closeBtn = closeBtnRef.current;
    if (!card || !img || !bg) return;

    let cancelled = false;

    // Fade the backdrop immediately so something happens on click even
    // if the card is waiting for the image to load.
    bg.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration: 360, easing: 'ease-out', fill: 'both' },
    );

    const startCardAnimations = () => {
      if (cancelled) return;
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
    };

    if (img.complete && img.naturalWidth > 0) {
      // Image already cached → run animations immediately, no delay.
      startCardAnimations();
    } else {
      // Wait for image to load before measuring + animating. Failsafe
      // timer guarantees animations eventually run even if load/error
      // events never fire.
      const onReady = () => {
        img.removeEventListener('load', onReady);
        img.removeEventListener('error', onReady);
        startCardAnimations();
      };
      img.addEventListener('load', onReady, { once: true });
      img.addEventListener('error', onReady, { once: true });
      const failsafe = window.setTimeout(onReady, 1500);
      return () => {
        cancelled = true;
        img.removeEventListener('load', onReady);
        img.removeEventListener('error', onReady);
        window.clearTimeout(failsafe);
      };
    }
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
            style={
              photo.lqip
                ? {
                    backgroundImage: `url(${photo.lqip})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                  }
                : undefined
            }
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
