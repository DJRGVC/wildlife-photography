import { useEffect, useRef } from 'react';
import {
  RowsPhotoAlbum,
  type Photo,
  type RenderImageContext,
} from 'react-photo-album';
import 'react-photo-album/rows.css';

export type AnimalEntry = {
  common_name: string;
  scientific_name: string;
  subject: string;
  notes: string;
};

export type GalleryPhoto = Photo & {
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

function PhotoAlbumBlock({
  photos,
  showAnimalTitle,
  containerId,
}: {
  photos: readonly GalleryPhoto[];
  showAnimalTitle: boolean;
  containerId: string;
}) {
  return (
    <div className="gallery__inner" id={containerId}>
      <RowsPhotoAlbum
        photos={photos as unknown as Photo[]}
        targetRowHeight={340}
        spacing={6}
        padding={0}
        defaultContainerWidth={1152}
        rowConstraints={{ singleRowMaxHeight: 480 }}
        render={{
          image: (imgProps, ctx: RenderImageContext<Photo>) => {
            const p = ctx.photo as GalleryPhoto;
            const srcSet = (p.srcSet ?? [])
              .map((v) => `${v.src} ${v.width}w`)
              .join(', ');
            const alt = altText(p);
            return (
              <a
                className="gallery__item"
                href={p.fullSrc}
                data-pswp-width={p.fullWidth}
                data-pswp-height={p.fullHeight}
                data-caption-html={renderCaption(p, showAnimalTitle)}
                aria-label={alt}
                target="_blank"
                rel="noreferrer"
                style={{ display: 'block', width: ctx.width, height: ctx.height }}
              >
                <img
                  {...imgProps}
                  src={p.src}
                  srcSet={srcSet || undefined}
                  sizes={`(max-width: 600px) 100vw, ${Math.round(ctx.width)}px`}
                  alt={alt}
                  width={ctx.width}
                  height={ctx.height}
                  loading="lazy"
                  decoding="async"
                  style={{
                    display: 'block',
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    backgroundImage: `url(${p.lqip})`,
                    backgroundSize: 'cover',
                    backgroundPosition: 'center',
                    transition: 'opacity 200ms ease',
                  }}
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
  const galleryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = galleryRef.current;
    if (!root) return;
    if (wildlife.length === 0 && misc.length === 0) return;

    let lightbox: { destroy(): void } | null = null;
    let cancelled = false;

    (async () => {
      const [
        { default: PhotoSwipeLightbox },
        { default: CaptionPlugin },
      ] = await Promise.all([
        import('photoswipe/lightbox'),
        import('photoswipe-dynamic-caption-plugin'),
        import('photoswipe/style.css'),
        import('photoswipe-dynamic-caption-plugin/photoswipe-dynamic-caption-plugin.css'),
      ]);

      if (cancelled) return;

      const lb = new PhotoSwipeLightbox({
        gallery: root,
        children: 'a.gallery__item',
        pswpModule: () => import('photoswipe'),
        bgOpacity: 0.96,
        showHideAnimationType: 'fade',
        showAnimationDuration: 250,
        hideAnimationDuration: 250,
      });

      new CaptionPlugin(lb, {
        type: 'auto',
        captionContent: (slide: { data: { element?: HTMLElement } }) => {
          return slide.data.element?.dataset.captionHtml ?? '';
        },
      });

      lb.init();
      lightbox = lb as unknown as { destroy(): void };
    })();

    return () => {
      cancelled = true;
      lightbox?.destroy();
    };
  }, [wildlife.length, misc.length]);

  if (wildlife.length === 0 && misc.length === 0) {
    return (
      <section className="gallery gallery--empty" aria-label="Photography gallery">
        <p className="gallery__empty">
          No photos yet. Drop tagged JPEGs into <code>src/photography/wildlife/</code> or{' '}
          <code>src/photography/misc/</code> and they will appear here.
        </p>
        <style>{galleryStyles}</style>
      </section>
    );
  }

  return (
    <section className="gallery" aria-label="Photography gallery" ref={galleryRef}>
      {wildlife.length > 0 && (
        <PhotoAlbumBlock
          photos={wildlife}
          showAnimalTitle={true}
          containerId="gallery-wildlife"
        />
      )}
      {wildlife.length > 0 && misc.length > 0 && (
        <div className="gallery__sep" role="separator" aria-hidden="true">
          <span>·</span>
        </div>
      )}
      {misc.length > 0 && (
        <PhotoAlbumBlock
          photos={misc}
          showAnimalTitle={false}
          containerId="gallery-misc"
        />
      )}
      <style>{galleryStyles}</style>
    </section>
  );
}

const galleryStyles = `
  .gallery {
    padding-block: 8px 96px;
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
    justify-content: center;
    align-items: center;
    margin-block: 80px;
    color: var(--color-ink-faint);
    font-family: var(--font-serif);
    font-size: 24px;
    line-height: 1;
    user-select: none;
  }
  .gallery__sep span {
    display: inline-block;
    transform: translateY(-2px);
  }
  .gallery__item {
    display: block;
    overflow: hidden;
    text-decoration: none;
    cursor: zoom-in;
  }
  .gallery__item img {
    transition: opacity 200ms ease;
  }
  @media (hover: hover) {
    .gallery__item:hover img {
      opacity: 0.85;
    }
  }
  @media (max-width: 600px) {
    .gallery__sep {
      margin-block: 56px;
      font-size: 20px;
    }
  }
`;
