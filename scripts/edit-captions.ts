#!/usr/bin/env tsx
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const PHOTO_DIR = path.join(ROOT, 'src', 'photography');
const ANIMAL_IDS = path.join(DATA_DIR, 'animal_ids.json');
const PORT = Number(process.env.EDITOR_PORT) || 4322;

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

const thumbCache = new Map<string, Buffer>();
let rebuildTimer: NodeJS.Timeout | null = null;

async function loadData(): Promise<Record<string, PhotoEntry>> {
  const text = await fs.readFile(ANIMAL_IDS, 'utf8');
  return JSON.parse(text);
}

async function saveData(data: Record<string, PhotoEntry>): Promise<void> {
  await fs.writeFile(ANIMAL_IDS, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

function scheduleRebuild(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    console.log('[edit-captions] rebuilding image-data.json …');
    exec(
      `npx tsx ${path.join(__dirname, 'build-photo-index.ts')}`,
      { cwd: ROOT },
      (err, stdout) => {
        if (err) console.error('[edit-captions] rebuild failed:', err.message);
        else console.log(stdout.trim() || '[edit-captions] rebuild done');
      },
    );
  }, 800);
}

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Caption editor — wildlife-photography</title>
  <style>
    :root {
      --ink: #1a1a1a;
      --ink-soft: #5a5a5a;
      --ink-faint: #999;
      --cream: #fafaf7;
      --line: #e3ddcd;
      --accent: #4f6f4f;
      --danger: #b34a3a;
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
    .subhead {
      color: var(--ink-soft);
      font-size: 14px;
      margin-bottom: 24px;
      max-width: 640px;
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
  <h1>Caption editor</h1>
  <p class="subhead">
    Edits save automatically when you click out of a field. Each save triggers
    a rebuild of <code>src/image-data.json</code>, so if the Astro dev server is
    running on <code>localhost:4321</code> the gallery hot-reloads with your
    new copy.
  </p>

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

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HTML);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/photos') {
      const data = await loadData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
      return;
    }

    if (req.method === 'PATCH' && url.pathname.startsWith('/api/photos/')) {
      const filename = decodeURIComponent(url.pathname.slice('/api/photos/'.length));
      const body = JSON.parse(await readBody(req));
      const data = await loadData();
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
      await saveData(data);
      scheduleRebuild();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entry }));
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
  console.log('     Edits autosave; image-data.json rebuilds 800ms after the');
  console.log('     last edit, so the dev server (4321) refreshes the gallery.');
  console.log('     Ctrl+C to stop.');
  console.log('');
  exec(`open "${url}"`);
});
