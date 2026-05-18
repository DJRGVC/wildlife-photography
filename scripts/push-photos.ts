#!/usr/bin/env tsx
import {
  ListObjectsV2Command,
  PutObjectCommand,
  type _Object,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mime from 'mime-types';
import { makeR2Client } from './r2-client.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PHOTO_DIR = path.join(PROJECT_ROOT, 'src', 'photography');
const SECTIONS = ['wildlife', 'misc'] as const;

async function md5OfFile(file: string): Promise<string> {
  const hash = createHash('md5');
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

async function listRemoteEtags(
  r2: Awaited<ReturnType<typeof makeR2Client>>,
): Promise<Map<string, string>> {
  const remote = new Map<string, string>();
  let cont: string | undefined;
  do {
    const res = await r2.client.send(
      new ListObjectsV2Command({
        Bucket: r2.bucket,
        Prefix: r2.prefix,
        ContinuationToken: cont,
      }),
    );
    for (const obj of (res.Contents ?? []) as _Object[]) {
      if (!obj.Key) continue;
      remote.set(obj.Key, (obj.ETag ?? '').replace(/"/g, '').toLowerCase());
    }
    cont = res.NextContinuationToken;
  } while (cont);
  return remote;
}

async function main(): Promise<void> {
  const r2 = await makeR2Client();
  const remote = await listRemoteEtags(r2);
  console.log(`[push-photos] ${remote.size} object(s) already in r2://${r2.bucket}/${r2.prefix}`);

  let uploaded = 0;
  let skipped = 0;
  let missing = 0;

  for (const section of SECTIONS) {
    const dir = path.join(PHOTO_DIR, section);
    await fs.mkdir(dir, { recursive: true });
    const files = (await fs.readdir(dir)).filter((f) => /\.(jpe?g)$/i.test(f)).sort();
    if (files.length === 0) {
      console.log(`[push-photos] ${section}/: no photos`);
      missing++;
      continue;
    }
    for (const file of files) {
      const local = path.join(dir, file);
      const key = `${r2.prefix}${section}/${file}`;
      const localHash = await md5OfFile(local);
      const remoteHash = remote.get(key);
      if (remoteHash === localHash) {
        skipped++;
        continue;
      }
      const body = await fs.readFile(local);
      await r2.client.send(
        new PutObjectCommand({
          Bucket: r2.bucket,
          Key: key,
          Body: body,
          ContentType: mime.lookup(file) || 'image/jpeg',
        }),
      );
      uploaded++;
      console.log(`[push-photos] uploaded ${section}/${file}`);
    }
  }

  console.log(
    `[push-photos] done — uploaded ${uploaded}, skipped ${skipped} (already current), ${missing} empty section(s)`,
  );
}

main().catch((err) => {
  console.error('[push-photos] failed:', err);
  process.exit(1);
});
