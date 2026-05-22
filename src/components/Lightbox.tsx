import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export type LightboxPhoto = {
  // Medium variant (~1440w). Used during the open animation and the
  // morph swap so the browser doesn't have to re-rasterize the big
  // full-res bitmap at varying sizes every frame.
  src: string;
  srcSet?: readonly { src: string; width: number }[];
  // Full-resolution original (~2200w). The lightbox swaps the
  // persistent img to this once it's settled (phase === 'open' and
  // no swap in flight).
  fullSrc: string;
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
  // Fires when the user arrows to a different photo. Gallery uses this
  // to hide the new thumb (and reveal the old one) and to push a fresh
  // `fromRect` for the close FLIP back through the `state` prop.
  onIndexChange?: (newIndex: number) => void;
  // Fires at the *start* of close (vs onClose, which fires at the end
  // after the close FLIP completes). Lets the parent cancel any
  // in-flight scroll animation and snap the page to the final scroll
  // position so the close FLIP doesn't chase a moving target.
  onCloseStart?: () => void;
}

type Phase = 'closed' | 'opening' | 'open' | 'closing';

const OPEN_DURATION = 700;
const CLOSE_DURATION = 520;
const OPEN_EASING = 'cubic-bezier(0.22, 0.78, 0.18, 1)';
const CLOSE_EASING = 'cubic-bezier(0.4, 0.0, 0.2, 1)';

type Flip = { tx: number; ty: number; scale: number };

// Mirrors the CSS max-width / max-height rules on .lb__media so we can
// compute the rendered size from the photo's metadata alone, without
// needing the image bytes to be loaded. That lets us set explicit pixel
// width/height on the media wrapper at render time — which gives the
// element real layout dimensions on the first frame, so FLIP works on
// first click even for uncached images.
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

// Duration of an arrow-key swap. The media wrapper morphs from the old
// photo's rendered dims to the new's while the outgoing image fades to
// 0 and the incoming image fades from 0 to 1 in lockstep. Touch
// devices (i.e. iPhone) get a shorter window — the combined cost of
// width/height layout + the card-bg's blurred shadow re-rasterizing
// + scaling the full-res JPEG every frame visibly hitches on iOS at
// 440ms. A shorter morph lets motion blur cover what the GPU can't.
const IS_TOUCH_DEVICE =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(pointer: coarse)').matches;
const NAV_DURATION = IS_TOUCH_DEVICE ? 320 : 440;
const NAV_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)';

// Type tag for the second <img> rendered during a swap. The outgoing
// image stays under its original ref so getBoundingClientRect keeps
// returning a stable rect; the incoming image is the new one.
type SwapInfo = {
  photo: LightboxPhoto;
  dims: { width: number; height: number };
};

