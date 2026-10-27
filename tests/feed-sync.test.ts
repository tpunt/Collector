import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ReaderStore} from '../src/store.ts';
import {ReaderJobs,type JobDependencies} from '../src/jobs.ts';
import {MediaCache} from '../src/media.ts';
import {RequestQueue} from '../src/request-gate.ts';
import {historyLowerBound} from '../src/history-window.ts';
import {UnsupportedMediaError} from '../src/sync-errors.ts';
import type {PostObservation} from '../src/domain.ts';
import {advanceBoundary} from '../src/history.ts';
import type {Listing} from '../src/extract.ts';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS9sAAAAASUVORK5CYII=','base64');
async function until(condition:()=>boolean){const end=Date.now()+4000;while(!condition()){if(Date.now()>end)throw new Error('Feed sync fixture did not settle');await new Promise(resolve=>setTimeout(resolve,2));}}
async function setup(options:{images?:number;end?:boolean;unsupported?:boolean;fetch?:typeof fetch;discover?:JobDependencies['discoverMedia'];beforeListing?:()=>Promise<void>;ageDays?:number}={}){
 const directory=await mkdtemp(join(tmpdir(),'reader-unified-sync-')),path=join(directory,'reader.sqlite');
 const store=new ReaderStore(path),now=Date.now(),old=now-(options.ageDays??45)*86400000;
 store.addSource({name:'aww',historyMonths:1,lowerMs:historyLowerBound(1,now)!},now);
 const visits:string[]=[],downloads:string[]=[];let variant='first',jobs!:ReaderJobs;
 const records=():PostObservation[]=>Array.from({length:options.images??1},(_,i)=>({id:'t3_m'+i,subreddit:'aww',title:'Offline image '+i,
  permalink:`/r/aww/comments/m${i}/`,created:{epochMs:old-i,precisionMs:1000},source:'live',observedAt:Date.now(),media:['Image'],
  attachments:options.unsupported?[]:[{kind:'image',url:`https://i.redd.it/${variant}${i}.png`}]}));
 const cache=new MediaCache(store,{directory:join(directory,'media'),queue:new RequestQueue({intervalMs:0}),onAccess:error=>jobs.accessFailure(error),
  fetch:async(input,init)=>{downloads.push(String(input));return options.fetch?options.fetch(input,init):new Response(png,{headers:{'Content-Type':'image/png'}});}});
 await cache.initialize();
 let opened=false;const counts={released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000};
 jobs=new ReaderJobs(store,{mediaSync:cache,readAccount:async()=> 'fixture_user',browser:{counts,async open(){if(!opened){counts.released=0;opened=true;}},async close(){opened=false;},async manualSignIn(){},async navigate(url){visits.push(url);counts.released++;return{url:()=>url}as any;}},
  discoverMedia:options.discover??(async()=>{throw new UnsupportedMediaError('Unsupported fixture provider');}),readListing:async page=>{
   await options.beforeListing?.();
   const second=page.url().includes('?'),prefix=second?'b':'a';
   const text:PostObservation[]=Array.from({length:5},(_,i)=>({id:`t3_${prefix}${i}`,subreddit:'aww',title:'History proof',permalink:`/r/aww/comments/${prefix}${i}/`,
    created:{epochMs:old-i,precisionMs:1000},source:'live',observedAt:Date.now(),media:['Text']}));
   return{account:'fixture_user',posts:[...records(),...text],ordinary:text.map(p=>({id:p.id,createdMs:p.created.epochMs,precisionMs:1000})),unknownTime:false,omissions:0,
    next:options.end?null:`https://old.reddit.com/r/aww/new/?after=t3_${second?'b4':'a4'}`,empty:false,signature:prefix};
  }});
 return{directory,path,store,jobs,cache,visits,downloads,setVariant(value:string){variant=value;},async settle(){await until(()=>!jobs.state.running);},async close(){await jobs.close();await cache.close();store.close();await rm(directory,{recursive:true,force:true});}};
}

