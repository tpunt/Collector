import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ReaderStore} from '../src/store.ts';
import {ArchiveFetcher} from '../src/archive-fetch.ts';
import {archiveRange} from '../src/archive-fetch-state.ts';
import {RequestQueue} from '../src/request-gate.ts';

const start=Date.parse('2020-01-01T00:00:00Z');
const row=(index:number,overrides:Record<string,unknown>={})=>({id:(1000+index).toString(36),subreddit:'python',title:'Archived '+index,created_utc:start/1000+index,selftext:'Saved archive body',is_self:true,...overrides});
const json=(data:unknown[])=>new Response(JSON.stringify({data}),{headers:{'Content-Type':'application/json'}});
async function settled(fetcher:ArchiveFetcher){const deadline=Date.now()+10_000;while(fetcher.running){if(Date.now()>deadline)throw new Error('Archive did not settle');await delay(1);}}
const input={subreddit:'r/Python',from:'2020-01-01',to:'2020-01-01'};

test('archive dates include the full UTC end date and support all available history without accepting invalid or future dates',()=>{
 assert.deepEqual(archiveRange('2020-02-29','2020-02-29'),{afterMs:Date.parse('2020-02-29T00:00:00Z'),beforeMs:Date.parse('2020-03-01T00:00:00Z')});
 assert.equal(archiveRange('','2020-01-01').afterMs,0);
 for(const dates of [['2020-02-30','2020-03-01'],['2020-01-02','2020-01-01'],['2020-1-1','2020-01-02'],['','9999-01-01']])assert.throws(()=>archiveRange(...dates as [string,string]));
});

test('paged fetching retains timestamp ties, deduplicates boundary replay, saves media before advancing and shares completion pacing',async()=>{
 const store=new ReaderStore(':memory:');let time=0,lastEnd=-1,sampled=0;const starts:number[]=[],visits:string[]=[],gaps:number[]=[];const media:string[][]=[];
 const queue=new RequestQueue({fromCompletion:true,random:()=>sampled++%2===0?0.25:0.75,clock:{now:()=>time,sleep:async ms=>{time+=ms;}}});
 const checkGap=()=>{if(lastEnd>=0){const gap=time-lastEnd;assert.equal(gap,gaps.length%2===0?4500:5500);gaps.push(gap);}};
 const rows=Array.from({length:205},(_,i)=>row(i,{created_utc:start/1000+(i>=99&&i<=102?99:i)}));
 const fetcher=new ArchiveFetcher(store,{queue,fetch:async(url,options)=>{assert.equal(options?.credentials,'omit');assert.equal(options?.redirect,'manual');assert.equal(new URL(url as URL).hostname,'arctic-shift.photon-reddit.com');checkGap();starts.push(time);visits.push(String(url));const q=new URL(String(url)).searchParams,after=Date.parse(q.get('after')!);time+=100;lastEnd=time;return json(rows.filter(r=>r.created_utc*1000>after&&r.created_utc*1000<Date.parse(q.get('before')!)).slice(0,100));},saveMedia:async ids=>{media.push(ids);await queue.run(async()=>{checkGap();time+=25;lastEnd=time;},undefined,'reddit');}});
 try{
  const id=fetcher.start(input);await settled(fetcher);const job=store.archiveFetch(id)!;
  assert.equal(job.state,'done');assert.equal(job.observed,205);assert.equal(job.added,205);assert.equal(store.stats().posts,205);assert.equal(job.omitted,0);assert.equal(job.pages,4);assert.equal(media.flat().length,205);assert.equal(starts.length,4);assert.equal(store.listTargets().length,0);assert(store.getPost(rows[100]!.id));assert(visits[1]!.includes('00%3A01%3A38.999Z'));
  for(const visit of visits)assert.deepEqual([...new URL(visit).searchParams.keys()].sort(),['after','before','limit','sort','subreddit']);
  assert(gaps.includes(4500)&&gaps.includes(5500));
 }finally{await fetcher.close();store.close();}
});

