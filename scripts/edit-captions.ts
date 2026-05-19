#!/usr/bin/env tsx
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import busboy from 'busboy';
import sharp from 'sharp';
import ExifReader from 'exifreader';
import Anthropic from '@anthropic-ai/sdk';

const exec = promisify(execCb);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PHOTO_DIR = path.join(ROOT, 'src', 'photography');
const ANIMAL_IDS = path.join(DATA_DIR, 'animal_ids.json');
const LOCATIONS_PATH = path.join(DATA_DIR, 'locations.json');
const DECISIONS_PATH = {
  wildlife: path.join(DATA_DIR, 'decisions_wildlife.json'),
  misc: path.join(DATA_DIR, 'decisions_misc.json'),
} as const;
const PORT = Number(process.env.EDITOR_PORT) || 4322;

type Section = 'wildlife' | 'misc';
const SECTIONS: readonly Section[] = ['wildlife', 'misc'];

type AnimalEntry = {
  common_name?: string;
  scientific_name?: string;
  subject?: string;
  notes?: string | null;
};

type PhotoEntry = {
  filename?: string;
  categories?: string[];
  date?: string;
  datetime?: string;
  width?: number;
  height?: number;
  location?: { name?: string; lat?: number; lng?: number };
  scene?: string;
  animals?: AnimalEntry[];
  confidence?: string;
  notes?: string | null;
};

type LocationEntry = { location?: string; lat?: number; lng?: number };
type Decisions = Record<string, 'keep' | 'reject'>;

const thumbCache = new Map<string, Buffer>();
let rebuildTimer: NodeJS.Timeout | null = null;
let uploadLock: Promise<unknown> = Promise.resolve();

async function loadDotEnv(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) return;
  try {
    const text = await fs.readFile(path.join(ROOT, '.env'), 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, key, raw] = m;
      const val = raw.replace(/^['"]|['"]$/g, '').trim();
      if (val && !process.env[key]) process.env[key] = val;
    }
  } catch {
    /* no .env file */
  }
}

await loadDotEnv();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY?.trim() || '';
const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

const WILDLIFE_SYSTEM = `You identify wildlife in photographs for a personal photography portfolio site.

For each image, respond with JSON in this exact shape:

{
  "common_name": "Great Blue Heron",
  "scientific_name": "Ardea herodias",
  "scene": "One brief observational sentence (under 100 chars).",
  "confidence": "high|medium|low",
  "notes": "Optional brief detail (subspecies, age class, sex, distinguishing markings). Empty string if nothing notable."
}

Guidelines:
- Identify the PRIMARY animal subject. If multiple species are visible, pick the central or focal one.
- Use widely accepted common names (e.g. "Brown Bear" not "Grizzly"; "American Alligator" not just "Alligator").
- Scientific name should be the binomial (e.g. "Ursus arctos"). If you can name the subspecies, do (e.g. "Cervus canadensis nannodes").
- Scene should be CONCISE and OBSERVATIONAL — describe pose, environment, or behavior. Avoid lighting/mood adjectives ("soft golden light", "ethereal", "majestic").
- Confidence: "high" if you're certain of the species; "medium" if you're confident on the genus but the species is plausible; "low" if you're guessing.
- Notes: brief field-guide-style detail (subspecies geography, breeding plumage, juvenile vs adult, distinguishing features). Empty string if nothing useful to add.`;

const MISC_SYSTEM = `You write brief scene descriptions for non-wildlife photographs in a personal photography portfolio.

For each image, respond with JSON in this exact shape:

{
  "scene": "One brief observational sentence (under 90 chars).",
  "confidence": "high|medium|low",
  "notes": "Optional brief context. Empty string if nothing useful to add."
}

Guidelines:
- Focus on the subject, setting, and any specific context.
- Be observational and specific, not poetic. Avoid lighting/mood adjectives ("golden hour", "ethereal", "majestic").
- Examples of the desired style:
  * "Pont Alexandre III dressed for the Paris 2024 Olympics — banner and ring of national flags spanning the bridge."
  * "Triple jumper extending over the pit at the Stade de France."
  * "Stars-and-stripes pond yacht heeling across the Luxembourg basin."
- Confidence: "high" for clearly identifiable scenes; "medium" if the context is reasonably implied; "low" if you're guessing what's depicted.
- Notes: brief context like venue, event, or season. Empty string if nothing useful.`;

