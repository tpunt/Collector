import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserLimiter, BrowserPausedError, retryAfter } from '../src/limiter.ts';
import type { Clock } from '../src/limiter.ts';

function fakeClock() {
  let now = 0;
  const waits: number[] = [];
  const clock: Clock = { now: () => now, sleep: async ms => { waits.push(ms); now += ms; } };
  return { clock, waits, advance: (ms: number) => { now += ms; } };
}

test('one limiter serialises source and thread operations and spaces them from readiness', async () => {
  const { clock, waits, advance } = fakeClock();
  const limiter = new BrowserLimiter({ clock });
  const starts: number[] = [];
  let active = 0;
  let maxActive = 0;
  const action = async () => {
    starts.push(clock.now());
    active++;
    maxActive = Math.max(maxActive, active);
    await Promise.resolve();
    advance(2_000); // Real navigation/readiness is part of the operation.
    active--;
  };
  await Promise.all([limiter.run('navigation', action), limiter.run('load', action), limiter.run('navigation', action)]);
  assert.deepEqual(starts, [0, 7_000, 19_000]);
  assert.deepEqual(waits, [5_000, 10_000]);
  assert.equal(maxActive, 1);
});

test('a block stops queued jobs and expiry alone does not resume browsing', async () => {
  const { clock, advance } = fakeClock();
  const limiter = new BrowserLimiter({ clock });
  let laterRan = false;
  const blocked = limiter.run('navigation', async () => { limiter.pause('HTTP 429', 30_000); });
  const later = limiter.run('navigation', async () => { laterRan = true; });
  await assert.rejects(blocked, BrowserPausedError);
  await assert.rejects(later, BrowserPausedError);
  assert.equal(laterRan, false);
  assert.throws(() => limiter.resume(true), BrowserPausedError);
  advance(30_000);
  await assert.rejects(limiter.run('navigation', async () => {}), BrowserPausedError);
  assert.throws(() => limiter.resume(false), /revalidation/);
  limiter.resume(true);
  await limiter.run('navigation', async () => { laterRan = true; });
  assert.equal(laterRan, true);
});

test('a failed navigation does not poison the queue or skip spacing', async () => {
  const { clock, waits } = fakeClock();
  const limiter = new BrowserLimiter({ clock });
  await assert.rejects(limiter.run('navigation', async () => { throw new Error('transport failure'); }), /transport failure/);
  assert.equal(await limiter.run('navigation', async () => 'next explicit operation'), 'next explicit operation');
  assert.deepEqual(waits, [10_000]);
});

test('aborting a queued operation never invokes its callback', async () => {
  const { clock } = fakeClock();
  const limiter = new BrowserLimiter({ clock });
  const controller = new AbortController();
  let ran = false;
  controller.abort();
  await assert.rejects(limiter.run('load', async () => { ran = true; }, controller.signal), { name: 'AbortError' });
  assert.equal(ran, false);
});

test('Retry-After supports seconds and HTTP dates without treating invalid headers as permission', () => {
  assert.equal(retryAfter('12', 1_000), 13_000);
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:01:00 GMT', 1_000), 60_000);
  assert.equal(retryAfter('bad', 1_000), null);
  assert.equal(retryAfter(null, 1_000), null);
});
