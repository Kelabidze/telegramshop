import { randomBytes } from 'node:crypto';
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  MEDIA_FORMATS,
  MEDIA_TOTAL_QUOTA_BYTES,
  type MediaAsset,
  formatBytes,
  sniffMediaMime,
} from '@shop/shared';
import { config } from '../config.js';
import { AppError, validationError } from '../errors.js';

/**
 * Uploaded media for banners and product cards.
 *
 * Files go to disk, not to the database: SQLite would hold megabytes of blobs in
 * the same file the orders live in, and every backup would carry them. The
 * directory is outside the release tree so a deploy cannot delete it.
 *
 * The public URL is `/uploads/<name>`, served by Caddy in production and by the
 * Vite proxy in development.
 */

export const UPLOADS_URL_PREFIX = '/uploads';

/**
 * Names are generated, never taken from the client.
 *
 * A user-supplied filename is the classic path-traversal vector (`../../`), and
 * even sanitised it invites collisions. Random name + extension derived from the
 * *sniffed* type means the stored name can only ever be safe.
 */
function generateFileName(extension: string): string {
  return `${randomBytes(16).toString('hex')}.${extension}`;
}

async function ensureDir(): Promise<void> {
  await mkdir(config.uploadsDir, { recursive: true });
}

/** Bytes currently occupied by uploads. */
async function usedBytes(): Promise<number> {
  await ensureDir();
  const names = await readdir(config.uploadsDir);
  let total = 0;
  for (const name of names) {
    try {
      const info = await stat(path.join(config.uploadsDir, name));
      if (info.isFile()) total += info.size;
    } catch {
      // Vanished between readdir and stat; it contributes nothing.
    }
  }
  return total;
}

export interface StoreMediaInput {
  bytes: Buffer;
  /** What the client claimed. Used only to detect a mismatch, never trusted. */
  declaredMimeType: string | undefined;
}

/**
 * Validates and stores one file.
 *
 * Order matters: the content is identified first, and only then checked against
 * that format's size cap. Doing it the other way would let a 5 MB file labelled
 * `image/gif` through as an "image" before anyone looked inside it.
 */
export async function storeMedia(input: StoreMediaInput): Promise<MediaAsset> {
  if (input.bytes.length === 0) {
    throw validationError('Файл пустой.');
  }

  const mimeType = sniffMediaMime(input.bytes);
  if (!mimeType) {
    throw validationError(
      'Неподдерживаемый файл. Допустимы JPEG, PNG, WebP и GIF.',
    );
  }

  const format = MEDIA_FORMATS[mimeType];
  if (!format) {
    throw validationError('Неподдерживаемый формат файла.');
  }

  // A mismatch means the file is not what the uploader thinks it is. Worth
  // refusing rather than silently storing: usually a renamed extension.
  if (
    input.declaredMimeType &&
    input.declaredMimeType !== mimeType &&
    // Browsers report GIF/WebP inconsistently on some platforms; only flag a
    // disagreement about the actual media class.
    input.declaredMimeType.startsWith('image/') === false
  ) {
    throw validationError(
      `Содержимое файла (${mimeType}) не совпадает с заявленным типом.`,
    );
  }

  if (input.bytes.length > format.maxBytes) {
    throw validationError(
      `Файл больше ${formatBytes(format.maxBytes)} для ${mimeType}.`,
    );
  }

  const used = await usedBytes();
  if (used + input.bytes.length > MEDIA_TOTAL_QUOTA_BYTES) {
    // A clear refusal beats ENOSPC: a full disk on this VPS also breaks deploys
    // and the SQLite write path, which is a far worse failure than a rejected
    // upload.
    throw new AppError(
      'CONFLICT',
      `Хранилище заполнено (${formatBytes(used)} из ` +
        `${formatBytes(MEDIA_TOTAL_QUOTA_BYTES)}). Удалите ненужные файлы.`,
    );
  }

  await ensureDir();
  const fileName = generateFileName(format.extension);
  await writeFile(path.join(config.uploadsDir, fileName), input.bytes);

  return {
    url: `${UPLOADS_URL_PREFIX}/${fileName}`,
    kind: format.kind,
    mimeType,
    byteSize: input.bytes.length,
  };
}

/**
 * Deletes an uploaded file by its public URL.
 *
 * Only touches names this module could have generated: the basename must be
 * `<32 hex>.<ext>`. Anything else — a traversal attempt, or a URL pointing at
 * some other host's image — is ignored rather than acted on.
 */
export async function deleteMediaByUrl(url: string): Promise<boolean> {
  if (!url.startsWith(`${UPLOADS_URL_PREFIX}/`)) return false;

  const name = path.basename(url.slice(UPLOADS_URL_PREFIX.length + 1));
  if (!/^[0-9a-f]{32}\.[a-z0-9]{2,5}$/.test(name)) return false;

  try {
    await unlink(path.join(config.uploadsDir, name));
    return true;
  } catch {
    // Already gone: the caller's intent is satisfied either way.
    return false;
  }
}

export interface MediaUsage {
  usedBytes: number;
  quotaBytes: number;
  fileCount: number;
}

/** Storage usage, for the admin UI to show before someone hits the ceiling. */
export async function mediaUsage(): Promise<MediaUsage> {
  await ensureDir();
  const names = await readdir(config.uploadsDir);
  let total = 0;
  let count = 0;
  for (const name of names) {
    try {
      const info = await stat(path.join(config.uploadsDir, name));
      if (!info.isFile()) continue;
      total += info.size;
      count += 1;
    } catch {
      // Ignore races.
    }
  }
  return {
    usedBytes: total,
    quotaBytes: MEDIA_TOTAL_QUOTA_BYTES,
    fileCount: count,
  };
}
