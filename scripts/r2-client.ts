import { S3Client } from '@aws-sdk/client-s3';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

async function loadDotEnv(): Promise<void> {
  if (process.env.R2_ACCOUNT_ID) return;
  const envFile = path.join(PROJECT_ROOT, '.env');
  try {
    const text = await fs.readFile(envFile, 'utf8');
    for (const line of text.split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!m) continue;
      const [, key, raw] = m;
      const val = raw.replace(/^['"]|['"]$/g, '');
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* no .env file — assume env vars are set externally (CF Pages build) */
  }
}

export type R2 = {
  client: S3Client;
  bucket: string;
  prefix: string;
};

const REQUIRED = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'] as const;

export async function makeR2Client(): Promise<R2> {
  await loadDotEnv();
  for (const k of REQUIRED) {
    if (!process.env[k]) {
      throw new Error(`Missing env var ${k}. Copy .env.example → .env and fill in (or set in CF Pages env).`);
    }
  }
  const accountId = process.env.R2_ACCOUNT_ID!;
  return {
    client: new S3Client({
      region: 'auto',
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID!,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
      },
    }),
    bucket: process.env.R2_BUCKET!,
    prefix: process.env.R2_PREFIX ?? 'photos/',
  };
}
