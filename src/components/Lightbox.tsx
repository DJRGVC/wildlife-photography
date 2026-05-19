import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type LightboxPhoto = {
  src: string;
  width: number;
  height: number;
  alt: string;
  captionHtml: string;
};

interface Props {
  photo: LightboxPhoto | null;
  onClose: () => void;
}

type Phase = 'closed' | 'opening' | 'open' | 'closing';

export default function Lightbox({ photo, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('closed');
  const [mounted, setMounted] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => setMounted(true), []);

  const close = useCallback(() => {
    setPhase('closing');
    window.setTimeout(() => {
      setPhase('closed');
      onClose();
    }, 320);
  }, [onClose]);

  useEffect(() => {
    if (photo && phase === 'closed') {
      setPhase('opening');
      const raf1 = requestAnimationFrame(() => {
        const raf2 = requestAnimationFrame(() => setPhase('open'));
        return () => cancelAnimationFrame(raf2);
      });
      return () => cancelAnimationFrame(raf1);
    }
  }, [photo, phase]);

  useEffect(() => {
    if (!photo) return;
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
  }, [photo, close]);

  if (!mounted || !photo || phase === 'closed') return null;

  return createPortal(
    <div
      className={`lb lb--${phase}`}
      role="dialog"
      aria-modal="true"
      aria-label={photo.alt}
      onClick={close}
    >
      <div className="lb__bg" aria-hidden="true" />
      <div
        className="lb__card"
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lb__media">
          <img
            className="lb__img"
            src={photo.src}
            width={photo.width}
            height={photo.height}
            alt={photo.alt}
            draggable={false}
            fetchPriority="high"
          />
        </div>
        <div
          className="lb__caption"
          dangerouslySetInnerHTML={{ __html: photo.captionHtml }}
        />
      </div>
      <button
        type="button"
        className="lb__close"
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
  }
  .lb__bg {
    position: absolute;
    inset: 0;
    background: color-mix(in oklab, var(--color-cream-top) 50%, transparent);
    backdrop-filter: blur(28px) saturate(115%);
    -webkit-backdrop-filter: blur(28px) saturate(115%);
    opacity: 0;
    transition: opacity 320ms ease;
  }
  .lb--opening .lb__bg,
  .lb--open .lb__bg { opacity: 1; }
  .lb--closing .lb__bg { opacity: 0; }

  .lb__card {
    position: relative;
    background: var(--color-card);
    border-radius: 12px;
    padding: 18px;
    display: flex;
    flex-direction: column;
    align-items: center;
    max-width: min(1120px, calc(100vw - 64px));
    max-height: calc(100vh - 64px);
    box-shadow: 0 28px 80px -30px rgba(28, 22, 12, 0.22);
    opacity: 0;
    transform: scale(0.82);
    transition:
      opacity 360ms ease,
      transform 380ms cubic-bezier(0.18, 0.78, 0.22, 1);
    will-change: opacity, transform;
  }
  .lb--opening .lb__card,
  .lb--open .lb__card {
    opacity: 1;
    transform: scale(1);
  }
  .lb--closing .lb__card {
    opacity: 0;
    transform: scale(0.9);
  }

  .lb__media {
    display: flex;
    align-items: center;
    justify-content: center;
    max-width: 100%;
    max-height: calc(100vh - 240px);
    min-height: 0;
  }
  .lb__img {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 240px);
    width: auto;
    height: auto;
    border-radius: 7px;
    object-fit: contain;
    user-select: none;
  }

  .lb__caption {
    margin-top: 16px;
    padding: 0 8px 4px;
    text-align: center;
    color: var(--color-ink);
    width: 100%;
    max-width: 720px;
    font-family: var(--font-sans);
  }
  .lb__caption .caption { display: flex; flex-direction: column; align-items: center; }
  .lb__caption .caption__title {
    font-family: var(--font-serif);
    font-size: 22px;
    line-height: 1.2;
    letter-spacing: -0.005em;
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
    background: color-mix(in oklab, var(--color-cream-top) 70%, transparent);
    color: var(--color-ink);
    display: flex;
    align-items: center;
    justify-content: center;
    box-shadow: 0 2px 8px -3px rgba(28, 22, 12, 0.25);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    opacity: 0;
    transition: opacity 240ms ease, background-color 200ms ease;
  }
  .lb--open .lb__close { opacity: 1; }
  .lb__close:hover {
    background: color-mix(in oklab, var(--color-cream-top) 92%, transparent);
  }

  @media (max-width: 640px) {
    .lb { padding: 16px; }
    .lb__card {
      padding: 12px;
      max-width: calc(100vw - 32px);
      max-height: calc(100vh - 32px);
      border-radius: 10px;
    }
    .lb__media,
    .lb__img { max-height: calc(100vh - 220px); }
    .lb__caption { margin-top: 12px; padding: 0 4px 4px; }
    .lb__caption .caption__title { font-size: 18px; }
    .lb__caption .caption__sub { font-size: 13px; }
    .lb__caption .caption__scene { font-size: 13px; }
    .lb__close { top: 16px; right: 16px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .lb__card,
    .lb__bg {
      transition-duration: 80ms !important;
      transform: none !important;
    }
  }
`;
