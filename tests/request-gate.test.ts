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

test('Offline mode aborts the network signal, rejects new releases and cannot revive old queued requests',async()=>{
  const queue=new RequestQueue({intervalMs:0});let release!:()=>void,started!:()=>void,calls=0;
  const began=new Promise<void>(resolve=>{started=resolve;}),hold=new Promise<void>(resolve=>{release=resolve;});
  const first=queue.run(async()=>{calls++;started();await hold;}),signal=queue.signal;
  const old=queue.run(async()=>{calls++;});await began;queue.setOffline(true);assert(signal.aborted);await assert.rejects(queue.run(async()=>{calls++;}),/Offline mode/);
  queue.setOffline(false);release();await first;await assert.rejects(old,{name:'AbortError'});assert.equal(calls,1);assert.equal(queue.signal.aborted,false);await queue.run(async()=>{calls++;});assert.equal(calls,2);
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

test('each source retains its own sampled completion deadline when switching between sources',async()=>{
 let now=0;const samples=[0,1,0.25,0.75],starts:{source:string;at:number}[]=[];
 const queue=new RequestQueue({fromCompletion:true,random:()=>samples.shift()!,clock:{now:()=>now,sleep:async ms=>{now+=ms;}}});
 const run=(source:string,duration=0)=>queue.run(async()=>{starts.push({source,at:now});now+=duration;},undefined,source);
 await run('reddit',100);await run('tumblr',200);await run('reddit');await run('tumblr');
 assert.deepEqual(starts,[{source:'reddit',at:0},{source:'tumblr',at:100},{source:'reddit',at:4100},{source:'tumblr',at:6300}]);assert.equal(queue.released,4);
});

test('a slow response holds its own source but does not block another source from dispatching',async()=>{
 let now=0,release!:()=>void;const calls:string[]=[],hold=new Promise<void>(resolve=>{release=resolve;});
 const queue=new RequestQueue({fromCompletion:true,random:()=>0.5,clock:{now:()=>now,sleep:async ms=>{now+=ms;}}});
 const reddit=queue.run(async()=>{calls.push('reddit first');await hold;},undefined,'reddit');
 const next=queue.run(async()=>{assert.equal(now,5000);calls.push('reddit second');},undefined,'reddit');
 try{await queue.run(async()=>{assert.equal(now,0);calls.push('tumblr');},undefined,'tumblr');assert.deepEqual(calls,['reddit first','tumblr']);}
 finally{release();await Promise.all([reddit,next]);}
 assert.deepEqual(calls,['reddit first','tumblr','reddit second']);
});

test('Offline mode aborts queued work across every source and going online never revives that old work',async()=>{
 let release!:()=>void;const calls:string[]=[],hold=new Promise<void>(resolve=>{release=resolve;}),queue=new RequestQueue({intervalMs:0});
 const active=['reddit','tumblr'].map(source=>queue.run(async()=>{calls.push(source);await hold;},undefined,source));
 const pending=['reddit','tumblr'].map(source=>assert.rejects(queue.run(async()=>{assert.fail('Old queued work must stay aborted');},undefined,source),{name:'AbortError'}));
 await Promise.resolve();queue.setOffline(true);assert(queue.signal.aborted);await assert.rejects(queue.run(async()=>assert.fail('New source must stay offline'),undefined,'future-source'),/Offline mode/);
 queue.setOffline(false);release();await Promise.all([...active,...pending]);assert.deepEqual(calls,['reddit','tumblr']);assert.equal(queue.released,2);
 await queue.run(async()=>calls.push('new tumblr'),undefined,'tumblr');assert.equal(queue.released,3);
});
