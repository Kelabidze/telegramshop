import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CLUB_TIER_PERCENT } from '@shop/shared';
import {
  congratulationsHtml,
  firstVisitHtml,
  membershipPollOffsetsMs,
  notSubscribedHtml,
  returningGuestHtml,
  returningMemberHtml,
} from './onboarding.ts';

const CHANNEL = 'https://t.me/rabrabrab111';

describe('club onboarding copy', () => {
  it('puts the channel URL on the word «канал», not as a raw dump', () => {
    const html = notSubscribedHtml(CHANNEL);
    assert.match(html, new RegExp(`<a href="${CHANNEL}">канал</a>`));
    // Visible text must not dump the URL next to the sentence; it lives only
    // in hrefs. Strip tags and the remaining string should have no t.me/.
    const visible = html.replace(/<[^>]+>/g, '');
    assert.doesNotMatch(visible, /t\.me\//);
    assert.match(html, /скидка в 5% не активна/);
    assert.match(html, new RegExp(`<a href="${CHANNEL}">OCHKISK</a>`));
  });

  it('escapes a hostile first name so HTML injection cannot land in the chat', () => {
    const html = returningMemberHtml('<script>alert(1)</script>');
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /<script>/);
  });

  it('does not mention the club rate to a returning member', () => {
    const html = returningMemberHtml('Анна');
    assert.match(html, /^С возвращением, Анна!/);
    assert.doesNotMatch(html, /скидк/i);
    assert.doesNotMatch(html, new RegExp(String(CLUB_TIER_PERCENT)));
  });

  it('repeats the missing-rate copy for a returning guest', () => {
    const html = returningGuestHtml('Анна', CHANNEL);
    assert.match(html, /^С возвращением, Анна!/);
    assert.match(html, /скидка в 5% не активна/);
    assert.match(html, new RegExp(`<a href="${CHANNEL}">канал</a>`));
  });

  it('greets a first visit without claiming they already have the rate', () => {
    const html = firstVisitHtml('Пётр', CHANNEL);
    assert.match(html, /^Привет, Пётр!/);
    assert.match(html, /клубной скидки 5%/);
    assert.doesNotMatch(html, /Поздравляю/);
  });

  it('congratulates without leftover "you are not subscribed" copy', () => {
    const html = congratulationsHtml();
    assert.equal(html, 'Поздравляю! Клубная скидка активна!');
    assert.doesNotMatch(html, /не активна/);
  });
});

describe('membership poll schedule', () => {
  it('starts at 3 s and then ticks every 3 s across a 15 s window', () => {
    // 3, 6, 9, 12, 15, 18 — first delay plus five more ticks covering 15 s.
    assert.deepEqual(membershipPollOffsetsMs(), [3_000, 6_000, 9_000, 12_000, 15_000, 18_000]);
  });
});
