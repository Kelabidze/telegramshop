import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  zoneNowCardInputSchema,
  zoneNowCardUpdateSchema,
} from '@shop/shared';

/**
 * The Zone Now action link.
 *
 * This card is the one piece of home-screen copy staff can edit, and its link is
 * handed straight to a navigation call. So the field is not a free-form string:
 * it reuses `bannerLinkSchema`, which accepts an `https://` URL or an in-app
 * `category:slug` and nothing else.
 *
 * Worth its own test because the failure is silent in both directions. A
 * `javascript:` URL would be a scripting vector reachable through a CMS field,
 * and a plausible-looking `/catalog` parses as neither shape — it would save
 * fine under a loose schema and then do nothing at all when tapped, since
 * `openExternal` cannot resolve a relative path.
 */

const base = { title: 'Заголовок', text: 'Текст карточки' };

describe('Zone Now action link', () => {
  it('accepts an https URL', () => {
    const parsed = zoneNowCardInputSchema.safeParse({
      ...base,
      actionLabel: 'Открыть',
      actionUrl: 'https://t.me/example',
    });
    assert.equal(parsed.success, true);
  });

  it('accepts an in-app category target', () => {
    const parsed = zoneNowCardInputSchema.safeParse({
      ...base,
      actionLabel: 'Смотреть',
      actionUrl: 'category:giftcards',
    });
    assert.equal(parsed.success, true);
  });

  it('accepts no link at all, which renders no button', () => {
    const parsed = zoneNowCardInputSchema.safeParse({
      ...base,
      actionLabel: null,
      actionUrl: null,
    });
    assert.equal(parsed.success, true);
  });

  it('refuses a javascript: URL', () => {
    // The reason the field is validated at all: this value reaches a navigation
    // call, so a CMS field must not be able to smuggle a script into the app.
    for (const hostile of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
    ]) {
      const parsed = zoneNowCardInputSchema.safeParse({
        ...base,
        actionLabel: 'Открыть',
        actionUrl: hostile,
      });
      assert.equal(parsed.success, false, `should refuse ${hostile}`);
    }
  });

  it('refuses a relative path, which would silently do nothing', () => {
    // `/catalog` is the shape somebody types by hand. It is not an in-app target
    // and not a URL: saved as-is, the button would render and then no-op.
    const parsed = zoneNowCardInputSchema.safeParse({
      ...base,
      actionLabel: 'В каталог',
      actionUrl: '/catalog',
    });
    assert.equal(parsed.success, false);
  });

  it('refuses plain http, so the link cannot be downgraded', () => {
    const parsed = zoneNowCardInputSchema.safeParse({
      ...base,
      actionLabel: 'Открыть',
      actionUrl: 'http://example.com',
    });
    assert.equal(parsed.success, false);
  });

  it('applies the same rule on a partial update', () => {
    // The publish switch sends `isActive` alone, so the update schema has to stay
    // permissive about absence while still validating what it is given.
    assert.equal(
      zoneNowCardUpdateSchema.safeParse({ isActive: true }).success,
      true,
    );
    assert.equal(
      zoneNowCardUpdateSchema.safeParse({ actionUrl: 'javascript:alert(1)' })
        .success,
      false,
    );
  });

  it('defaults a new card to a draft', () => {
    // A card created without `isActive` must not appear on the home screen by
    // surprise: publishing is an explicit act.
    const parsed = zoneNowCardInputSchema.safeParse(base);
    assert.equal(parsed.success, true);
    assert.equal(parsed.success && parsed.data.isActive, false);
  });
});
