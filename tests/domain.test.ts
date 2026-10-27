import { test } from 'node:test';
import assert from 'node:assert/strict';
import { absoluteTime, canonicalPostUrl, redditUrl, subredditName } from '../src/domain.ts';

test('subreddit input is canonical and does not accept lookalike hosts or arbitrary paths', () => {
  assert.equal(subredditName(' https://old.reddit.com/r/Python/ '), 'python');
  assert.equal(subredditName('r/UK'), 'uk');
  for (const value of ['https://reddit.com.evil.test/r/python', 'https://user@reddit.com/r/python',
    'https://reddit.com/r/python/comments/abc', '../python', 'python?limit=100']) {
    assert.throws(() => subredditName(value));
  }
});

test('post links are checked against identity before canonicalisation', () => {
  assert.equal(canonicalPostUrl('https://old.reddit.com/r/Python/comments/abc/title/?utm_source=x', 't3_abc', 'python'),
    'https://www.reddit.com/r/python/comments/abc/');
  assert.throws(() => canonicalPostUrl('/r/python/comments/def/title/', 'abc', 'python'));
  assert.throws(() => canonicalPostUrl('/r/javascript/comments/abc/title/', 'abc', 'python'));
  assert.throws(() => canonicalPostUrl('/r/python/comments/abc/title/parent/', 'abc', 'python'));
  for (const value of ['http://reddit.com', 'https://reddit.com:9999', '//evil.test/r/python', 'javascript:alert(1)']) {
    assert.throws(() => redditUrl(value));
  }
});

test('absolute DOM timestamps retain their precision and offset', () => {
  assert.deepEqual(absoluteTime('2026-09-30T09:30+01:00'), { epochMs: Date.UTC(2026, 8, 30, 8, 30), precisionMs: 60_000 });
  assert.deepEqual(absoluteTime('2026-09-30T08:30:05Z'), { epochMs: Date.UTC(2026, 8, 30, 8, 30, 5), precisionMs: 1_000 });
  assert.deepEqual(absoluteTime('2026-09-30T08:30:05.12Z'), { epochMs: Date.UTC(2026, 8, 30, 8, 30, 5, 120), precisionMs: 10 });
  assert.notEqual(absoluteTime('2024-02-29T00:00:00Z'), null);
});

test('relative, ambiguous and invalid dates are omissions rather than guessed timestamps', () => {
  for (const value of ['2 hours ago', '2026-09-30T08:30', '2026-02-29T00:00:00Z',
    '2026-09-31T00:00:00Z', '2026-09-30T24:00:00Z', '2026-09-30T08:30:60Z', '2026-09-30T08:30+14:01']) {
    assert.equal(absoluteTime(value), null, value);
  }
});