const WILDLIFE_SCHEMA = {
  type: 'object',
  properties: {
    common_name: { type: 'string' },
    scientific_name: { type: 'string' },
    scene: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
  },
  required: ['common_name', 'scientific_name', 'scene', 'confidence', 'notes'],
  additionalProperties: false,
};

const MISC_SCHEMA = {
  type: 'object',
  properties: {
    scene: { type: 'string' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    notes: { type: 'string' },
  },
  required: ['scene', 'confidence', 'notes'],
  additionalProperties: false,
};

async function loadJsonOrEmpty<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

async function loadAnimalIds(): Promise<Record<string, PhotoEntry>> {
  return loadJsonOrEmpty(ANIMAL_IDS, {});
}

async function saveAnimalIds(data: Record<string, PhotoEntry>): Promise<void> {
  await fs.writeFile(ANIMAL_IDS, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function loadDecisions(section: Section): Promise<Decisions> {
  return loadJsonOrEmpty(DECISIONS_PATH[section], {} as Decisions);
}

async function saveDecisions(section: Section, data: Decisions): Promise<void> {
  await fs.writeFile(DECISIONS_PATH[section], `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

async function loadLocations(): Promise<Record<string, LocationEntry>> {
  return loadJsonOrEmpty(LOCATIONS_PATH, {});
}

function scheduleRebuild(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    console.log('[edit-captions] rebuilding image-data.json …');
    exec(`npx tsx ${path.join(__dirname, 'build-photo-index.ts')}`, { cwd: ROOT })
      .then(({ stdout }) => console.log(stdout.trim() || '[edit-captions] rebuild done'))
      .catch((err) => console.error('[edit-captions] rebuild failed:', err.message));
  }, 800);
}

function pickString(tag: { description?: unknown; value?: unknown } | undefined): string {
  if (!tag) return '';
  if (typeof tag.description === 'string' && tag.description) return tag.description;
  if (Array.isArray(tag.value)) {
    const first = tag.value[0];
    if (typeof first === 'string' || typeof first === 'number') return String(first);
  }
  if (typeof tag.value === 'string' || typeof tag.value === 'number') return String(tag.value);
  return '';
}

function parseExifDate(raw: string): { iso: string; datetime: string } {
  if (!raw) return { iso: '', datetime: '' };
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return { iso: '', datetime: raw };
  const [, y, mo, d, h, mi, s] = m;
  const iso = new Date(
    Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s),
  ).toISOString();
  return { iso, datetime: `${y}:${mo}:${d} ${h}:${mi}:${s}` };
}

async function extractExif(buffer: Buffer): Promise<{
  date: string;
  datetime: string;
  width: number;
  height: number;
}> {
  let tags: ExifReader.ExpandedTags | null = null;
  try {
    tags = ExifReader.load(buffer, { expanded: true });
  } catch {
    /* file has no readable EXIF */
  }
  const exif = (tags?.exif ?? {}) as Record<string, { description?: unknown; value?: unknown }>;
  const dim = await sharp(buffer).metadata();
  const { iso, datetime } = parseExifDate(pickString(exif.DateTimeOriginal));
  return {
    date: iso ? iso.slice(0, 10) : '',
    datetime,
    width: dim.width ?? 0,
    height: dim.height ?? 0,
  };
}

async function stripGps(filePath: string): Promise<void> {
  try {
    await exec(`exiftool -overwrite_original -gps:all= -location:all= ${JSON.stringify(filePath)}`);
  } catch (err) {
    console.warn('[upload] GPS strip skipped (is exiftool installed?):', (err as Error).message);
  }
}

async function classifyImage(buffer: Buffer, section: Section): Promise<{
  common_name?: string;
  scientific_name?: string;
  scene: string;
  confidence: string;
  notes: string;
}> {
  if (!anthropic) {
    throw new Error('ANTHROPIC_API_KEY not set in .env');
  }
  const resized = await sharp(buffer)
    .resize(1568, 1568, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  const base64 = resized.toString('base64');

  const system = section === 'wildlife' ? WILDLIFE_SYSTEM : MISC_SYSTEM;
  const schema = section === 'wildlife' ? WILDLIFE_SCHEMA : MISC_SCHEMA;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    thinking: { type: 'disabled' },
    output_config: {
      effort: 'low',
      format: { type: 'json_schema', schema },
    },
    system: [
      { type: 'text', text: system, cache_control: { type: 'ephemeral' } },
    ],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
          },
          { type: 'text', text: 'Classify this photograph.' },
        ],
      },
    ],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any) as Anthropic.Messages.Message;

  const textBlock = message.content.find(
    (b: Anthropic.Messages.ContentBlock) => b.type === 'text',
  );
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text block');
  }
  return JSON.parse(textBlock.text);
}

function safeFilename(raw: string): string {
  const base = path.basename(raw);
  return base.replace(/[^\w.\-+() ]/g, '_');
}

async function nextAvailableFilename(destDir: string, requested: string): Promise<string> {
  const ext = path.extname(requested);
  const stem = requested.slice(0, -ext.length || requested.length);
  let candidate = requested;
  let n = 1;
  while (true) {
    try {
      await fs.access(path.join(destDir, candidate));
      candidate = `${stem}-${n}${ext}`;
      n++;
    } catch {
      return candidate;
    }
  }
}

type UploadedFile = { fieldname: string; filename: string; buffer: Buffer; mimeType: string };

function parseMultipart(req: http.IncomingMessage): Promise<{
  files: UploadedFile[];
  fields: Record<string, string>;
}> {
  return new Promise((resolve, reject) => {
    const bb = busboy({
      headers: req.headers,
      limits: { fileSize: 60 * 1024 * 1024 },
    });
    const files: UploadedFile[] = [];
    const fields: Record<string, string> = {};
    bb.on('file', (fieldname, file, info) => {
      const chunks: Buffer[] = [];
      file.on('data', (chunk: Buffer) => chunks.push(chunk));
      file.on('end', () => {
        files.push({
          fieldname,
          filename: info.filename || 'upload.jpg',
          mimeType: info.mimeType || 'image/jpeg',
          buffer: Buffer.concat(chunks),
        });
      });
      file.on('limit', () => reject(new Error('file too large (60MB max)')));
    });
    bb.on('field', (name, value) => {
      fields[name] = value;
    });
    bb.on('error', reject);
    bb.on('finish', () => resolve({ files, fields }));
    req.pipe(bb);
  });
}

async function withUploadLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = uploadLock.then(fn, fn);
  uploadLock = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Photo editor — wildlife-photography</title>
  <style>
    :root {
      --ink: #1a1a1a;
      --ink-soft: #5a5a5a;
      --ink-faint: #999;
      --cream: #fafaf7;
      --line: #e3ddcd;
      --accent: #4f6f4f;
      --danger: #b34a3a;
      --warn: #c08a3a;
    }
    * { box-sizing: border-box; }
    body {
      font-family: Newsreader, Georgia, "Hoefler Text", serif;
      max-width: 1080px;
      margin: 0 auto;
      padding: 32px 24px 96px;
      background: var(--cream);
      color: var(--ink);
      line-height: 1.5;
    }
    h1 { font-weight: 400; font-size: 28px; margin: 0 0 4px; letter-spacing: -0.01em; }
    h2 { font-weight: 400; font-size: 18px; margin: 0 0 12px; letter-spacing: -0.005em; }
    .subhead { color: var(--ink-soft); font-size: 14px; margin-bottom: 24px; max-width: 640px; }

    .upload {
      background: white;
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 20px;
      margin-bottom: 28px;
    }
    .upload__head {
      display: flex;
      align-items: baseline;
      gap: 14px;
      flex-wrap: wrap;
      margin-bottom: 14px;
    }
    .upload__section-toggle {
      display: flex;
      gap: 14px;
      font-size: 14px;
      color: var(--ink-soft);
    }
    .upload__section-toggle label {
      display: flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }
    .upload__drop {
      border: 2px dashed var(--line);
      border-radius: 8px;
      padding: 28px 16px;
      text-align: center;
      cursor: pointer;
      color: var(--ink-soft);
      font-size: 14px;
      transition: border-color 180ms, background 180ms, color 180ms;
      user-select: none;
    }
    .upload__drop:hover { border-color: color-mix(in srgb, var(--ink) 30%, transparent); }
    .upload__drop.is-drag {
      border-color: var(--ink);
      background: color-mix(in srgb, var(--ink) 4%, transparent);
      color: var(--ink);
    }
    .upload__browse { text-decoration: underline; }
    .upload__queue {
      list-style: none;
      padding: 0;
      margin: 14px 0 0;
      font-family: ui-sans-serif, system-ui, sans-serif;
      font-size: 12.5px;
    }
    .upload__queue li {
      padding: 6px 0;
      border-top: 1px solid var(--line);
      color: var(--ink-soft);
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .upload__queue li:first-child { border-top: 0; }
    .upload__queue li.queue--uploading { color: var(--ink-soft); }
    .upload__queue li.queue--classifying { color: var(--warn); }
    .upload__queue li.queue--done { color: var(--accent); }
    .upload__queue li.queue--error { color: var(--danger); }
    .upload__queue .queue-name { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
    .upload__queue .queue-msg { flex: 1; }

    .upload__no-key {
      margin-top: 10px;
      padding: 8px 12px;
      background: color-mix(in srgb, var(--warn) 12%, transparent);
      border-radius: 6px;
      font-size: 12px;
      color: var(--ink-soft);
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    .upload__no-key code {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      background: rgba(0,0,0,0.06);
      padding: 1px 5px;
      border-radius: 3px;
    }

    .filter-bar {
      position: sticky;
      top: 0;
      background: color-mix(in srgb, var(--cream) 92%, transparent);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      padding: 12px 0 14px;
      margin-bottom: 20px;
      z-index: 10;
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      align-items: center;
      border-bottom: 1px solid var(--line);
    }
    .filter-bar button {
      padding: 5px 12px;
      border: 1px solid var(--line);
      background: white;
      border-radius: 999px;
      cursor: pointer;
      font-family: inherit;
      font-size: 13px;
      color: var(--ink);
    }
    .filter-bar button.active {
      background: var(--ink);
      color: var(--cream);
      border-color: var(--ink);
    }
    .filter-bar input[type="search"] {
      flex: 1 1 200px;
      padding: 6px 12px;
      border: 1px solid var(--line);
      border-radius: 999px;
      font-family: inherit;
      font-size: 13px;
      background: white;
    }
    .filter-bar input[type="search"]:focus { outline: 0; border-color: var(--ink-soft); }
    .meta-counts {
      font-size: 12px;
      color: var(--ink-faint);
      margin-left: auto;
    }

    .photo {
      display: grid;
      grid-template-columns: 240px 1fr;
      gap: 24px;
      margin: 0 0 20px;
      padding: 18px;
      background: white;
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    .photo__thumb {
      width: 100%;
      aspect-ratio: 3 / 2;
      object-fit: cover;
      border-radius: 4px;
      background: #eee;
      display: block;
    }
    .photo__fields { font-size: 14px; }
    .photo__head {
      display: flex;
      align-items: baseline;
      gap: 8px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .photo__filename {
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 11.5px;
      color: var(--ink-faint);
    }
    .section-tag {
      padding: 1px 8px;
      background: #f4f1ea;
      border: 1px solid var(--line);
      border-radius: 999px;
      font-size: 10.5px;
      color: var(--ink-soft);
      font-family: ui-sans-serif, system-ui, sans-serif;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .field { margin-bottom: 10px; }
    .field-label {
      display: block;
      font-size: 11px;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--ink-soft);
      margin-bottom: 3px;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    .field input[type="text"],
    .field textarea {
      width: 100%;
      font-family: inherit;
      font-size: 14px;
      padding: 7px 10px;
      border: 1px solid var(--line);
      border-radius: 4px;
      background: #fdfdfa;
      color: var(--ink);
      resize: vertical;
    }
    .field input[type="text"]:focus,
    .field textarea:focus {
      outline: 0;
      border-color: var(--ink-soft);
      background: white;
    }
    .field textarea { min-height: 56px; }
    .field--inline { display: flex; gap: 10px; }
    .field--inline > div { flex: 1; }
    .field--readonly {
      font-size: 12.5px;
      color: var(--ink-soft);
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin: -4px 0 12px;
    }
    .save-status {
      font-size: 11.5px;
      color: var(--ink-faint);
      margin-top: 6px;
      min-height: 14px;
      font-family: ui-sans-serif, system-ui, sans-serif;
    }
    .save-status.saving { color: var(--ink-soft); }
    .save-status.saved { color: var(--accent); }
    .save-status.error { color: var(--danger); }
    .empty {
      text-align: center;
      color: var(--ink-faint);
      padding: 64px 0;
      font-style: italic;
    }
  </style>
</head>
<body>
  <h1>Photo editor</h1>
  <p class="subhead">
    Drag JPEGs to add new photos (auto-classified via Claude vision); edit any
    photo's fields below. Saves trigger a rebuild of <code>src/image-data.json</code>,
    so the Astro dev server (<code>:4321</code>) hot-reloads the gallery with your
    changes.
  </p>

  <section class="upload">
    <div class="upload__head">
      <h2>Add photos</h2>
      <div class="upload__section-toggle">
        <label><input type="radio" name="section" value="wildlife" checked /> Wildlife</label>
        <label><input type="radio" name="section" value="misc" /> Misc</label>
      </div>
    </div>
    <div id="drop-zone" class="upload__drop" role="button" tabindex="0">
      Drag JPEGs here, or <span class="upload__browse">click to browse</span>
      <input type="file" id="file-input" multiple accept="image/jpeg,image/jpg" hidden />
    </div>
    <ul id="upload-queue" class="upload__queue"></ul>
    __NO_KEY_BANNER__
  </section>

  <div class="filter-bar">
    <button class="active" data-filter="all">All (<span id="count-all">0</span>)</button>
    <button data-filter="wildlife">Wildlife (<span id="count-wildlife">0</span>)</button>
    <button data-filter="misc">Misc (<span id="count-misc">0</span>)</button>
    <input type="search" id="search" placeholder="Search filename, animal, location, scene…" />
    <span class="meta-counts" id="meta-counts"></span>
  </div>

  <div id="photos"><div class="empty">Loading…</div></div>

  <script>
    let data = null;
    let currentFilter = 'all';

    function escapeHtml(s) {
      return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }
    function primaryAnimal(entry) {
      const animals = entry.animals || [];
      return animals.find(a => a.subject === 'primary') || animals[0] || null;
    }
    function matches(entry, filename, q) {
      if (!q) return true;
      q = q.toLowerCase();
      if (filename.toLowerCase().includes(q)) return true;
      if ((entry.scene || '').toLowerCase().includes(q)) return true;
      if (((entry.location || {}).name || '').toLowerCase().includes(q)) return true;
      const a = primaryAnimal(entry);
      if (a && (a.common_name || '').toLowerCase().includes(q)) return true;
      if (a && (a.scientific_name || '').toLowerCase().includes(q)) return true;
      return false;
    }
    function entriesFor(filter, query) {
      return Object.entries(data)
        .filter(([fn, v]) => {
          if (filter !== 'all' && !(v.categories || []).includes(filter)) return false;
          return matches(v, fn, query);
        })
        .sort(([a], [b]) => a.localeCompare(b));
    }
    function render() {
      const filter = currentFilter;
      const query = document.getElementById('search').value.trim();
      const container = document.getElementById('photos');
      const entries = entriesFor(filter, query);

      const all = Object.values(data);
      document.getElementById('count-all').textContent = all.length;
      document.getElementById('count-wildlife').textContent = all.filter(v => (v.categories || []).includes('wildlife')).length;
      document.getElementById('count-misc').textContent = all.filter(v => (v.categories || []).includes('misc')).length;
      document.getElementById('meta-counts').textContent =
        entries.length === all.length ? '' : entries.length + ' shown';

      if (entries.length === 0) {
        container.innerHTML = '<div class="empty">No photos match.</div>';
        return;
      }

      container.innerHTML = entries.map(([filename, entry]) => {
        const section = (entry.categories || ['misc'])[0];
        const primary = primaryAnimal(entry) || {};
        const isWildlife = section === 'wildlife';
        return \`
          <div class="photo" data-filename="\${escapeHtml(filename)}">
            <img class="photo__thumb" src="/photo/\${section}/\${encodeURIComponent(filename)}" alt="" loading="lazy" />
            <div class="photo__fields">
              <div class="photo__head">
                <span class="photo__filename">\${escapeHtml(filename)}</span>
                <span class="section-tag">\${section}</span>
              </div>
              <div class="field--readonly">
                <span>📅 \${escapeHtml(entry.date || '—')}</span>
                <span>📍 \${escapeHtml((entry.location || {}).name || '—')}</span>
              </div>
              \${isWildlife ? \`
                <div class="field--inline">
                  <div class="field">
                    <label class="field-label">Common name</label>
                    <input type="text" data-field="common_name" value="\${escapeHtml(primary.common_name || '')}" />
                  </div>
                  <div class="field">
                    <label class="field-label">Scientific name</label>
                    <input type="text" data-field="scientific_name" value="\${escapeHtml(primary.scientific_name || '')}" />
                  </div>
                </div>
              \` : ''}
              <div class="field">
                <label class="field-label">Scene / caption</label>
                <textarea data-field="scene">\${escapeHtml(entry.scene || '')}</textarea>
              </div>
              <div class="field">
                <label class="field-label">Notes (not shown on site)</label>
                <textarea data-field="notes">\${escapeHtml(entry.notes || '')}</textarea>
              </div>
              <div class="save-status"></div>
            </div>
          </div>
        \`;
      }).join('');

      container.querySelectorAll('.photo').forEach(card => {
        const filename = card.dataset.filename;
        card.querySelectorAll('[data-field]').forEach(field => {
          field.addEventListener('blur', () => save(card, filename, field));
        });
      });
    }
    function readCurrent(filename) {
      const entry = data[filename] || {};
      const primary = primaryAnimal(entry) || {};
      return {
        scene: entry.scene || '',
        notes: entry.notes || '',
        common_name: primary.common_name || '',
        scientific_name: primary.scientific_name || '',
      };
    }
    async function save(card, filename, field) {
      const status = card.querySelector('.save-status');
      const fieldName = field.dataset.field;
      const newValue = field.value;
      const current = readCurrent(filename);
      if (current[fieldName] === newValue) return;
      status.textContent = 'Saving…';
      status.className = 'save-status saving';
      try {
        const res = await fetch('/api/photos/' + encodeURIComponent(filename), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ [fieldName]: newValue }),
        });
        if (!res.ok) throw new Error('save failed (' + res.status + ')');
        const json = await res.json();
        data[filename] = json.entry;
        status.textContent = '✓ Saved';
        status.className = 'save-status saved';
        setTimeout(() => { status.textContent = ''; status.className = 'save-status'; }, 1800);
      } catch (err) {
        status.textContent = 'Save failed: ' + err.message;
        status.className = 'save-status error';
      }
    }

    // ---------- Upload ----------
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const uploadQueue = document.getElementById('upload-queue');

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
    });
    fileInput.addEventListener('change', (e) => {
      handleFiles(e.target.files);
      e.target.value = '';
    });
    ['dragover', 'dragenter'].forEach(ev => {
      dropZone.addEventListener(ev, (e) => {
        e.preventDefault();
        dropZone.classList.add('is-drag');
      });
    });
    ['dragleave', 'dragend'].forEach(ev => {
      dropZone.addEventListener(ev, () => dropZone.classList.remove('is-drag'));
    });
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('is-drag');
      handleFiles(e.dataTransfer.files);
    });

    async function handleFiles(fileList) {
      const section = document.querySelector('input[name="section"]:checked').value;
      const files = Array.from(fileList).filter(f => /image\\/jpe?g/i.test(f.type) || /\\.jpe?g$/i.test(f.name));
      if (files.length === 0) return;
      for (const file of files) {
        const li = document.createElement('li');
        li.className = 'queue--uploading';
        li.innerHTML = \`<span class="queue-name">\${escapeHtml(file.name)}</span><span class="queue-msg">Uploading…</span>\`;
        uploadQueue.prepend(li);
        const msg = li.querySelector('.queue-msg');
        try {
          const fd = new FormData();
          fd.append('section', section);
          fd.append('file', file);
          msg.textContent = 'Uploading + classifying via Claude…';
          li.className = 'queue--classifying';
          const res = await fetch('/api/upload', { method: 'POST', body: fd });
          if (!res.ok) {
            const errText = await res.text();
            throw new Error(errText || 'upload failed (' + res.status + ')');
          }
          const result = await res.json();
          data[result.filename] = result.entry;
          const primary = primaryAnimal(result.entry) || {};
          const title = primary.common_name || result.entry.scene || '(no caption yet)';
          msg.textContent = '✓ ' + title;
          li.className = 'queue--done';
          render();
        } catch (err) {
          msg.textContent = '✗ ' + err.message;
          li.className = 'queue--error';
        }
      }
    }

    // ---------- Boot ----------
    document.querySelectorAll('.filter-bar button').forEach(b => {
      b.addEventListener('click', () => {
        document.querySelectorAll('.filter-bar button').forEach(x => x.classList.remove('active'));
        b.classList.add('active');
        currentFilter = b.dataset.filter;
        render();
      });
    });
    document.getElementById('search').addEventListener('input', () => render());

    fetch('/api/photos').then(r => r.json()).then(d => {
      data = d;
      render();
    });
  </script>
</body>
</html>`;

const NO_KEY_BANNER = `<div class="upload__no-key">
  ⚠️ <strong>ANTHROPIC_API_KEY not set</strong> in <code>.env</code>. Uploads will save photos but skip auto-classification —
  you'll need to fill scene / animal fields by hand. Get a key at
  <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noreferrer">console.anthropic.com/settings/keys</a>,
  then add it to <code>.env</code> and restart this editor.
</div>`;

function renderHtml(): string {
  return HTML.replace('__NO_KEY_BANNER__', anthropic ? '' : NO_KEY_BANNER);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderHtml());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/photos') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(await loadAnimalIds()));
      return;
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/photos/')) {
      const filename = decodeURIComponent(url.pathname.slice('/api/photos/'.length));
      const body = JSON.parse(await readBody(req));
      const data = await loadAnimalIds();
      const entry = data[filename];
      if (!entry) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      if (typeof body.scene === 'string') entry.scene = body.scene;
      if (typeof body.notes === 'string') entry.notes = body.notes || null;
      if (typeof body.common_name === 'string' || typeof body.scientific_name === 'string') {
        const animals = entry.animals || [];
        let primary = animals.find((a) => a.subject === 'primary') || animals[0];
        if (!primary) {
          primary = { subject: 'primary' };
          entry.animals = [primary];
        }
        if (typeof body.common_name === 'string') primary.common_name = body.common_name;
        if (typeof body.scientific_name === 'string') primary.scientific_name = body.scientific_name;
      }
      if (typeof body.location === 'string') {
        if (!entry.location) entry.location = {};
        entry.location.name = body.location;
      }
      await saveAnimalIds(data);
      scheduleRebuild();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entry }));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/upload') {
      await withUploadLock(async () => {
        const { files, fields } = await parseMultipart(req);
        if (files.length === 0) throw new Error('no file in form');
        const section = fields.section as Section;
        if (!SECTIONS.includes(section)) {
          throw new Error(`invalid section: ${fields.section}`);
        }
        const file = files[0];
        if (!/jpe?g$/i.test(file.filename) && !/image\/jpe?g/i.test(file.mimeType)) {
          throw new Error('only JPEG files are supported');
        }

        const destDir = path.join(PHOTO_DIR, section);
        await fs.mkdir(destDir, { recursive: true });
        const cleanName = safeFilename(file.filename);
        const finalName = await nextAvailableFilename(destDir, cleanName);
        const destPath = path.join(destDir, finalName);

        await fs.writeFile(destPath, file.buffer);
        await stripGps(destPath);

        const buffer = await fs.readFile(destPath);
        const exif = await extractExif(buffer);

        const locations = await loadLocations();
        const dateKey = exif.date;
        const locEntry: LocationEntry | undefined = dateKey ? locations[dateKey] : undefined;

        const entry: PhotoEntry = {
          categories: [section],
          filename: finalName,
          date: dateKey,
          datetime: exif.datetime,
          width: exif.width,
          height: exif.height,
          location: locEntry
            ? { name: locEntry.location ?? '', lat: locEntry.lat, lng: locEntry.lng }
            : { name: '' },
          scene: '',
          animals: [],
          confidence: '',
          notes: null,
        };

        if (anthropic) {
          try {
            const ai = await classifyImage(buffer, section);
            entry.scene = ai.scene;
            entry.confidence = ai.confidence;
            entry.notes = ai.notes || null;
            if (section === 'wildlife' && ai.common_name) {
              entry.animals = [
                {
                  common_name: ai.common_name,
                  scientific_name: ai.scientific_name ?? '',
                  subject: 'primary',
                  notes: '',
                },
              ];
            }
          } catch (err) {
            console.warn(`[upload] classify failed for ${finalName}:`, (err as Error).message);
          }
        }

        const animalIds = await loadAnimalIds();
        animalIds[finalName] = entry;
        await saveAnimalIds(animalIds);

        const decisions = await loadDecisions(section);
        decisions[finalName] = 'keep';
        await saveDecisions(section, decisions);

        scheduleRebuild();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, filename: finalName, entry }));
      });
      return;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/photo/')) {
      const parts = url.pathname.slice('/photo/'.length).split('/');
      if (parts.length !== 2) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const [section, encName] = parts;
      const filename = decodeURIComponent(encName);
      const filePath = path.join(PHOTO_DIR, section, filename);
      try {
        await fs.access(filePath);
      } catch {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const cacheKey = `${section}/${filename}`;
      let buf = thumbCache.get(cacheKey);
      if (!buf) {
        const orig = await fs.readFile(filePath);
        buf = await sharp(orig).resize(560, null, { fit: 'inside' }).webp({ quality: 70 }).toBuffer();
        thumbCache.set(cacheKey, buf);
      }
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(buf);
      return;
    }

    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    console.error('[edit-captions] error:', err);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
});

server.listen(PORT, () => {
  const url = `http://localhost:${PORT}/`;
  console.log('');
  console.log(`  📝 Caption editor at ${url}`);
  if (anthropic) {
    console.log('     Auto-classify via Claude Sonnet 4.6 enabled (ANTHROPIC_API_KEY found).');
  } else {
    console.log('     ⚠️  ANTHROPIC_API_KEY not set — uploads will save but skip auto-classify.');
  }
  console.log('     Edits autosave; image-data.json rebuilds 800ms after the last');
  console.log('     change, so the dev server (4321) refreshes the gallery.');
  console.log('     Ctrl+C to stop.');
  console.log('');
  exec(`open "${url}"`).catch(() => undefined);
});
