import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestQueue } from '../src/request-gate.ts';

test('resource requests and redirects share one five-second start queue', async () => {
  let now = 0;
  const queue = new RequestQueue({ clock: { now: () => now, sleep: async ms => { now += ms; } } });
  const starts: number[] = [];
  await Promise.all(['document', 'redirect', 'script', 'image', 'worker'].map(async () =>
    queue.run(async () => { starts.push(now); })));
  assert.deepEqual(starts, [0, 5_000, 10_000, 15_000, 20_000]);
  assert.equal(queue.released, 5);
});

test('stopping the request queue cancels already queued releases', async () => {
  let ran = 0;
  const queue = new RequestQueue();
  const first = queue.run(async () => { ran++; queue.stop(); });
  const second = queue.run(async () => { ran++; });
  await first;
  await assert.rejects(second, { name: 'AbortError' });
  assert.equal(ran, 1);
});

test('production gate pacing starts its five-second gap after the previous response lifecycle',async()=>{
  let now=0;const queue=new RequestQueue({fromCompletion:true,clock:{now:()=>now,sleep:async ms=>{now+=ms;}}});const starts:number[]=[];
  await Promise.all([queue.run(async()=>{starts.push(now);now+=12000;}),queue.run(async()=>{starts.push(now);})]);
  assert.deepEqual(starts,[0,17000]);
});
