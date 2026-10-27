import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RequestQueue } from '../src/request-gate.ts';

test('an explicit fixed interval remains available for local fixture queues', async () => {
  let now = 0;
  const queue = new RequestQueue({ intervalMs:5_000, clock: { now: () => now, sleep: async ms => { now += ms; } } });
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

test('production pacing samples fresh 4–6 second gaps after each response, without overlapping requests',async()=>{
  let now=0,active=0;const samples=[0,1,0.25,0.75,0.5];
  const queue=new RequestQueue({fromCompletion:true,random:()=>samples.shift()!,clock:{now:()=>now,sleep:async ms=>{now+=ms;}}});
  const starts:number[]=[],ends:number[]=[];
  await Promise.all([12000,0,10000,0,0].map(duration=>queue.run(async()=>{
    assert.equal(active++,0);starts.push(now);now+=duration;await Promise.resolve();ends.push(now);active--;
  })));
  assert.deepEqual(queue.intervalMs,[4000,6000]);
  assert.deepEqual(starts.slice(1).map((start,index)=>start-ends[index]!),[4000,6000,4500,5500]);
  assert.equal(queue.released,5);assert.equal(samples.length,0);
});

test('cancelling a randomized wait prevents release and preserves the sampled deadline for later work',async()=>{
  let now=0,sampled=0,abortWait=true;const controller=new AbortController();
  const queue=new RequestQueue({fromCompletion:true,random:()=>{sampled++;return 0.75;},clock:{now:()=>now,sleep:async(ms,signal)=>{
    if(abortWait){abortWait=false;controller.abort();signal!.throwIfAborted();}now+=ms;
  }}});
  await queue.run(async()=>{});
  await assert.rejects(queue.run(async()=>assert.fail('Cancelled request must not dispatch'),controller.signal),{name:'AbortError'});
  assert.equal(queue.released,1);assert.equal(sampled,1);
  await queue.run(async()=>assert.equal(now,5500));
  assert.equal(sampled,2);assert.equal(queue.released,2);
});

test('invalid interval ranges cannot disable pacing',()=>{
  for(const intervalMs of [-1,NaN,Infinity,[-1,1],[6000,4000],[4000,Infinity]] as const)
    assert.throws(()=>new RequestQueue({intervalMs}),/Invalid request interval/);
});