test('Stop keeps the unprocessed media checkpoint; restart is idle and explicit Resume finishes without refetching committed posts',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-archive-resume-')),path=join(directory,'reader.sqlite');let store=new ReaderStore(path),calls=0,mediaStarted!:()=>void;const began=new Promise<void>(resolve=>{mediaStarted=resolve;});
 let fetcher=new ArchiveFetcher(store,{queue:new RequestQueue({intervalMs:0}),fetch:async()=>{calls++;return json([row(0)]);},saveMedia:async(_ids,signal)=>{mediaStarted();await delay(1_000_000,undefined,{signal});}});
 try{
  const id=fetcher.start(input);await began;await fetcher.stop();assert.equal(store.archiveFetch(id)?.phase,'media');assert.equal(store.stats().posts,1);assert.equal(calls,1);store.saveArchiveFetch({...store.archiveFetch(id)!,state:'running'});store.close();
  store=new ReaderStore(path);const saved:string[][]=[];fetcher=new ArchiveFetcher(store,{queue:new RequestQueue({intervalMs:0}),fetch:async()=>{calls++;return json([]);},saveMedia:async ids=>{saved.push(ids);}});
  assert.equal(fetcher.running,false);assert.equal(calls,1);assert.match(store.archiveFetch(id)?.reason??'',/restarted/);fetcher.resume(id);await settled(fetcher);assert.equal(store.archiveFetch(id)?.state,'done');assert.equal(calls,2);assert.equal(store.stats().posts,1);assert.deepEqual(saved[0],[`t3_${row(0).id}`]);assert.equal(store.archiveFetch(id)?.observed,1);
 }finally{await fetcher.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('a response arriving after Stop or scoped Clear cannot add content or resurrect a cleared archive job',async()=>{
 const store=new ReaderStore(':memory:');let release!:(response:Response)=>void,started!:()=>void;let began=new Promise<void>(resolve=>{started=resolve;});
 const fetcher=new ArchiveFetcher(store,{queue:new RequestQueue({intervalMs:0}),fetch:async()=>{started();return new Promise(resolve=>{release=resolve;});},saveMedia:async()=>{}});
 try{
  const id=fetcher.start(input);await began;fetcher.pause();release(json([row(0)]));await settled(fetcher);assert.equal(store.stats().posts,0);assert.equal(store.archiveFetch(id)?.cursorMs,start);
  began=new Promise<void>(resolve=>{started=resolve;});fetcher.resume(id);await began;store.clearSubreddit('python');release(json([row(0)]));await settled(fetcher);assert.equal(store.stats().posts,0);assert.equal(store.archiveFetch(id),null);
 }finally{await fetcher.close();store.close();}
});

test('429 pauses once, persists the service-wide reset and blocks Resume or a different job without retrying',async()=>{
 const store=new ReaderStore(':memory:');let calls=0;const now=Date.now();
 const fetcher=new ArchiveFetcher(store,{queue:new RequestQueue({intervalMs:0}),fetch:async()=>{calls++;return new Response('',{status:429,headers:{'X-RateLimit-Reset':'90','X-RateLimit-Reset-At':String(now+120_000),'Retry-After':'100'}});},saveMedia:async()=>{}});
 try{const id=fetcher.start(input);await settled(fetcher);const job=store.archiveFetch(id)!;assert.equal(job.state,'paused');assert.match(job.reason!,/429/);assert(job.notBefore!>=now+120_000);assert.throws(()=>fetcher.resume(id),/cooldown/);assert.throws(()=>fetcher.start({...input,subreddit:'aww'}),/cooldown/);assert.equal(calls,1);}finally{await fetcher.close();store.close();}
});

test('capacity rolls back the whole page with its cursor and Resume works after increasing storage',async()=>{
 const store=new ReaderStore(':memory:');store.setStorageLimit(1_000_000);let calls=0;
 const fetcher=new ArchiveFetcher(store,{queue:new RequestQueue({intervalMs:0}),fetch:async url=>{calls++;return json(Date.parse(new URL(String(url)).searchParams.get('after')!)<start?[row(0,{selftext:'x'.repeat(600_000)}),row(1,{selftext:'y'.repeat(600_000)})]:[]);},saveMedia:async()=>{}});
 try{const id=fetcher.start(input);await settled(fetcher);assert.equal(store.stats().posts,0);assert.equal(store.archiveFetch(id)?.cursorMs,start);assert.match(store.archiveFetch(id)?.reason??'',/Storage cap/);store.setStorageLimit(10_000_000);fetcher.resume(id);await settled(fetcher);assert.equal(store.archiveFetch(id)?.state,'done');assert.equal(store.stats().posts,2);assert.equal(calls,3);}finally{await fetcher.close();store.close();}
});

test('excluded and malformed records are disclosed, skipped-only pages advance, and archives cannot replace live content',async()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');store.importArchiveBatch(store.generation,[{id:row(0).id,subreddit:'python',title:'Delete',permalink:`/r/python/comments/${row(0).id}/`,created:{epochMs:start,precisionMs:1000},source:'archive',exportId:'first',observedAt:1,media:['Text']}]);store.deletePost(row(0).id);
 const target=store.createTarget({subreddit:'python',upperMs:Date.now()});store.commitBatch({generation:store.generation,targetId:target,continuation:null,observations:[{id:row(1).id,subreddit:'python',title:'Live title',body:'Live body',permalink:`/r/python/comments/${row(1).id}/`,created:{epochMs:start+1000,precisionMs:1000},source:'live',observedAt:Date.now(),media:['Text']}]});let calls=0;
 const fetcher=new ArchiveFetcher(store,{queue:new RequestQueue({intervalMs:0}),fetch:async()=>json(calls++===0?[row(0),row(1),row(2,{title:null})]:[]),saveMedia:async()=>{}});
 try{const id=fetcher.start(input);await settled(fetcher);const job=store.archiveFetch(id)!;assert.equal(job.state,'done');assert.equal(job.observed,3);assert.equal(job.excluded,1);assert.equal(job.omitted,1);assert.equal(job.added,0);assert.equal(store.getPost(row(0).id),null);assert.equal(store.getPost(row(1).id)?.body,'Live body');assert.equal(store.getPost(row(1).id)?.source,'live');}finally{await fetcher.close();store.close();}
});

test('a saturated single timestamp is preserved and reported instead of silently skipping posts or claiming completion',async()=>{
 const store=new ReaderStore(':memory:');let calls=0;const rows=Array.from({length:101},(_,i)=>row(i,{created_utc:start/1000}));
 const fetcher=new ArchiveFetcher(store,{queue:new RequestQueue({intervalMs:0}),fetch:async url=>{calls++;return json(rows.slice(0,new URL(String(url)).searchParams.get('limit')==='auto'?101:100));},saveMedia:async()=>{}});
 try{const id=fetcher.start(input);await settled(fetcher);const job=store.archiveFetch(id)!;assert.equal(job.state,'paused');assert.equal(job.dataComplete,false);assert.equal(job.cursorMs,start);assert.equal(job.observed,101);assert.equal(store.stats().posts,101);assert.match(job.reason!,/timestamp/);assert.equal(calls,2);}finally{await fetcher.close();store.close();}
});

test('invalid source ordering, mismatched communities, redirects and unsupported responses never advance a checkpoint',async()=>{
 for(const response of [json([row(1),row(0)]),json([row(0,{subreddit:'aww'})]),new Response('',{status:302,headers:{Location:'https://example.com'}}),new Response('<html>challenge</html>',{headers:{'Content-Type':'text/html'}}),new Response('{"data":null}',{headers:{'Content-Type':'application/json'}})]){
  const store=new ReaderStore(':memory:');let calls=0;const fetcher=new ArchiveFetcher(store,{queue:new RequestQueue({intervalMs:0}),fetch:async()=>{calls++;return response;},saveMedia:async()=>{}});
  try{const id=fetcher.start(input);await settled(fetcher);assert.equal(store.archiveFetch(id)?.state,'paused');assert.equal(store.archiveFetch(id)?.cursorMs,start);assert.equal(store.stats().posts,0);assert.equal(calls,1);}finally{await fetcher.close();store.close();}
 }
});


test('a reset-at timestamp expressed in seconds is honored even without other cooldown headers',async()=>{
 const store=new ReaderStore(':memory:'),reset=Math.ceil(Date.now()/1000)+120;
 const fetcher=new ArchiveFetcher(store,{queue:new RequestQueue({intervalMs:0}),fetch:async()=>new Response('',{status:429,headers:{'X-RateLimit-Reset-At':String(reset)}}),saveMedia:async()=>{}});
 try{const id=fetcher.start(input);await settled(fetcher);assert.equal(store.archiveFetch(id)?.notBefore,reset*1000);assert.throws(()=>fetcher.resume(id),/cooldown/);}finally{await fetcher.close();store.close();}
});
