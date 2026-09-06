import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MEDIA_FORMATS,
  MEDIA_MAX_BYTES,
  formatBytes,
  sniffMediaMime,
} from '@shop/shared';

/** Minimal valid headers for each accepted format. */
const HEADERS = {
  jpeg: [0xff, 0xd8, 0xff, 0xe0],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  gif: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61],
  // "RIFF" + 4 size bytes + "WEBP"
  webp: [
    0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ],
};

function bytes(header: number[], padTo = 64): Uint8Array {
  const out = new Uint8Array(Math.max(header.length, padTo));
  out.set(header);
  return out;
}

describe('media type sniffing', () => {
  it('identifies every accepted format by its magic bytes', () => {
    assert.equal(sniffMediaMime(bytes(HEADERS.jpeg)), 'image/jpeg');
    assert.equal(sniffMediaMime(bytes(HEADERS.png)), 'image/png');
    assert.equal(sniffMediaMime(bytes(HEADERS.gif)), 'image/gif');
    assert.equal(sniffMediaMime(bytes(HEADERS.webp)), 'image/webp');
  });

  it('rejects content that only claims to be an image', () => {
    // The whole point of sniffing: `Content-Type` comes from the client, so a
    // script or an HTML page labelled `image/png` must not be stored as one.
    const script = new TextEncoder().encode('<script>alert(1)</script>');
    assert.equal(sniffMediaMime(script), null);

    const html = new TextEncoder().encode('<!DOCTYPE html><html></html>');
    assert.equal(sniffMediaMime(html), null);

    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg">');
    assert.equal(
      sniffMediaMime(svg),
      null,
      'SVG can carry script and is deliberately not accepted',
    );
  });

  it('rejects an MP4, which is not accepted yet', () => {
    // ftyp box at offset 4. Asserted so enabling video is a conscious change to
    // MEDIA_FORMATS and not something that quietly starts working.
    const mp4 = bytes([
      0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    assert.equal(sniffMediaMime(mp4), null);
  });

  it('rejects a truncated file instead of guessing', () => {
    assert.equal(sniffMediaMime(new Uint8Array([0xff])), null);
    assert.equal(sniffMediaMime(new Uint8Array()), null);
  });

  it('does not mistake a RIFF container for WebP', () => {
    // A WAV file is also RIFF; only the WEBP tag at offset 8 makes it an image.
    const wav = bytes([
      0x52, 0x49, 0x46, 0x46, 0x24, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]);
    assert.equal(sniffMediaMime(wav), null);
  });
});

describe('media limits', () => {
  it('gives GIF a larger cap than still images, and reports the max', () => {
    // GIF is a wasteful format; a still-image budget would reject almost every
    // real animation.
    assert.ok(
      MEDIA_FORMATS['image/gif']!.maxBytes >
        MEDIA_FORMATS['image/jpeg']!.maxBytes,
    );
    // The multipart limit must admit the largest single accepted file, or the
    // stream aborts before the per-format check can produce a clear message.
    assert.equal(MEDIA_MAX_BYTES, MEDIA_FORMATS['image/gif']!.maxBytes);
  });

  it('classifies GIF as an animation and stills as images', () => {
    assert.equal(MEDIA_FORMATS['image/gif']!.kind, 'ANIMATION');
    assert.equal(MEDIA_FORMATS['image/png']!.kind, 'IMAGE');
  });

  it('formats sizes the way the error messages read', () => {
    assert.equal(formatBytes(2 * 1024 * 1024), '2 МБ');
    assert.equal(formatBytes(5 * 1024 * 1024), '5 МБ');
    assert.equal(formatBytes(512 * 1024), '512 КБ');
    assert.equal(formatBytes(1.5 * 1024 * 1024), '1.5 МБ');
  });
});
