# Wildlife Photography

A personal photography site. Astro + Tailwind v4, React island for the gallery,
PhotoSwipe lightbox, Lenis smooth scroll. Photos stored in Cloudflare R2,
served as a static site by Cloudflare Pages.

## Quick start

```sh
npm install
npm run dev     # http://localhost:4321
```

The dev server runs two things in parallel:

- a chokidar watcher that regenerates `src/image-data.json` whenever you drop
  a photo into `src/photography/`
- the Astro dev server with HMR

If you launch with no photos present, the gallery renders an "empty" message —
just add some to see it populate.

## Photo workflow

```text
camera SD card
    │
    │  npm run import-photos /path/to/sd/dcim wildlife
    │  (copies to src/photography/wildlife/, strips GPS — wildlife-ethics)
    ▼
src/photography/wildlife/IMG_0123.jpg
    │
    │  ./scripts/tag-photo.sh ... "Great Horned Owl" "Point Reyes" "owl,raptor"
    │  (or use Photo Mechanic / digiKam / XnViewMP)
    ▼
tagged IPTC metadata
    │
    │  npm run dev — watcher regenerates image-data.json
    │  (you see the photo in localhost:4321)
    ▼
ready to publish
    │
    │  npm run push-photos       # syncs originals to R2 (md5-diffed)
    │  git add -A && git commit -m "add owl photos"
    │  git push                  # CF Pages auto-deploys
    ▼
live
```

### Sections

Photos live in two subfolders:

- `src/photography/wildlife/` — wildlife photography (top section on the
  page; captions include the animal name from IPTC Headline)
- `src/photography/misc/` — anything else (bottom section; captions skip the
  animal title)

Drop files into whichever section fits. A minimalist separator between the two
shows up only when both sections have photos.

### Tagging conventions

Each wildlife photo's IPTC fields drive its caption. The tag-photo helper
wraps exiftool:

```sh
./scripts/tag-photo.sh src/photography/wildlife/IMG_0123.jpg \
  "Great Horned Owl" \
  "Point Reyes National Seashore" \
  "owl,raptor,point-reyes" \
  "Roosting at dusk on a coastal pine."
```

That writes:

| IPTC field         | Maps to                                         |
| :----------------- | :---------------------------------------------- |
| `Headline`         | Caption title (animal name) — wildlife only     |
| `City` / `Location`| Caption location (XMP:Location is also read)    |
| `Keywords`         | Searchable tags (not displayed yet)             |
| `Caption-Abstract` | Long description (not displayed yet)            |

EXIF fields are read straight from the file: `DateTimeOriginal`, `Make`,
`Model`, `LensModel`, `FocalLength`, `FNumber`, `ExposureTime`, `ISOSpeedRatings`.

### Misc photos

You don't need to tag misc photos. They show up sorted by EXIF date with a
caption built from location (if present), date, and EXIF chip.

## Customizing the site

| What                          | Where                                          |
| :---------------------------- | :--------------------------------------------- |
| Your name (header, footer)    | `src/components/Header.astro`, `Footer.astro`  |
| Bio paragraphs                | `src/components/Bio.astro`                     |
| Contact email + LinkedIn      | `src/components/Contact.astro`                 |
| Colors and fonts              | `src/styles/global.css` `@theme { }`           |
| Site URL (used for OG tags)   | `astro.config.mjs` → `site`                    |
| Gallery row height / spacing  | `src/components/Gallery.tsx`                   |
| Lightbox caption styling      | `src/styles/photoswipe.css`                    |

## Cloudflare R2 (storage)

Originals live in R2, not git. R2's free tier is 10 GB; egress is free, so
serving from CF Pages is cheap regardless of traffic.

### One-time R2 setup

1. Sign in to https://dash.cloudflare.com → R2 → Create bucket. Name it
   something like `wildlife-photography-originals`.
2. R2 → Manage R2 API Tokens → Create token. Scope it to the bucket above
   with Object Read & Write. Save the access key + secret.
3. Copy `.env.example` to `.env` and fill in:
   ```sh
   cp .env.example .env
   $EDITOR .env
   ```
4. `npm run push-photos` to upload everything currently in
   `src/photography/`. The script md5-diffs against R2 so re-running is cheap.

### CF Pages env

In the Pages project settings, add the same four R2 env vars
(`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`)
plus optionally `R2_PREFIX`. The Pages build runs `npm run build:cf`, which
pulls from R2 → regenerates `image-data.json` → builds Astro.

## Cloudflare Pages (hosting)

1. https://dash.cloudflare.com → Workers & Pages → Create → Connect to Git
2. Pick this repo. Build settings:
   - **Build command:** `npm run build:cf`
   - **Build output:** `dist`
   - **Environment variables:** the four R2 vars above
3. First build will pull every photo from R2 and process AVIF variants. After
   that, Astro caches optimized images so subsequent builds are much faster.

If you ever need to deploy from your laptop manually:

```sh
npm run build:cf
npm run deploy     # uses wrangler — needs `wrangler login` once
```

## Commands

| Command                    | Action                                                  |
| :------------------------- | :------------------------------------------------------ |
| `npm run dev`              | Watcher + Astro dev server at `localhost:4321`          |
| `npm run build`            | Local production build (assumes photos already local)   |
| `npm run build:cf`         | What CF Pages runs — pulls R2 first, then builds        |
| `npm run preview`          | Preview the production build locally                    |
| `npm run import-photos`    | Copy from SD card → strip GPS → drop in section folder  |
| `npm run tag-photo`        | Wrap exiftool for IPTC tagging                          |
| `npm run push-photos`      | Sync `src/photography/` → R2 (md5-diffed)               |
| `npm run pull-photos`      | Sync R2 → `src/photography/`                            |
| `npm run deploy`           | Wrangler Direct Upload to CF Pages                      |
| `npm run astro -- --help`  | Astro CLI                                               |

## Project layout

```text
wildlife-photography/
├── astro.config.mjs
├── package.json
├── wrangler.toml
├── public/                       favicons
├── scripts/
│   ├── build-photo-index.ts      EXIF + IPTC → image-data.json
│   ├── watch-photos.ts           chokidar watcher (npm run dev)
│   ├── push-photos.ts            local → R2
│   ├── pull-photos.ts            R2 → local (and CF Pages build)
│   ├── r2-client.ts              shared S3 client + dotenv
│   ├── import-photos.sh          camera SD → src/photography/<section>/
│   └── tag-photo.sh              exiftool wrapper for IPTC tagging
└── src/
    ├── components/               Header, Bio, Gallery (React), Contact, Footer, SmoothScroll
    ├── layouts/Base.astro
    ├── lib/photos.ts             import.meta.glob + Astro getImage → gallery data
    ├── pages/index.astro
    ├── photography/              .gitignored — local mirror of R2
    │   ├── wildlife/
    │   └── misc/
    ├── styles/                   global.css (Tailwind v4) + photoswipe.css
    ├── image-data.json           .gitignored — regenerated by the watcher
    └── env.d.ts
```

## Wildlife ethics

GPS coordinates are stripped at import time by `import-photos.sh`. Don't add
them back. Geotags on photos of breeding sites, dens, or rare species can put
animals at risk from disturbance or persecution.