test('offline success waits for every page and validated local media, not the first saved listing',async()=>{
 let release!:()=>void,started=false;const blocked=new Promise<void>(resolve=>{release=resolve;});
 const h=await setup({fetch:async()=>{started=true;await blocked;return new Response(png,{headers:{'Content-Type':'image/png'}});}});
 try{
  h.jobs.syncFeeds(['aww']);await until(()=>started);
  assert(h.store.stats().posts>0);assert.equal(h.store.feedSync('aww').state,'running');assert.equal(h.store.feedSync('aww').lastSuccessAt,null);
  release();await h.settle();assert.equal(h.store.feedSync('aww').state,'complete');assert(h.store.feedSync('aww').lastSuccessAt);
  assert.equal(h.visits.length,2);assert.equal(h.downloads.length,1);assert.equal(h.store.offlineMedia('aww').ready,1);
  assert((await stat((await h.cache.items('m0'))[0]!.localPath!)).size>0);
 }finally{release();await h.close();}
});

test('Stop and Resume preserve saved files and checkpoints while checking for newer posts',async()=>{
 let block=true,started=false;const h=await setup({images:2,fetch:async(input,init)=>{
  if(block&&String(input).endsWith('1.png')){started=true;return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('Stopped fixture')),{once:true}));}
  return new Response(png,{headers:{'Content-Type':'image/png'}});
 }});
 try{
  h.jobs.syncFeeds(['aww']);await until(()=>started);const checkpoint=h.store.feedSources()[0]!.historyTarget!.continuation;
  await h.jobs.stopSource('aww');await h.settle();assert.equal(h.store.feedSync('aww').state,'incomplete');assert.equal(h.store.feedSync('aww').lastSuccessAt,null);
  assert.equal(h.store.offlineMedia('aww').ready,1);assert.equal(h.store.feedSources()[0]!.historyTarget!.continuation,checkpoint);
  block=false;h.jobs.syncFeeds(['aww']);await h.settle();assert.equal(h.store.feedSync('aww').state,'complete');
  assert.equal(h.downloads.filter(url=>url.endsWith('first0.png')).length,1,'A saved file is not downloaded again');
  assert.equal(h.downloads.filter(url=>url.endsWith('first1.png')).length,2);assert(h.visits.filter(url=>!url.includes('?')).length>=2,'Resume checks the latest listing too');
 }finally{await h.close();}
});

