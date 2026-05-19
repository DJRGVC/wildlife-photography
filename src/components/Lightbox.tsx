import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type LightboxPhoto = {
  src: string;
  srcSet?: readonly { src: string; width: number }[];
  width: number;
  height: number;
  alt: string;
  captionHtml: string;
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

const OPEN_DURATION = 520;
const CLOSE_DURATION = 360;
const OPEN_EASING = 'cubic-bezier(0.22, 0.78, 0.18, 1)';
const CLOSE_EASING = 'cubic-bezier(0.4, 0.0, 0.2, 1)';

export default function Lightbox({ state, onClose }: Props) {
  const [active, setActive] = useState<LightboxState | null>(null);
  const [phase, setPhase] = useState<Phase>('closed');
  const [mounted, setMounted] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const imgWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (state && !active) {
      setActive(state);
      setPhase('opening');
    }
  }, [state, active]);

  const close = useCallback(() => {
    if (phase === 'closing' || phase === 'closed') return;
    setPhase('closing');

    const card = cardRef.current;
    const bg = bgRef.current;
    const caption = captionRef.current;
    const imgWrap = imgWrapRef.current;
    const closeBtn = closeBtnRef.current;

    const opts: KeyframeAnimationOptions = {
      duration: CLOSE_DURATION,
      easing: CLOSE_EASING,
      fill: 'forwards',
    };

    bg?.animate([{ opacity: 1 }, { opacity: 0 }], opts);
    closeBtn?.animate([{ opacity: 1 }, { opacity: 0 }], { ...opts, duration: 200 });
    caption?.animate([{ opacity: 1 }, { opacity: 0 }], { ...opts, duration: 200 });
    card?.animate(
      [
        { opacity: 1, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(0.94)' },
      ],
      opts,
    );
    imgWrap?.animate(
      [
        { opacity: 1, transform: 'scale(1)' },
        { opacity: 0, transform: 'scale(0.94)' },
      ],
      opts,
    );

    window.setTimeout(() => {
      setPhase('closed');
      setActive(null);
      onClose();
    }, CLOSE_DURATION);
  }, [phase, onClose]);

  useEffect(() => {
    if (phase !== 'opening' || !active) return;
    const card = cardRef.current;
    const bg = bgRef.current;
    const caption = captionRef.current;
    const imgWrap = imgWrapRef.current;
    const closeBtn = closeBtnRef.current;
    if (!card || !bg || !imgWrap) return;

    const raf = requestAnimationFrame(() => {
      const wrapRect = imgWrap.getBoundingClientRect();
      const fr = active.fromRect;
      if (wrapRect.width === 0 || wrapRect.height === 0) {
        setPhase('open');
        return;
      }
      const wrapCx = wrapRect.left + wrapRect.width / 2;
      const wrapCy = wrapRect.top + wrapRect.height / 2;
      const frCx = fr.left + fr.width / 2;
      const frCy = fr.top + fr.height / 2;
      const dx = frCx - wrapCx;
      const dy = frCy - wrapCy;
      const sx = fr.width / wrapRect.width;
      const sy = fr.height / wrapRect.height;
      const s = Math.min(sx, sy);

      const imgAnim = imgWrap.animate(
        [
          { transform: `translate(${dx}px, ${dy}px) scale(${s.toFixed(4)})`, opacity: 1 },
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
        ],
        { duration: OPEN_DURATION, easing: OPEN_EASING, fill: 'both' },
      );

      bg.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 360, easing: 'ease-out', fill: 'forwards' },
      );

      card.animate(
        [
          { opacity: 0, transform: 'scale(0.94)' },
          { opacity: 1, transform: 'scale(1)' },
        ],
        { duration: 380, easing: OPEN_EASING, fill: 'forwards', delay: 60 },
      );

      caption?.animate(
        [
          { opacity: 0, transform: 'translateY(8px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        { duration: 320, delay: 240, easing: 'ease-out', fill: 'both' },
      );

      closeBtn?.animate(
        [{ opacity: 0 }, { opacity: 1 }],
        { duration: 280, delay: 200, easing: 'ease-out', fill: 'forwards' },
      );

      imgAnim.finished.then(() => setPhase('open')).catch(() => {});
    });
    return () => cancelAnimationFrame(raf);
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
        <div className="lb__media" ref={imgWrapRef}>
          <img
            className="lb__img"
            src={photo.src}
            srcSet={srcSet}
            sizes="100vw"
            width={photo.width}
            height={photo.height}
            alt={photo.alt}
            draggable={false}
            fetchPriority="high"
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
      <style>{lightboxStyles}</style>
    </div>,
    document.body,
  );
}

const lightboxStyles = `
  .lb {
    position: fixed;
    inset: 0;
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 32px;
    overflow: hidden;
  }
  .lb__bg {
    position: absolute;
    inset: 0;
    background: color-mix(in oklab, var(--color-cream-top) 50%, transparent);
    backdrop-filter: blur(28px) saturate(115%);
    -webkit-backdrop-filter: blur(28px) saturate(115%);
    opacity: 0;
    will-change: opacity, backdrop-filter;
  }

  .lb__card {
    position: relative;
    background: var(--color-card);
    border-radius: 12px;
    padding: 18px;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: max-content;
    max-width: min(1120px, calc(100vw - 64px));
    max-height: calc(100vh - 64px);
    box-shadow: 0 28px 80px -30px rgba(28, 22, 12, 0.22);
    opacity: 0;
    transform: scale(0.94);
    will-change: opacity, transform;
  }

  .lb__media {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    transform-origin: center;
    will-change: transform, opacity;
  }
  .lb__img {
    display: block;
    max-width: min(1080px, calc(100vw - 100px));
    max-height: calc(100vh - 300px);
    width: auto;
    height: auto;
    object-fit: contain;
    border-radius: 7px;
    user-select: none;
  }

  .lb__caption {
    flex: 0 0 auto;
    margin-top: 18px;
    padding: 0 8px 4px;
    text-align: center;
    color: var(--color-ink);
    width: 100%;
    max-width: 720px;
    font-family: var(--font-serif);
    opacity: 0;
  }
  .lb__caption .caption { display: flex; flex-direction: column; align-items: center; }
  .lb__caption .caption__title {
    font-family: var(--font-serif);
    font-size: 22px;
    line-height: 1.2;
    letter-spacing: 0;
    color: var(--color-ink);
    margin: 0;
  }
  .lb__caption .caption__sub {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: 14px;
    color: color-mix(in oklab, var(--color-ink) 65%, transparent);
    margin: 2px 0 10px;
  }
  .lb__caption .caption__meta {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 2px 14px;
    font-size: 12.5px;
    color: color-mix(in oklab, var(--color-ink) 60%, transparent);
    margin: 4px 0 0;
  }
  .lb__caption .caption__scene {
    font-family: var(--font-serif);
    font-style: italic;
    font-size: 13.5px;
    line-height: 1.55;
    color: color-mix(in oklab, var(--color-ink) 70%, transparent);
    margin: 10px 0 0;
    max-width: 58ch;
  }
  .lb__caption .caption__exif {
    font-family: var(--font-serif);
    font-size: 11px;
    color: color-mix(in oklab, var(--color-ink) 45%, transparent);
    letter-spacing: 0.015em;
    margin-top: 8px;
  }

  .lb__close {
    position: absolute;
    top: 24px;
    right: 24px;
    width: 32px;
    height: 32px;
    border-radius: 999px;
    border: 0;
    cursor: pointer;
    background: color-mix(in oklab, var(--color-cream-top) 75%, transparent);
    color: var(--color-ink);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px -3px rgba(28, 22, 12, 0.25);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    opacity: 0;
    transition: background-color 200ms ease;
  }
  .lb__close:hover {
    background: color-mix(in oklab, var(--color-cream-top) 95%, transparent);
  }

  @media (max-width: 640px) {
    .lb { padding: 16px; }
    .lb__card {
      padding: 12px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 32px);
      border-radius: 10px;
    }
    .lb__img {
      max-width: calc(100vw - 60px);
      max-height: calc(100vh - 240px);
    }
    .lb__caption { margin-top: 14px; padding: 0 4px 4px; }
    .lb__caption .caption__title { font-size: 18px; }
    .lb__caption .caption__sub { font-size: 13px; }
    .lb__caption .caption__scene { font-size: 13px; }
    .lb__close { top: 16px; right: 16px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .lb__bg,
    .lb__card,
    .lb__media,
    .lb__caption,
    .lb__close {
      transition: none !important;
      animation: none !important;
    }
  }
`;
