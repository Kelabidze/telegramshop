import { z } from 'zod';

/**
 * Media standard for banners and product cards.
 *
 * One module so the limits cannot drift: the Mini App refuses an oversized file
 * before uploading it, and the API refuses it again on arrival. A client-side
 * check alone is advice, not a rule — anyone can post to the endpoint directly.
 *
 * Video (MP4) is deliberately absent for now. Serving it needs `media-src` in
 * the production CSP and a Caddy route, and the size that makes video worth
 * having would dominate a 200 MB quota. The shape below is built so adding it
 * later is one entry in `MEDIA_KINDS`.
 */

/** What a stored media file may be. */
export const MEDIA_KINDS = ['IMAGE', 'ANIMATION'] as const;
export const mediaKindSchema = z.enum(MEDIA_KINDS);
export type MediaKind = z.infer<typeof mediaKindSchema>;

export interface MediaFormat {
  readonly mimeType: string;
  readonly extension: string;
  readonly kind: MediaKind;
  /** Hard cap in bytes. */
  readonly maxBytes: number;
  /**
   * Leading bytes every file of this type must start with.
   *
   * Checked instead of trusting `Content-Type`, which the client sets and can
   * lie about: an "image/png" upload that is actually a script must be refused
   * on content, not on its label. `null` where the signature is not at offset 0
   * (WebP), handled separately.
   */
  readonly signature: readonly number[] | null;
}

const MB = 1024 * 1024;

/**
 * Accepted formats, keyed by MIME type.
 *
 * JPEG/PNG/WebP at 2 MB covers a 1920×1080 photo comfortably. GIF gets 5 MB
 * because the format is wasteful, and even that only buys a few seconds of
 * animation — the admin UI says so rather than letting someone wonder why their
 * 12 MB GIF was rejected.
 */
export const MEDIA_FORMATS: Readonly<Record<string, MediaFormat>> = {
  'image/jpeg': {
    mimeType: 'image/jpeg',
    extension: 'jpg',
    kind: 'IMAGE',
    maxBytes: 2 * MB,
    signature: [0xff, 0xd8, 0xff],
  },
  'image/png': {
    mimeType: 'image/png',
    extension: 'png',
    kind: 'IMAGE',
    maxBytes: 2 * MB,
    signature: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  'image/webp': {
    mimeType: 'image/webp',
    extension: 'webp',
    kind: 'IMAGE',
    maxBytes: 2 * MB,
    // "RIFF" at 0, "WEBP" at 8 — verified by `sniffMediaMime`.
    signature: null,
  },
  'image/gif': {
    mimeType: 'image/gif',
    extension: 'gif',
    kind: 'ANIMATION',
    maxBytes: 5 * MB,
    signature: [0x47, 0x49, 0x46, 0x38],
  },
};

/** For `accept` on a file input, and for the copy that explains the rules. */
export const ACCEPTED_MEDIA_MIME_TYPES = Object.keys(MEDIA_FORMATS);

/** Largest accepted file across all formats — the multipart limit. */
export const MEDIA_MAX_BYTES = Math.max(
  ...Object.values(MEDIA_FORMATS).map((format) => format.maxBytes),
);

/**
 * Recommended pixel dimensions. Advisory, not enforced: measuring an image
 * server-side would mean decoding it, and a decoder is a much larger attack
 * surface than a size check.
 *
 * Two banner shapes, because the two storefront sections frame their artwork
 * differently: the catalog strip is 16:9, «Всё для абуза» is a full-width 1:1
 * poster. The frame is CSS, but the advertised size has to match it — a 16:9
 * upload in a square frame gets cropped top and bottom, which is how a designed
 * banner loses its text.
 */
export const MEDIA_DIMENSIONS = {
  banner: { width: 1280, height: 720, ratio: '16:9' },
  bannerSquare: { width: 1080, height: 1080, ratio: '1:1' },
  product: { width: 800, height: 800, ratio: '1:1' },
} as const;

/** Which set of recommended dimensions a picker should advertise. */
export type MediaShape = keyof typeof MEDIA_DIMENSIONS;

/** Total bytes all uploads may occupy. The VPS disk is small and shared. */
export const MEDIA_TOTAL_QUOTA_BYTES = 200 * MB;

/**
 * Identifies a file by its leading bytes, ignoring any declared type.
 *
 * Returns the MIME type, or null when the content matches nothing accepted.
 */
export function sniffMediaMime(bytes: Uint8Array): string | null {
  for (const format of Object.values(MEDIA_FORMATS)) {
    if (!format.signature) continue;
    if (startsWith(bytes, format.signature)) return format.mimeType;
  }

  // WebP: "RIFF" then four size bytes then "WEBP".
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    startsWith(bytes.subarray(8), [0x57, 0x45, 0x42, 0x50])
  ) {
    return 'image/webp';
  }

  return null;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

/** Human-readable size, for error messages and the admin hint. */
export function formatBytes(bytes: number): string {
  if (bytes >= MB) {
    const mb = bytes / MB;
    return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} МБ`;
  }
  return `${Math.round(bytes / 1024)} КБ`;
}

/** Server-side result of a stored upload. */
export const mediaAssetSchema = z.object({
  /** Public path, e.g. `/uploads/ab12….jpg`. Same origin as the app. */
  url: z.string().min(1),
  kind: mediaKindSchema,
  mimeType: z.string().min(1),
  byteSize: z.number().int().positive(),
});
export type MediaAsset = z.infer<typeof mediaAssetSchema>;

/**
 * A product's visual: either an uploaded file or a single emoji.
 *
 * Exactly one of the two, which is why this is a union and not two independent
 * nullable fields: a product with both set would render differently depending on
 * which branch a component checked first.
 */
export const PRODUCT_MEDIA_MODES = ['IMAGE', 'EMOJI'] as const;
export const productMediaModeSchema = z.enum(PRODUCT_MEDIA_MODES);
export type ProductMediaMode = z.infer<typeof productMediaModeSchema>;

/**
 * A single emoji. Length is measured in code points, not UTF-16 units: many
 * emoji are surrogate pairs, and `'🎁'.length === 2` would reject them all.
 */
export const emojiSchema = z
  .string()
  .trim()
  .min(1, 'Укажите эмодзи')
  .refine((value) => [...value].length <= 4, 'Не больше одного эмодзи');