test('an unavailable embed cannot conceal stopped history; restart and resync fetch the saved missing page',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-resumable-history-')),path=join(directory,'reader.sqlite');
 let store=new ReaderStore(path),jobs:ReaderJobs|undefined;
 try{
  const now=Date.now(),old=now-45*86400000,goal=store.addSource({name:'aww',historyMonths:1},now);
  const post=(id:string):PostObservation=>({id,subreddit:'aww',title:'Saved '+id,permalink:`/r/aww/comments/${id}/`,created:{epochMs:old,precisionMs:1000},source:'live',observedAt:now,media:['Text'],body:'Saved body'});
  const posts=Array.from({length:5},(_,i)=>post('a'+i)),checkpoint='https://old.reddit.com/r/aww/new/?after=t3_a4';
  const first:Listing={account:'fixture_user',posts,ordinary:posts.map(p=>({id:'t3_'+p.id,createdMs:old,precisionMs:1000})),unknownTime:false,omissions:0,next:checkpoint,empty:false,signature:'first-page'};
  const boundary=advanceBoundary(store.getTarget(goal)!,first);assert.equal(boundary.done,false);
  store.beginFeedSync('aww',[goal]);store.commitBatch({generation:store.generation,targetId:goal,observations:posts,continuation:checkpoint,boundary:boundary.boundary,batchKey:first.signature,fromHead:true});
  store.importArchiveBatch(store.generation,[{...post('embed'),source:'archive',exportId:'embed-fixture',media:['Video'],outbound:'https://www.youtube.com/watch?v=fixture'}]);
  store.setMediaSync(store.generation,'embed','unavailable','Offline download is not supported for this embedded provider');
  store.pauseSource('aww','Stopped by user');assert.equal(store.feedSync('aww').state,'incomplete');assert.equal(store.getPost('missing'),null);
  store.close();store=new ReaderStore(path);assert.equal(store.feedSync('aww').state,'incomplete');assert.equal(store.getTarget(goal)?.continuation,checkpoint);
  const visits:string[]=[];
  jobs=new ReaderJobs(store,{mediaSync:null,browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(url){visits.push(url);return{url:()=>url}as any;}},readListing:async page=>page.url()===checkpoint?{...first,posts:[post('missing')],ordinary:[{id:'t3_missing',createdMs:old,precisionMs:1000}],signature:'missing-page',next:'https://old.reddit.com/r/aww/new/?after=t3_missing'}:{...first,posts:[],ordinary:[],empty:true,next:null,signature:'fresh-head'}});
  assert.equal(jobs.state.running,false);assert.equal(visits.length,0);jobs.syncFeeds(['aww']);await until(()=>!jobs!.state.running);
  assert(visits.includes(checkpoint));assert(visits.some(url=>!new URL(url).search));assert(store.getPost('missing'));assert.equal(store.getTarget(goal)?.status,'done');
  assert.equal(store.mediaSync('embed')?.status,'unavailable');assert.equal(store.feedSync('aww').state,'gaps');assert.equal(store.offlineMedia('aww').pending,0);assert.equal(store.offlineMedia('aww').failed,0);
 }finally{await jobs?.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('a failed download leaves sync incomplete and retains the previous successful timestamp until explicit retry',async()=>{
 let fail=false;const h=await setup({fetch:async()=>fail?new Response('',{status:503}):new Response(png,{headers:{'Content-Type':'image/png'}})});
 try{
  h.jobs.syncFeeds(['aww']);await h.settle();const success=h.store.feedSync('aww').lastSuccessAt;assert(success);
  h.setVariant('changed');fail=true;h.jobs.syncFeeds(['aww']);await h.settle();
  assert.equal(h.store.feedSync('aww').state,'incomplete');assert.equal(h.store.feedSync('aww').lastSuccessAt,success);assert.equal(h.store.offlineMedia('aww').failed,1);
  const attempts=h.downloads.length;await new Promise(resolve=>setTimeout(resolve,20));assert.equal(h.downloads.length,attempts);
  fail=false;h.jobs.syncFeeds(['aww']);await h.settle();assert.equal(h.store.feedSync('aww').state,'complete');assert(h.store.feedSync('aww').lastSuccessAt!>=success);
 }finally{await h.close();}
});

test('listing exhaustion is completed with gaps rather than proof of full requested history',async()=>{
 const h=await setup({end:true});try{h.jobs.syncFeeds(['aww']);await h.settle();const sync=h.store.feedSync('aww');
  assert.equal(sync.state,'gaps');assert.equal(sync.lastSuccessAt,null);assert(sync.lastCompletedAt);assert.match(sync.reason??'',/historical coverage/);assert.equal(h.store.offlineMedia('aww').ready,1);
 }finally{await h.close();}
});

test('unsupported media is an explained completion gap, never a successful offline save',async()=>{
 const h=await setup({unsupported:true});try{h.jobs.syncFeeds(['aww']);await h.settle();const sync=h.store.feedSync('aww');
  assert.equal(sync.state,'gaps');assert.equal(sync.lastSuccessAt,null);assert.match(sync.reason??'',/unavailable/);assert.equal(h.store.offlineMedia('aww').unavailable,1);assert.equal(h.downloads.length,0);
 }finally{await h.close();}
});

test('inconclusive media discovery stays incomplete and retries only on the next explicit sync',async()=>{
 let discoveries=0;const h=await setup({unsupported:true,discover:async()=>{
  discoveries++;
  if(discoveries===1)return [];
  if(discoveries===2)throw new Error('The video player did not expose a download before the timeout; sync this feed again to retry');
  return [{kind:'image',url:'https://i.redd.it/discovered.png'}];
 }});
 try{
  for(let attempt=1;attempt<=2;attempt++){
   h.jobs.syncFeeds(['aww']);await h.settle();
   assert.equal(discoveries,attempt);assert.equal(h.store.feedSync('aww').state,'incomplete');assert.equal(h.store.feedSync('aww').lastSuccessAt,null);
   assert.equal(h.store.offlineMedia('aww').failed,1);assert.equal(h.store.offlineMedia('aww').unavailable,0);assert.equal(h.downloads.length,0);assert.equal(h.jobs.state.accessPause,null);
  }
  h.jobs.syncFeeds(['aww']);await h.settle();assert.equal(discoveries,3);assert.equal(h.downloads.length,1);assert.equal(h.store.feedSync('aww').state,'complete');assert.equal(h.store.offlineMedia('aww').ready,1);
 }finally{await h.close();}
});

test('unified Sync still shares the 120 request budget and Resume only downloads unfinished files',async()=>{
 const h=await setup({images:121});try{
  h.jobs.syncFeeds(['aww']);await h.settle();assert.equal(h.downloads.length,119);assert.equal(h.visits.length,1);
  assert.equal(h.store.feedSync('aww').state,'incomplete');assert.equal(h.store.feedSync('aww').lastSuccessAt,null);assert.match(h.jobs.state.accessPause?.reason??'',/budget/);
  h.jobs.syncFeeds(['aww']);await h.settle();assert.equal(h.downloads.length,121);assert.equal(h.store.feedSync('aww').state,'complete');assert.equal(h.store.offlineMedia('aww').ready,121);
 }finally{await h.close();}
});

test('new pending media invalidates a saved-offline status without rewriting the last success',async()=>{
 const h=await setup();try{
  h.jobs.syncFeeds(['aww']);await h.settle();const success=h.store.feedSync('aww').lastSuccessAt;assert(success);
  h.store.setMediaSync(h.store.generation,'m0','pending','Cached file missing');
  assert.equal(h.store.feedSync('aww').state,'incomplete');assert.equal(h.store.feedSync('aww').lastSuccessAt,success);
 }finally{await h.close();}
});

test('listing-end evidence cannot turn into offline success by reducing the history limit',async()=>{
 const h=await setup({end:true});try{
  h.store.setHistoryLimit('aww',3);h.jobs.syncFeeds(['aww']);await h.settle();assert.equal(h.store.feedSync('aww').state,'gaps');
  h.store.setHistoryLimit('aww',1);assert.notEqual(h.store.feedSources()[0]!.historyTarget!.completion,'prior-scan');
  h.jobs.syncFeeds(['aww']);await h.settle();assert.equal(h.store.feedSync('aww').state,'gaps');assert.equal(h.store.feedSync('aww').lastSuccessAt,null);
 }finally{await h.close();}
});

test('expanding history while an aborted page is unwinding queues the replacement sync',async()=>{
 let entered=false,release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});
 const h=await setup({ageDays:120,beforeListing:async()=>{if(!entered){entered=true;await gate;}}});
 try{
  h.jobs.syncFeeds(['aww']);await until(()=>entered);await h.jobs.stopSource('aww','History limit expanded');
  const next=h.store.setHistoryLimit('aww',3);
  h.jobs.syncFeeds(['aww'],{heads:next.headTargetId?[next.headTargetId]:[],history:[next.targetId!]});
  assert(h.jobs.hasTarget(next.targetId!),'The stopped page must not cause the new explicit sync to be discarded');
  release();await h.settle();assert.equal(h.store.getTarget(next.targetId!)?.status,'done');assert.equal(h.store.feedSync('aww').state,'complete');
 }finally{release();await h.close();}
});

test('restarts never manufacture offline success; Clear rejects a late finish',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-sync-restart-')),path=join(directory,'reader.sqlite');let store=new ReaderStore(path);
 try{
  const now=Date.now(),target=store.addSource({name:'python',historyMonths:1,lowerMs:now-86400000},now);
  store.commitBatch({generation:store.generation,targetId:target,observations:[],continuation:null,fromHead:true,status:'done',completion:'date-boundary'});
  assert.equal(store.feedSync('python').lastSuccessAt,null);assert.equal(store.feedSync('python').state,'never');
  const run=store.beginFeedSync('python',[target],now);store.close();store=new ReaderStore(path);
  assert.equal(store.feedSync('python').state,'incomplete');assert.equal(store.feedSync('python').lastSuccessAt,null);store.finishFeedSync('python',run);assert.equal(store.feedSync('python').lastSuccessAt,null);
  const resumed=store.beginFeedSync('python',[target],now+1);store.finishFeedSync('python',resumed,now+2);assert.equal(store.feedSync('python').lastSuccessAt,now+2);
  store.clearSubreddit('python');store.finishFeedSync('python',resumed,now+3);assert.equal(store.feedSync('python').state,'never');assert.equal(store.feedSync('python').lastSuccessAt,null);
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});
