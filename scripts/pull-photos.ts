#!/usr/bin/env tsx
import {
  GetObjectCommand,
  ListObjectsV2Command,
  type _Object,
} from '@aws-sdk/client-s3';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeR2Client } from './r2-client.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const PHOTO_DIR = path.join(PROJECT_ROOT, 'src', 'photography');

async function md5OfFile(file: string): Promise<string> {
  try {
    const hash = createHash('md5');
    for await (const chunk of createReadStream(file)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest('hex');
  } catch {
    return '';
  }
}

async function main(): Promise<void> {
  const r2 = await makeR2Client();
  let downloaded = 0;
  let skipped = 0;
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
      const key = obj.Key;
      if (!key || !/\.(jpe?g)$/i.test(key)) continue;
      const rel = key.slice(r2.prefix.length);
      const local = path.join(PHOTO_DIR, rel);
      const remoteEtag = (obj.ETag ?? '').replace(/"/g, '').toLowerCase();
      const localHash = await md5OfFile(local);
      if (localHash && localHash === remoteEtag) {
        skipped++;
        continue;
      }
      await fs.mkdir(path.dirname(local), { recursive: true });
      const got = await r2.client.send(new GetObjectCommand({ Bucket: r2.bucket, Key: key }));
      const body = got.Body;
      if (!body) {
        console.warn(`[pull-photos] empty body for ${key}`);
        continue;
      }
      const buf = Buffer.from(await body.transformToByteArray());
      await fs.writeFile(local, buf);
      downloaded++;
      console.log(`[pull-photos] pulled ${rel}`);
    }
    cont = res.NextContinuationToken;
  } while (cont);

  console.log(`[pull-photos] done — pulled ${downloaded}, skipped ${skipped} (already current)`);
}

main().catch((err) => {
  console.error('[pull-photos] failed:', err);
  process.exit(1);
});
