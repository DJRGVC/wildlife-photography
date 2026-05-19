---
title: "Adding Photos to wildlife-photography"
subtitle: "How to add new photos and push them to the live site"
author: "Daniel Grant"
date: \today
geometry:
  - margin=0.9in
mainfont: "Charter"
sansfont: "Helvetica Neue"
monofont: "Menlo"
fontsize: 11pt
linkcolor: "Sepia"
urlcolor: "Sepia"
header-includes:
  - \usepackage{xcolor}
  - \definecolor{Sepia}{HTML}{3a3329}
  - \definecolor{shadecolor}{HTML}{F4EFE3}
  - \usepackage{fancyhdr}
  - \pagestyle{fancy}
  - \fancyhf{}
  - \rfoot{\thepage}
  - \lfoot{\textit{wildlife-photography}}
  - \renewcommand{\headrulewidth}{0pt}
---

# TL;DR

Two terminals running:

```sh
npm run dev             # terminal 1 — site at localhost:4321
npm run edit-captions   # terminal 2 — editor at localhost:4322
```

In the editor: **drag JPEGs onto the upload card, pick Wildlife or
Misc, Claude vision auto-fills the captions, tweak as needed, save.**

Then ship:

```sh
npm run push-photos       # originals -> Cloudflare R2 (md5-diffed)
git add -A
git commit -m "add new photos"
git push                  # Cloudflare Pages auto-deploys
```

That's the whole workflow. Live site updates within ~5–10 minutes (the
first build per session is the slow one — subsequent rebuilds reuse the
image cache).

\vspace{1em}

\noindent\rule{\textwidth}{0.4pt}

# Why two terminals

`npm run dev` keeps the public-facing site live at `localhost:4321`.
When new files appear in `src/photography/`, the watcher regenerates
`src/image-data.json` and Astro hot-reloads — so anything you add shows
up in the gallery within a second.

`npm run edit-captions` opens a separate companion editor at
`localhost:4322`. It is the easiest way to add new photos and edit
captions: drag-drop ingestion, Claude vision auto-classify, inline edit
of every field. Closing this tab is safe — your edits live in
`data/animal_ids.json` either way.

\vspace{1em}

# What the editor does per upload

\begin{tabular}{ r p{4.2in} }
1. & Saves the JPEG to \texttt{src/photography/<section>/}. \\
2. & Runs \texttt{exiftool -gps:all=} to strip GPS coordinates
     (wildlife-ethics — don't post breeding-site geotags). \\
3. & Reads EXIF for the date, dimensions, camera, lens, exposure. \\
4. & Looks up the date in \texttt{data/locations.json}; if a
     matching location exists, pre-fills it on the photo. \\
5. & If \texttt{ANTHROPIC\_API\_KEY} is set in \texttt{.env},
     downsamples the image to 1568px and sends it to Claude Sonnet 4.6
     with a JSON-schema-constrained prompt. The response — common
     name, scientific name, scene description, confidence, optional
     notes — is written to \texttt{data/animal\_ids.json}. \\
6. & Marks the file as \texttt{"keep"} in
     \texttt{data/decisions\_<section>.json}. \\
7. & Schedules a debounced rebuild of \texttt{src/image-data.json}
     (800\,ms after the last edit). The dev server hot-reloads. \\
\end{tabular}

\vspace{1em}

If Claude's classification is off, just click the field in the editor
and rewrite it. Saves on blur. Each save re-rebuilds.

\vspace{1em}

# Pushing to the live site

The site lives in two places at runtime:

- **Code + metadata** in the GitHub repo (\texttt{DJRGVC/wildlife-photography}).
  This is small — JSON files, scripts, components. Commit + push.
- **Photo originals** in Cloudflare R2 (\texttt{wildlife-photography-originals}).
  R2 holds the only durable copy. Cloudflare Pages downloads them at
  build time, resizes them, and ships WebP variants.

After adding photos locally, both have to be updated:

```sh
npm run push-photos
git add -A
git commit -m "add new photos"
git push
```

`push-photos` md5-diffs against R2, so re-running is cheap and only
uploads what's changed. Skipped files don't cost anything.

`git push` triggers a fresh Cloudflare Pages build that pulls from R2,
processes images via sharp, and deploys the new gallery. Status visible
in the **Workers \& Pages** section of the Cloudflare dashboard.

\vspace{1em}

# When something looks wrong

**Auto-classify failed during upload.**
The upload still saved the file with empty fields. Open the photo card
in the editor and fill the fields manually. Common causes: bad or
missing \texttt{ANTHROPIC\_API\_KEY}, transient API error, image too
large after resize (very rare).

**Pages build failing.**
Open the build log in the dashboard. Look for:

- *Missing R2 env vars.* The build can't fetch originals.
  Re-verify \texttt{R2\_ACCOUNT\_ID}, \texttt{R2\_ACCESS\_KEY\_ID},
  \texttt{R2\_SECRET\_ACCESS\_KEY}, \texttt{R2\_BUCKET},
  \texttt{R2\_PREFIX}, and \texttt{NODE\_VERSION=24} in the Pages
  project settings.
- *Malformed JSON in data/.* Run \texttt{npm run build:photos}
  locally — the same error will surface with a line number.

**Dev server stopped showing new photos.**
Restart \texttt{npm run dev}. Astro's image-handling pipeline
occasionally misses new files when the dev server was launched before
the directory existed.

**Removed a photo, gallery still shows it.**
Delete the file from disk, remove its entry from
\texttt{data/animal\_ids.json}, mark it \texttt{"reject"} in the
relevant \texttt{decisions\_<section>.json}, then
\texttt{npm run build:photos}.

\vspace{1em}

# File layout, briefly

\begin{tabular}{ p{2.4in} p{3.6in} }
\texttt{src/photography/wildlife/} & Wildlife JPEGs, gitignored (R2 is canonical). \\
\texttt{src/photography/misc/} & Other JPEGs, same. \\
\texttt{data/animal\_ids.json} & Per-photo metadata: animal, location, scene, EXIF context. \\
\texttt{data/locations.json} & Date $\to$ location lookup, used to pre-fill new uploads. \\
\texttt{data/decisions\_wildlife.json} & Keep/reject flags for wildlife. \\
\texttt{data/decisions\_misc.json} & Same for misc. \\
\texttt{src/image-data.json} & Generated, gitignored. Don't edit by hand. \\
\texttt{.env} & R2 + Cloudflare + Anthropic credentials. Gitignored. Keep private. \\
\end{tabular}

\vspace{1em}

# Live site

\begin{center}
\Large \texttt{https://danielgrant.photos}
\end{center}
