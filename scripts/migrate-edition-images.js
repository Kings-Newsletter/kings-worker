import { createHash } from 'node:crypto';
import { MongoClient } from 'mongodb';
import 'dotenv/config';

const MAX_ATTEMPTS = 5;
const RETRY_DELAY_MS = 10_000;
const DEFAULT_PUBLIC_BASE = 'https://pub-fcf4bc76fe3b4643b8c8b2c76bc61ad1.r2.dev';
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const required = ['MONGODB_URI', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'R2_BUCKET_NAME'];
const missing = required.filter((key) => !process.env[key]);

if (missing.length) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const config = {
  mongoUri: process.env.MONGODB_URI,
  database: process.env.MONGODB_DATABASE || 'kings_newsletter',
  editionsCollection: process.env.MONGODB_EDITIONS_COLLECTION || 'editions',
  newsCollection: process.env.MONGODB_NEWS_COLLECTION || 'news',
  editionDateField: process.env.NEWS_EDITION_DATE_FIELD || 'editionDate',
  imageUrlField: process.env.NEWS_IMAGE_URL_FIELD || 'image.url',
  accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  bucket: process.env.R2_BUCKET_NAME,
  publicBase: (process.env.R2_PUBLIC_BASE_URL || DEFAULT_PUBLIC_BASE).replace(/\/$/, ''),
  dryRun: process.argv.includes('--dry-run')
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function retryable(error) {
  if (error?.permanent) return false;
  const status = Number(error?.status || 0);
  return !status || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function retry(label, operation) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      console.error(`[${label}] attempt ${attempt}/${MAX_ATTEMPTS}: ${error.message}`);
      if (attempt === MAX_ATTEMPTS || !retryable(error)) throw error;
      await sleep(RETRY_DELAY_MS);
    }
  }
}

function imageType(buffer, contentType = '') {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { extension: 'png', contentType: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: 'jpg', contentType: 'image/jpeg' };
  }
  const error = new Error(`Unsupported or invalid image (Content-Type: ${contentType || 'unknown'}); only PNG/JPEG are supported`);
  error.permanent = true;
  throw error;
}

async function download(url) {
  let parsed;
  try { parsed = new URL(url); } catch {
    const error = new Error('Invalid image URL');
    error.permanent = true;
    throw error;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const error = new Error('Only HTTP/HTTPS image URLs are allowed');
    error.permanent = true;
    throw error;
  }

  const response = await fetch(parsed, {
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000),
    headers: { 'user-agent': 'KingsNewsletterImageMigration/1.0' }
  });
  if (!response.ok) {
    const error = new Error(`Image download returned HTTP ${response.status}`);
    error.status = response.status;
    if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) error.permanent = true;
    throw error;
  }
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > 25 * 1024 * 1024) {
    const error = new Error('Image exceeds the 25 MiB size limit');
    error.permanent = true;
    throw error;
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length || buffer.length > 25 * 1024 * 1024) {
    const error = new Error('Image is empty or exceeds the 25 MiB size limit');
    error.permanent = true;
    throw error;
  }
  return { buffer, ...imageType(buffer, response.headers.get('content-type')) };
}

