#!/usr/bin/env tsx
import { watch } from 'chokidar';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PHOTO_DIR = path.join(PROJECT_ROOT, 'src', 'photography');
const BUILD_SCRIPT = path.join(__dirname, 'build-photo-index.ts');

let running = false;
let pending = false;

function rebuild(): void {
  if (running) {
    pending = true;
    return;
  }
  running = true;
  const child = spawn('npx', ['tsx', BUILD_SCRIPT], { stdio: 'inherit', cwd: PROJECT_ROOT });
  child.on('close', (code) => {
    running = false;
    if (code !== 0) console.error(`[watch-photos] rebuild exited with code ${code}`);
    if (pending) {
      pending = false;
      rebuild();
    }
  });
}

console.log(`[watch-photos] watching ${path.relative(PROJECT_ROOT, PHOTO_DIR)}`);

const watcher = watch(PHOTO_DIR, {
  ignoreInitial: false,
  awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 200 },
});

let initialBatchDone = false;
watcher.on('ready', () => {
  initialBatchDone = true;
  rebuild();
});

for (const event of ['add', 'change', 'unlink'] as const) {
  watcher.on(event, (file) => {
    if (!/\.(jpe?g)$/i.test(file)) return;
    if (!initialBatchDone) return;
    console.log(`[watch-photos] ${event}: ${path.basename(file)}`);
    rebuild();
  });
}
