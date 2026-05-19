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

- a chokidar watcher that regenerates `src/image-data.json` whenever
  `src/photography/` or `data/*.json` changes
- the Astro dev server with HMR

## Where the data lives

The site is driven by a portfolio kept in `~/Pictures/portfolio_images/`
(culled, ID'd, geocoded by separate helper scripts). The wildlife-photography
project consumes a snapshot of that portfolio:

```text
data/
├── decisions_wildlife.json   {filename: "keep" | "reject"} for wildlife
├── decisions_misc.json       {filename: "keep" | "reject"} for misc
├── animal_ids.json           rich metadata per keeper:
│                               { categories, date, datetime, width, height,
│                                 location: {name, lat, lng}, scene,
│                                 animals: [{common_name, scientific_name,
│                                            subject, notes}],
│                                 confidence, notes }
└── locations.json            {date: {location, lat, lng}} — fallback when a
                              photo lacks an animal_ids entry (misc landscape
                              shots often only have a date+location pair)

src/photography/
├── wildlife/                 keeper JPEGs (.gitignored — synced from R2)
└── misc/                     keeper JPEGs (.gitignored — synced from R2)
```

The `build-photo-index.ts` script merges `data/*.json` + EXIF from each JPEG
(camera, lens, exposure) into `src/image-data.json`, which the gallery reads.

## Photo workflow

```text
~/Pictures/portfolio_images/        cull, geocode, ID with the helper scripts
    ├── decisions_wildlife.json     (portfolio_cull.py / portfolio_triage.py)
    ├── decisions_misc.json
    ├── animal_ids.json
    ├── locations.json
    └── *.jpg                       all candidate photos
                │
                │  npm run sync-portfolio       (in this project)
                ▼
data/*.json copied + src/photography/{wildlife,misc}/*.jpg synced
                │
                │  src/image-data.json regenerated
                ▼
npm run dev                         (local preview)
                │
                │  npm run push-photos          (originals → R2)
                │  git add -A && git commit && git push
                ▼
CF Pages builds → live site
```

`sync-portfolio` is idempotent. It diffs JSON files by mtime/size and only
copies what changed; for the photo folders it adds new keepers, refreshes any
that have changed bytes, and removes anything no longer in the keeper set.

By default it reads from `~/Pictures/portfolio_images/`. Override with:

```sh
PORTFOLIO_SOURCE=/some/other/path npm run sync-portfolio
```

## Sections

Photos live in two subfolders, each driven by its `decisions_*.json`:

- `src/photography/wildlife/` — wildlife photography (top section on the
  page; captions show animal common name + scientific name)
- `src/photography/misc/` — anything else (bottom section; captions skip the
  animal title and just show location + date + scene + EXIF)

A minimalist `·` separator sits between the two when both have photos.

## Captions

The lightbox caption is built from `animal_ids.json` + EXIF:

| Field                       | Source                                  |
| --------------------------- | --------------------------------------- |
| Common name (wildlife only) | `animals[0].common_name` (subject=primary preferred) |
| Scientific name (italic)    | `animals[0].scientific_name`            |
| Location                    | `animal_ids[file].location.name` → fallback `locations[date].location` |
| Date                        | `animal_ids[file].date` → fallback EXIF `DateTimeOriginal` |
| Scene description           | `animal_ids[file].scene`                |
| Camera · lens · exposure    | EXIF `Make+Model`, `LensModel`, `ExposureTime` + `FNumber` + `ISOSpeedRatings` |

## Customizing the site

| What                          | Where                                          |
| ----------------------------- | ---------------------------------------------- |
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

1. https://dash.cloudflare.com → R2 → Create bucket, e.g.
   `wildlife-photography-originals`.
2. R2 → Manage R2 API Tokens → Create token with Object Read & Write on the
   bucket. Save the access key + secret.
3. `cp .env.example .env` and fill in `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`.
4. `npm run push-photos` to upload everything currently in
   `src/photography/`. md5-diffed against R2 ETags, so re-running is cheap.

### CF Pages env

In the Pages project settings add the same four R2 env vars. The Pages build
command is `npm run build:cf`, which:

1. Pulls everything in R2 → `src/photography/{wildlife,misc}/`
2. Regenerates `image-data.json` from `data/*.json` + EXIF
3. Runs `astro build`

## Cloudflare Pages (hosting)

1. https://dash.cloudflare.com → Workers & Pages → Create → Connect to Git
2. Pick this repo. Build settings:
   - **Build command:** `npm run build:cf`
   - **Build output:** `dist`
   - **Environment variables:** the four R2 vars
3. First build pulls every photo from R2 and processes AVIF variants — slow.
   Subsequent Astro builds reuse the cache where possible.

To deploy manually from your laptop:

```sh
npm run build:cf
npm run deploy     # wrangler — needs `wrangler login` once
```

## Commands

| Command                    | Action                                                  |
| -------------------------- | ------------------------------------------------------- |
| `npm run dev`              | Watcher + Astro dev server at `localhost:4321`          |
| `npm run sync-portfolio`   | Pull latest from `~/Pictures/portfolio_images/`         |
| `npm run build:photos`     | Regenerate `src/image-data.json` from `data/` + EXIF    |
| `npm run build`            | Local production build (assumes photos already local)   |
| `npm run build:cf`         | What CF Pages runs — pulls R2 first, then builds        |
| `npm run preview`          | Preview the production build locally                    |
| `npm run push-photos`      | Sync `src/photography/` → R2 (md5/ETag-diffed)          |
| `npm run pull-photos`      | Sync R2 → `src/photography/`                            |
| `npm run import-photos`    | Copy from SD card → strip GPS → drop in section folder  |
| `npm run tag-photo`        | Wrap exiftool for IPTC tagging (only needed if you ever |
|                            | bypass the JSON workflow)                               |
| `npm run deploy`           | Wrangler Direct Upload to CF Pages                      |

## Project layout

```text
wildlife-photography/
├── astro.config.mjs
├── package.json
├── wrangler.toml
├── public/                       favicons
├── data/                         portfolio metadata snapshot (committed)
│   ├── decisions_wildlife.json
│   ├── decisions_misc.json
│   ├── animal_ids.json
│   └── locations.json
├── scripts/
│   ├── sync-portfolio.ts         ~/Pictures/portfolio_images → project
│   ├── build-photo-index.ts      data/*.json + EXIF → image-data.json
│   ├── watch-photos.ts           chokidar watcher
│   ├── push-photos.ts            local → R2
│   ├── pull-photos.ts            R2 → local (and CF Pages build)
│   ├── r2-client.ts              shared S3 client + dotenv
│   ├── import-photos.sh          camera SD → src/photography/<section>/
│   └── tag-photo.sh              exiftool IPTC tagging wrapper
└── src/
    ├── components/               Header, Bio, Gallery (React), Contact, Footer, SmoothScroll
    ├── layouts/Base.astro
    ├── lib/photos.ts             import.meta.glob + Astro getImage
    ├── pages/index.astro
    ├── photography/              .gitignored — local mirror of R2
    │   ├── wildlife/
    │   └── misc/
    ├── styles/                   global.css (Tailwind v4) + photoswipe.css
    ├── image-data.json           .gitignored — regenerated by the watcher
    └── env.d.ts
```

## Wildlife ethics

GPS coordinates inside JPEGs are stripped at import time by
`import-photos.sh`, and `animal_ids.json` only carries the precision-coarsened
city/region coordinates from `locations.json` (not the camera-recorded GPS).
Don't add precise GPS back: geotags on photos of breeding sites, dens, or
rare species can put animals at risk from disturbance or persecution.
