import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  daysSince,
  displayNameSchema,
  pluralDays,
  viewerDisplayName,
} from '@shop/shared';

describe('tenure copy', () => {
  const start = '2026-01-01T12:00:00.000Z';

  it('floors to whole days so a fresh arrival is not "1 день"', () => {
    assert.equal(daysSince(start, new Date('2026-01-01T12:00:01.000Z')), 0);
    assert.equal(daysSince(start, new Date('2026-01-02T11:59:59.000Z')), 0);
    assert.equal(daysSince(start, new Date('2026-01-02T12:00:00.000Z')), 1);
    assert.equal(daysSince(start, new Date('2026-02-01T12:00:00.000Z')), 31);
  });

  it('never goes negative when the clocks disagree', () => {
    // The client clock can be behind the server's. "с нами -1 день" would be
    // the one output that is obviously broken to a user.
    assert.equal(daysSince(start, new Date('2025-12-30T12:00:00.000Z')), 0);
  });

  it('survives a malformed timestamp instead of rendering NaN', () => {
    assert.equal(daysSince('not a date'), 0);
  });

  it('declines «день» the way Russian does, including the teens', () => {
    assert.equal(pluralDays(1), 'день');
    assert.equal(pluralDays(2), 'дня');
    assert.equal(pluralDays(5), 'дней');
    // The cases that catch naive `n % 10` implementations:
    assert.equal(pluralDays(11), 'дней');
    assert.equal(pluralDays(12), 'дней');
    assert.equal(pluralDays(21), 'день');
    assert.equal(pluralDays(22), 'дня');
    assert.equal(pluralDays(101), 'день');
    assert.equal(pluralDays(111), 'дней');
    assert.equal(pluralDays(0), 'дней');
  });
});

describe('display name', () => {
  it('prefers the shop-local name over the Telegram one', () => {
    assert.equal(
      viewerDisplayName({
        displayName: 'Фин',
        firstName: 'Pavel',
        lastName: 'Baranov',
      }),
      'Фин',
    );
  });

  it('falls back to the Telegram name when there is no override', () => {
    assert.equal(
      viewerDisplayName({ displayName: null, firstName: 'Pavel', lastName: 'Baranov' }),
      'Pavel Baranov',
    );
    assert.equal(
      viewerDisplayName({ firstName: 'Pavel', lastName: null }),
      'Pavel',
    );
  });

  it('treats a whitespace-only override as absent', () => {
    // Otherwise the header would render an empty string and look broken.
    assert.equal(
      viewerDisplayName({ displayName: '   ', firstName: 'Pavel' }),
      'Pavel',
    );
  });

  it('rejects an empty or oversized name and trims the rest', () => {
    assert.equal(displayNameSchema.safeParse('  Фин  ').data, 'Фин');
    assert.equal(displayNameSchema.safeParse('').success, false);
    assert.equal(displayNameSchema.safeParse('   ').success, false);
    assert.equal(displayNameSchema.safeParse('x'.repeat(33)).success, false);
    assert.equal(displayNameSchema.safeParse('x'.repeat(32)).success, true);
  });
});