export default function Lightbox({ state, onClose, onIndexChange, onCloseStart }: Props) {
  const [active, setActive] = useState<LightboxState | null>(null);
  const [phase, setPhase] = useState<Phase>('closed');
  const [mounted, setMounted] = useState(false);
  // The outgoing photo, rendered alongside the new one during a swap so
  // they can truly crossfade (both visible simultaneously). Cleared
  // when the swap animation finishes.
  const [outgoing, setOutgoing] = useState<SwapInfo | null>(null);

  // Synchronous re-entry guard for navigate(). React state (useState) is
  // updated asynchronously, so two rapid arrow presses can both read
  // `navInfo == null` before either setState commits and end up racing.
  // A ref flips synchronously, so the second press in the same tick
  // sees `true` and bails. Also tracks the latest committed index so we
  // don't compute the next target from stale `prev` inside setState.
  const navBusyRef = useRef(false);
  const currentIndexRef = useRef(0);
  // Synchronous re-entry guard for close(). The phase === 'closing'
  // check below is React state and updates asynchronously, so a
  // double-tap on the close button or an Esc-then-click race can run
  // close() twice — the second call captures the in-flight close
  // animation as the "current" state, cancels it, and starts a NEW
  // close animation from somewhere already mid-flight. That's the
  // "teleports toward its initial position" symptom.
  const closingRef = useRef(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const cardBgRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const captionRef = useRef<HTMLDivElement>(null);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  // Start position + timestamp of the active single-finger touch.
  // Cleared on touchend/touchcancel or when a second finger lands.
  const touchStartRef = useRef<{ x: number; y: number; t: number } | null>(null);
  // Holds the Image objects used to preload neighbors. Keeping a strong
  // reference until the next nav prevents the browser from dropping
  // the decoded bitmap before the user actually arrows to it.
  const preloadRef = useRef<HTMLImageElement[]>([]);
  // Tracks the (photos, index) we last preloaded for so quick
  // back-and-forth nav doesn't re-fire Image() constructors for the
  // same neighbors.
  const preloadKeyRef = useRef<{ photos: readonly LightboxPhoto[]; index: number } | null>(null);

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
      currentIndexRef.current = state.index;
      setPhase('opening');
    }
  }, [state, active]);

  const close = useCallback(() => {
    if (closingRef.current) return;
    if (phase === 'closing' || phase === 'closed' || !active) return;
    closingRef.current = true;

    // Cancel any in-flight navigation animations so their leftover
    // transforms / sizes don't compose with the card's close transform
    // (which would visually offset the image during the FLIP shrink
    // back to the thumbnail). Drop the outgoing layer immediately.
    // Also force the media wrapper to the new photo's final size so the
    // FLIP rect computation below sees the correct dimensions, not the
    // wrapper frozen mid-resize.
    if (navBusyRef.current) {
      mediaRef.current?.getAnimations().forEach((a) => a.cancel());
      imgRef.current?.getAnimations().forEach((a) => a.cancel());
      // The outgoing img is a separate DOM node — its 1→0 opacity
      // animation lives on that element, not on imgRef. Without
      // cancelling it, the orphaned animation would keep holding the
      // element at low opacity during the close FLIP.
      mediaRef.current
        ?.querySelector<HTMLImageElement>('.lb__img--outgoing')
        ?.getAnimations()
        .forEach((a) => a.cancel());
      captionRef.current?.getAnimations().forEach((a) => a.cancel());
      const finalDims = expectedImageDims(active.photos[active.index]);
      if (mediaRef.current) {
        mediaRef.current.style.width = `${finalDims.width}px`;
        mediaRef.current.style.height = `${finalDims.height}px`;
      }
      navBusyRef.current = false;
      setOutgoing(null);
    }

    // Notify the parent that close is starting *now* (vs onClose,
    // which fires at the end). Gallery uses this to cancel its
    // in-flight scroll RAF and snap the page to the final target,
    // so the close FLIP doesn't aim at a thumb that's still moving.
    onCloseStart?.();

    // Body class flag for any concurrent main-thread work elsewhere
    // on the page (notably the magnetic cursor's pixel-sampling loop)
    // to pause during the close FLIP. The cursor's drawImage +
    // getImageData round-trip is small per call but it runs on the
    // main thread alongside React's commit phase and competes for
    // budget during the first few frames of close — exactly where
    // dropped frames read as "the card teleporting toward the thumb".
    document.body.classList.add('lb-animating');

    setPhase('closing');

    const card = cardRef.current;
    const img = imgRef.current;
    const cardBg = cardBgRef.current;
    const bg = bgRef.current;
    const caption = captionRef.current;
    const closeBtn = closeBtnRef.current;

    // Prefer the latest fromRect from the parent (state prop) — Gallery
    // updates it whenever the user arrows to a new photo, so we FLIP
    // back to the thumbnail of the photo actually being viewed, not the
    // one originally clicked.
    const fromRect = state?.fromRect ?? active.fromRect;

    let toTransform = 'translate(0, 0) scale(1)';
    if (card && img) {
      const flip = computeFlip(card, img, fromRect);
      if (flip) {
        toTransform = `translate(${flip.tx.toFixed(2)}px, ${flip.ty.toFixed(2)}px) scale(${flip.scale.toFixed(4)})`;
      }
    }

    const opts: KeyframeAnimationOptions = {
      duration: CLOSE_DURATION,
      easing: CLOSE_EASING,
      fill: 'forwards',
    };

    // Just animate opacity on the backdrop — DON'T animate
    // backdrop-filter radius. Animating blur from 28px→0px forces a
    // full-viewport pixel-sampling pass every frame, and on weaker
    // GPUs (iOS Safari especially) the work spills into the main
    // thread and drops frames *across all the close animations* —
    // visible as the card "teleporting" or skipping frames toward
    // the thumbnail. With static blur, the radius doesn't change
    // each frame; the backdrop fades out via alpha alone, which the
    // compositor can handle cheaply.
    bg?.animate([{ opacity: 1 }, { opacity: 0 }], opts);
    closeBtn?.animate([{ opacity: 1 }, { opacity: 0 }], { ...opts, duration: 220 });
    // Single-keyframe form: WAAPI interpolates from the element's
    // current computed opacity to 0. Important when closing mid-nav,
    // where the caption's 1→0→1 nav animation may have it at any
    // intermediate value — a leading {opacity:1} keyframe would snap
    // back to fully visible before fading, producing a visible flash.
    caption?.animate([{ opacity: 0 }], { ...opts, duration: 240 });
    cardBg?.animate([{ opacity: 1 }, { opacity: 0 }], {
      ...opts,
      duration: CLOSE_DURATION * 0.85,
    });

    // Capture the card's current computed transform BEFORE cancelling
    // any in-flight open animation. If the user closes while the open
    // FLIP is still running (or before any animation has touched the
    // card), commitStyles pins the current value as inline style and
    // we animate from there to the close target — no snap to identity
    // and no "teleport toward initial position" caused by the new
    // animation overriding mid-flight with its from-keyframe.
    let cardAnim: Animation | null = null;
    if (card) {
      const live = card.getAnimations();
      const fromTransform = window.getComputedStyle(card).transform;
      for (const a of live) {
        try {
          a.commitStyles();
        } catch {
          // commitStyles can throw if the animation has no effect; ignore.
        }
        a.cancel();
      }
      card.style.transform = fromTransform === 'none' ? '' : fromTransform;
      cardAnim = card.animate(
        [
          { transform: fromTransform === 'none' ? 'translate(0, 0) scale(1)' : fromTransform },
          { transform: toTransform },
        ],
        opts,
      );
    }

    const finish = () => {
      document.body.classList.remove('lb-animating');
      closingRef.current = false;
      setPhase('closed');
      setActive(null);
      onClose();
    };

    // Use the card animation's finished promise (vs setTimeout) so the
    // unmount lands on the same frame as the FLIP's last keyframe,
    // never one or two frames early — that gap is what reads as the
    // image "teleporting" the final stretch.
    if (cardAnim) {
      cardAnim.finished.then(finish).catch(finish);
    } else {
      window.setTimeout(finish, CLOSE_DURATION);
    }
  }, [phase, active, onClose, onCloseStart, state]);

  // Arrow-key navigation between photos. Both the outgoing and incoming
  // images are rendered together inside the media wrapper; the wrapper
  // morphs between the two aspect ratios while opacity crosses over —
  // outgoing 1→0, incoming 0→1, in lockstep — so the cream card is
  // never visible through both at once.
  const navigate = useCallback(
    (direction: 1 | -1) => {
      if (!active || phase !== 'open' || navBusyRef.current) return;
      const fromIndex = currentIndexRef.current;
      const newIndex = fromIndex + direction;
      if (newIndex < 0 || newIndex >= active.photos.length) return;

      const media = mediaRef.current;
      const img = imgRef.current;
      const caption = captionRef.current;
      if (!media || !img) return;

      navBusyRef.current = true;
      currentIndexRef.current = newIndex;

      // Clear any leftover animations on the same elements so their
      // fill:both values don't compose with the new ones (would freeze
      // the image at the previous keyframe).
      img.getAnimations().forEach((a) => a.cancel());
      media.getAnimations().forEach((a) => a.cancel());
      caption?.getAnimations().forEach((a) => a.cancel());

      const oldPhoto = active.photos[fromIndex];
      const newPhoto = active.photos[newIndex];
      const oldDims = expectedImageDims(oldPhoto);
      const newDims = expectedImageDims(newPhoto);

      // Mount the new photo immediately as the "primary" image (under
      // imgRef) and keep the old one as the outgoing overlay. That way
      // when the swap finishes, imgRef already points to the new image
      // and no further DOM swap is needed.
      setOutgoing({ photo: oldPhoto, dims: oldDims });
      setActive((prev) => (prev ? { ...prev, index: newIndex } : prev));
      onIndexChange?.(newIndex);

      // Animations are applied after React commits the new img (the
      // useLayoutEffect below sees navBusyRef.current === true and runs
      // the crossfade). We start the media-wrapper resize here so it
      // begins from the old dims even on the first frame.
      const resizeKeyframes: Keyframe[] = [
        { width: `${oldDims.width}px`, height: `${oldDims.height}px` },
        { width: `${newDims.width}px`, height: `${newDims.height}px` },
      ];
      const resize = media.animate(resizeKeyframes, {
        duration: NAV_DURATION,
        easing: NAV_EASING,
        fill: 'both',
      });

      // Caption animations are wired up in the useLayoutEffect below
      // (alongside the image fades) so both the persistent and the
      // outgoing caption element exist in the DOM by the time the
      // animations attach.

      resize.finished
        .then(() => {
          navBusyRef.current = false;
          setOutgoing(null);
        })
        .catch(() => {
          navBusyRef.current = false;
          setOutgoing(null);
        });
    },
    [active, phase, onIndexChange],
  );

  // Touch swipe navigation for mobile. Mirrors the arrow-key behaviour:
  // swipe-left → next photo, swipe-right → previous. We track a single
  // finger; multi-touch (pinch, two-finger swipe) cancels tracking so
  // we don't navigate on accidental gestures. The threshold/duration
  // are tuned to feel snappy without firing on slow vertical pans.
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length !== 1) {
      touchStartRef.current = null;
      return;
    }
    const t = e.touches[0];
    touchStartRef.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, []);

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const start = touchStartRef.current;
      touchStartRef.current = null;
      if (!start || e.changedTouches.length !== 1) return;
      const end = e.changedTouches[0];
      const dx = end.clientX - start.x;
      const dy = end.clientY - start.y;
      const dt = Date.now() - start.t;
      if (Math.abs(dx) < 50) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (dt > 600) return;
      navigate(dx < 0 ? 1 : -1);
    },
    [navigate],
  );

  const onTouchCancel = useCallback(() => {
    touchStartRef.current = null;
  }, []);

  // Kick off the opacity crossfade on the two image layers once React
  // has committed both. Runs in useLayoutEffect so the animations are
  // attached before the next paint — no flash of the new image at full
  // opacity before its 0→1 keyframe starts.
  useLayoutEffect(() => {
    if (!outgoing) return;
    const newImg = imgRef.current;
    const oldImg = mediaRef.current?.querySelector<HTMLImageElement>('.lb__img--outgoing');
    const newCap = captionRef.current;
    if (!newImg || !oldImg) return;

    const opts: KeyframeAnimationOptions = {
      duration: NAV_DURATION,
      easing: 'linear',
      fill: 'both',
    };
    oldImg.animate([{ opacity: 1 }, { opacity: 0 }], opts);
    newImg.animate([{ opacity: 0 }, { opacity: 1 }], opts);
    // navigate() cancelled the caption's prior WAAPI animation
    // (which was holding opacity:1 via fill:'both'), so without
    // *some* animation here the caption returns to its CSS default
    // of opacity:0 and stays invisible. Use a 0.5 → 1 fade with
    // fill:'both' to both restore opacity and provide a subtle
    // text settle. Cheap; opacity is GPU-composited.
    newCap?.animate([{ opacity: 0.5 }, { opacity: 1 }], opts);
  }, [outgoing]);

  // useLayoutEffect (not useEffect) so the WAAPI animations are applied
  // synchronously after React commits but BEFORE the browser paints — no
  // 1-frame flash of the card at its final centered position before the
  // FLIP transform "snaps" it back to the thumbnail.
  //
  // Animations run IMMEDIATELY — never wait for the image to load. The
  // media wrapper has explicit px width/height, so the browser knows
  // the final constrained size before the image bytes arrive. That
  // makes getBoundingClientRect return real numbers on first click, so
  // FLIP works on uncached images too, and the LQIP background fills
  // the space until the WebP arrives.
  useLayoutEffect(() => {
    if (phase !== 'opening' || !active) return;
    const card = cardRef.current;
    const img = imgRef.current;
    const cardBg = cardBgRef.current;
    const bg = bgRef.current;
    const caption = captionRef.current;
    const closeBtn = closeBtnRef.current;
    if (!card || !img || !bg) return;

    // Same body-class signal used by close — it suppresses the
    // site-header's backdrop-filter + mask-image and pauses cursor
    // pixel sampling during the open animation too. Header sits at
    // z-index 50 behind the lightbox; its backdrop-filter recomputes
    // every frame as .lb__bg's opacity animates 0 → 1.
    document.body.classList.add('lb-animating');

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
    // The media wrapper has explicit px dims, so it has real layout
    // size from frame zero. The LQIP background on the img shows in
    // that space until the WebP arrives.
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

    const finishOpen = () => {
      document.body.classList.remove('lb-animating');
      setPhase('open');
    };
    cardAnim.finished.then(finishOpen).catch(() => {
      document.body.classList.remove('lb-animating');
    });
  }, [phase, active]);

  // Latest close/navigate handlers held in refs so the open/close
  // effect below can depend on `active` alone. Without this, both
  // useCallbacks change reference on every phase transition and every
  // state-prop update from Gallery (each arrow nav refreshes fromRect),
  // tearing down + re-establishing the document keydown listener and
  // re-running lenis.stop() + body.overflow writes on every render
  // while the lightbox is open.
  const latestCloseRef = useRef(close);
  const latestNavigateRef = useRef(navigate);
  latestCloseRef.current = close;
  latestNavigateRef.current = navigate;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') latestCloseRef.current();
      else if (e.key === 'ArrowRight') {
        e.preventDefault();
        latestNavigateRef.current(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        latestNavigateRef.current(-1);
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
  }, [active]);

  // Preload to support the progressive-loading scheme:
  //   - Current photo's full-res, so the "settle to fullSrc" swap
  //     after the open animation is instant.
  //   - Neighbors' medium, so the morph crossfade starts from a
  //     cached + decoded bitmap.
  //   - Neighbors' full-res, so once the user lands on a neighbor
  //     and the morph completes, the upgrade to fullSrc is instant.
  //
  // fetchPriority is high for the morph-critical assets (current's
  // fullSrc, neighbors' medium); the neighbors' fullSrc gets low
  // priority since we have a full NAV_DURATION to load it. decode()
  // pre-warms the decoded-bitmap cache so the actual <img> doesn't
  // pay decode cost on first paint.
  //
  // preloadRef retains references so the bitmaps aren't GC'd before
  // the user navigates.
  useEffect(() => {
    if (!active) return;
    // Skip if we already preloaded neighbors for this exact (photos,
    // index). Active's identity changes on every nav even when the
    // user navigates back to where they were, so without this guard
    // we'd re-fire Image() decode() for already-cached neighbors.
    const prevKey = preloadKeyRef.current;
    if (prevKey && prevKey.photos === active.photos && prevKey.index === active.index) {
      return;
    }
    preloadKeyRef.current = { photos: active.photos, index: active.index };

    const preloadImage = (
      src: string,
      srcset: string | undefined,
      priority: 'high' | 'low',
    ): HTMLImageElement => {
      const im = new Image();
      im.fetchPriority = priority;
      if (srcset) {
        im.srcset = srcset;
        im.sizes = '100vw';
      }
      im.src = src;
      im.decode().catch(() => {});
      return im;
    };

    const refs: HTMLImageElement[] = [];

    // Current photo's full-res: only needed on desktop (mobile's
    // <img> element loads fullSrc directly since useFullRes is true).
    // Preloading in parallel means the post-open settle-to-fullSrc
    // swap is instant on a fast network.
    if (!IS_TOUCH_DEVICE) {
      refs.push(
        preloadImage(active.photos[active.index].fullSrc, undefined, 'high'),
      );
    }

    // Neighbors. Desktop wants both: medium (high priority — drives
    // the morph) + fullSrc (low priority — picked up for the
    // post-morph upgrade). Mobile only needs fullSrc — it never
    // displays the medium variant.
    const preloadNeighbor = (p: LightboxPhoto): void => {
      if (!IS_TOUCH_DEVICE) {
        const mediumSrcSet = p.srcSet
          ?.map((v) => `${v.src} ${v.width}w`)
          .join(', ');
        refs.push(preloadImage(p.src, mediumSrcSet, 'high'));
      }
      refs.push(
        preloadImage(p.fullSrc, undefined, IS_TOUCH_DEVICE ? 'high' : 'low'),
      );
    };

    const photos = active.photos;
    const i = active.index;
    if (i + 1 < photos.length) preloadNeighbor(photos[i + 1]);
    if (i - 1 >= 0) preloadNeighbor(photos[i - 1]);

    preloadRef.current = refs;
  }, [active]);

  if (!mounted || !active || phase === 'closed') return null;

  const photo = active.photos[active.index];
  const srcSet = photo.srcSet?.map((v) => `${v.src} ${v.width}w`).join(', ');
  // Compute the exact rendered px size now, before the media wrapper
  // mounts, so it has real layout dimensions from frame zero — FLIP
  // works on first click for uncached images.
  const renderedDims = expectedImageDims(photo);

  // During a swap the wrapper's size is driven by the WAAPI resize
  // animation, but we still set a sensible initial inline size so the
  // first paint isn't 0×0. We use the *outgoing* dims as the starting
  // value during a swap; the WAAPI animation immediately overrides.
  const wrapperDims = outgoing?.dims ?? renderedDims;

  // Progressive loading on desktop: show the medium variant while
  // anything is animating, swap to the full-resolution original once
  // settled. Mobile (touch / pointer:coarse) skips the progressive
  // scheme entirely and stays on fullSrc throughout — the medium-to-
  // full swap was reading as a visible quality lift on retina screens,
  // and the user prefers consistent crispness even with the slightly
  // heavier morph render cost. The other iOS perf knobs (shorter
  // NAV_DURATION, lighter shadow during swap, layout containment)
  // pick up the slack.
  const useFullRes =
    IS_TOUCH_DEVICE || (!outgoing && phase !== 'opening');
  const displayedSrc = useFullRes ? photo.fullSrc : photo.src;
  const displayedSrcSet = useFullRes ? undefined : srcSet;

  return createPortal(
    <div
      className={`lb lb--${phase}`}
      role="dialog"
      aria-modal="true"
      aria-label={photo.alt}
      onClick={close}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      onTouchCancel={onTouchCancel}
    >
      <div className="lb__bg" ref={bgRef} aria-hidden="true" />
      <div
        className="lb__card"
        ref={cardRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="lb__card-bg" ref={cardBgRef} aria-hidden="true" />
        <div
          className="lb__media"
          ref={mediaRef}
          style={{
            width: `${wrapperDims.width}px`,
            height: `${wrapperDims.height}px`,
          }}
        >
          {outgoing && (
            <img
              key="outgoing"
              className="lb__img lb__img--outgoing"
              // Use the full-res source: it was the persistent's src
              // immediately before the nav started, so its decoded
              // bitmap is in cache and there's no visible quality
              // drop at t=0 of the crossfade.
              src={outgoing.photo.fullSrc}
              sizes="100vw"
              alt=""
              draggable={false}
              aria-hidden="true"
              // async decode (not sync): on mobile, blocking paint
              // while the cached bytes decode produces a visible
              // hitch at the start of the crossfade. The img was just
              // on-screen as the persistent one, so its bitmap is
              // typically still in the decoded-image cache and paints
              // immediately even with async.
              decoding="async"
              style={
                outgoing.photo.lqip
                  ? {
                      backgroundImage: `url(${outgoing.photo.lqip})`,
                      backgroundSize: 'cover',
                      backgroundPosition: 'center',
                    }
                  : undefined
              }
            />
          )}
          <img
            ref={imgRef}
            key="current"
            className="lb__img"
            src={displayedSrc}
            srcSet={displayedSrcSet}
            sizes={displayedSrcSet ? '100vw' : undefined}
            width={photo.width}
            height={photo.height}
            alt={photo.alt}
            draggable={false}
            fetchPriority="high"
            decoding="async"
            // Once the real image has loaded, clear the LQIP background
            // — keeping it set composites a data-URL image behind the
            // letterbox pixels every frame the layer repaints, for
            // zero benefit (the JPEG fully covers it via object-fit).
            onLoad={(e) => {
              const el = e.currentTarget;
              if (el.style.backgroundImage) {
                el.style.backgroundImage = '';
              }
            }}
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
      <button
        type="button"
        className="lb__nav lb__nav--prev"
        aria-label="Previous photo"
        disabled={active.index === 0}
        onClick={(e) => {
          e.stopPropagation();
          navigate(-1);
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M14 6 L8 12 L14 18"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </button>
      <button
        type="button"
        className="lb__nav lb__nav--next"
        aria-label="Next photo"
        disabled={active.index === active.photos.length - 1}
        onClick={(e) => {
          e.stopPropagation();
          navigate(1);
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
          <path
            d="M10 6 L16 12 L10 18"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
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