async function upload(key, buffer, contentType) {
  const encodedKey = key.split('/').map(encodeURIComponent).join('/');
  const url = `${CLOUDFLARE_API}/accounts/${encodeURIComponent(config.accountId)}/r2/buckets/${encodeURIComponent(config.bucket)}/objects/${encodedKey}`;
  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${config.apiToken}`,
      'content-type': contentType,
      'content-length': String(buffer.length)
    },
    body: buffer,
    signal: AbortSignal.timeout(60_000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const error = new Error(`R2 upload HTTP ${response.status}: ${(body.errors || []).map((item) => item.message).join('; ') || 'unknown error'}`);
    error.status = response.status;
    if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) error.permanent = true;
    throw error;
  }
  return body.result;
}

async function verifyPublicUrl(url, expectedType) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow' });
  if (!response.ok) {
    const error = new Error(`Public URL verification returned HTTP ${response.status}`);
    error.status = response.status;
    if (response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status)) error.permanent = true;
    throw error;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = imageType(bytes, response.headers.get('content-type'));
  if (actual.contentType !== expectedType) {
    const error = new Error(`Public image type mismatch: expected ${expectedType}, received ${actual.contentType}`);
    error.permanent = true;
    throw error;
  }
}

function nestedValue(document, path) {
  return path.split('.').reduce((value, key) => value?.[key], document);
}

async function main() {
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 15_000 });
  const report = { edition: null, newsItems: 0, updated: 0, skipped: 0, failures: [] };

  try {
    await client.connect();
    const db = client.db(config.database);
    const edition = await db.collection(config.editionsCollection).findOne(
      {},
      { sort: { issueNumber: -1 }, projection: { issueNumber: 1, editionDate: 1, date: 1, [config.editionDateField]: 1, _id: 1 } }
    );
    if (!edition) throw new Error(`No edition found in ${config.database}.${config.editionsCollection}`);

    const editionDate = edition[config.editionDateField] ?? edition.editionDate ?? edition.date;
    if (editionDate === undefined || editionDate === null) {
      throw new Error(`Latest edition has no "${config.editionDateField}" date; set NEWS_EDITION_DATE_FIELD`);
    }
    report.edition = { id: String(edition._id), issueNumber: edition.issueNumber ?? null, date: editionDate };
    console.log(`Edition #${edition.issueNumber ?? 'unknown'} — ${editionDate}${config.dryRun ? ' (DRY RUN)' : ''}`);

    const collection = db.collection(config.newsCollection);
    const items = await collection.find({ [config.editionDateField]: editionDate }).toArray();
    report.newsItems = items.length;
    const uploadBySourceUrl = new Map();

    for (const item of items) {
      const sourceUrl = nestedValue(item, config.imageUrlField);
      const title = item.title || item.headline || item.name || String(item._id);
      if (typeof sourceUrl !== 'string' || !sourceUrl.trim()) {
        report.skipped += 1;
        console.log(`SKIP ${title}: no image URL`);
        continue;
      }
      if (sourceUrl.startsWith(`${config.publicBase}/`)) {
        report.skipped += 1;
        console.log(`SKIP ${title}: already hosted on R2`);
        continue;
      }

      try {
        let migrated = uploadBySourceUrl.get(sourceUrl);
        if (!migrated) {
          const file = await retry('download', () => download(sourceUrl));
          const editionKey = edition.issueNumber ?? sha256(String(edition._id)).slice(0, 12);
          const key = `editions/${editionKey}/images/${sha256(sourceUrl)}.${file.extension}`;
          const publicUrl = `${config.publicBase}/${key}`;

          if (!config.dryRun) {
            await retry('upload', async () => {
              // Recover safely if an earlier upload succeeded but its response was lost.
              try {
                await verifyPublicUrl(publicUrl, file.contentType);
                return { alreadyUploaded: true };
              } catch (error) {
                if (error.status !== 404) throw error;
              }
              return upload(key, file.buffer, file.contentType);
            });
            await retry('public URL verification', () => verifyPublicUrl(publicUrl, file.contentType));
          }
          migrated = { publicUrl, contentType: file.contentType };
          uploadBySourceUrl.set(sourceUrl, migrated);
        }

        if (config.dryRun) {
          console.log(`DRY RUN ${title}: would set image URL to ${migrated.publicUrl}`);
          continue;
        }

        const current = await collection.findOne({ _id: item._id }, { projection: { [config.imageUrlField]: 1 } });
        const currentUrl = nestedValue(current, config.imageUrlField);
        if (currentUrl === migrated.publicUrl) {
          report.skipped += 1;
          continue;
        }
        if (currentUrl !== sourceUrl) throw new Error('Image URL changed during migration; record left untouched');

        await retry('MongoDB update', async () => {
          const result = await collection.updateOne(
            { _id: item._id, [config.imageUrlField]: sourceUrl },
            { $set: { [config.imageUrlField]: migrated.publicUrl } }
          );
          if (result.modifiedCount !== 1) {
            const latest = await collection.findOne({ _id: item._id }, { projection: { [config.imageUrlField]: 1 } });
            if (nestedValue(latest, config.imageUrlField) !== migrated.publicUrl) {
              throw new Error('Conditional update did not modify the expected image URL');
            }
          }
        });
        report.updated += 1;
        console.log(`UPDATED ${title}`);
      } catch (error) {
        report.failures.push({ id: String(item._id), title, sourceUrl, reason: error.message });
        console.error(`FAILED ${title}: ${error.message}`);
      }
    }
  } finally {
    await client.close();
    console.log('\nMigration report');
    console.log(JSON.stringify(report, null, 2));
  }
}

main().catch((error) => {
  console.error(`Migration aborted: ${error.message}`);
  process.exitCode = 1;
});
