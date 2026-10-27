import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReaderStore} from '../src/store.ts';
import {MediaCache} from '../src/media.ts';
import {mediaReference,mediaReferences} from '../src/media-reference.ts';
import {RequestQueue} from '../src/request-gate.ts';
import type {PostObservation} from '../src/domain.ts';
import {SyncLimitError,UnsupportedMediaError} from '../src/sync-errors.ts';

const image='https://i.redd.it/fixture.jpeg';
const record=(id='abc',url=image):PostObservation=>({id,subreddit:'aww',title:'Media fixture',permalink:`/r/aww/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'media-fixture',observedAt:1800000000000,media:['Image'],attachments:mediaReferences([url])});
const settled=async(cache:MediaCache)=>{const deadline=Date.now()+3000;while(cache.status.pending){if(Date.now()>deadline)throw new Error('Media queue did not finish');await new Promise(resolve=>setTimeout(resolve,5));}};

test('media references admit only bounded direct CDN files and reject API, active content and proxy destinations',()=>{
 assert.equal(mediaReference('https://v.redd.it/abc/DASH_720.mp4')?.kind,'video');
 for(const url of ['http://i.redd.it/photo.jpg','https://i.redd.it:8443/photo.jpg','https://user@i.redd.it/photo.jpg','https://i.redd.it.evil.com/photo.jpg','https://127.0.0.1/photo.jpg','https://i.redd.it/active.svg','https://www.reddit.com/r/aww.json','https://v.redd.it/abc','https://i.redd.it/photo.jpg#fragment'])assert.equal(mediaReference(url),null,url);
 assert.equal(mediaReferences([image,image]).length,1);
});

test('browser requests and media downloads share completion-based pacing; cached files survive restart without another request',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-media-test-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[record(),record('def')]);
 let now=0,calls=0;const starts:number[]=[];const queue=new RequestQueue({fromCompletion:true,random:()=>0.5,clock:{now:()=>now,sleep:async ms=>{now+=ms;}}});
 const cache=new MediaCache(store,{directory,queue,onAccess:()=>assert.fail('No access pause expected'),fetch:async()=>{calls++;starts.push(now);return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/jpeg'}});}});
 try{
  await queue.run(async()=>{starts.push(now);now+=2000;});await cache.enqueue('t3_abc');await cache.enqueue('t3_def');await settled(cache);await queue.run(async()=>{starts.push(now);});
  assert.equal(calls,1);assert(starts[1]!>=7000);assert(starts[2]!>=starts[1]!+5000);assert.equal(cache.status.bytes,3);assert.equal((await cache.items('t3_abc'))[0]?.state,'ready');
  await cache.close();const reopened=new MediaCache(store,{directory,queue,onAccess:()=>{},fetch:async()=>assert.fail('Cache should not download again')});await reopened.enqueue('t3_abc');assert.equal((await reopened.items('t3_abc'))[0]?.state,'ready');assert.equal(reopened.status.requests,0);await reopened.close();
 }finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('media redirects and wrong content types fail once, and explicit retry is required',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-media-test-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[record()]);let calls=0;
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>{calls++;return calls===1?new Response('',{status:302,headers:{Location:'http://127.0.0.1/private'}}):new Response('<html>wrong</html>',{headers:{'Content-Type':'text/html'}});}});
 try{await cache.enqueue('t3_abc');await settled(cache);assert.equal(calls,1);await cache.enqueue('t3_abc');await settled(cache);assert.equal(calls,1);assert.equal((await cache.items('t3_abc'))[0]?.state,'error');await cache.enqueue('t3_abc',true);await settled(cache);assert.equal(calls,2);assert.equal(cache.status.bytes,0);}finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('a safe observed CDN redirect uses a fresh randomized gap and is saved locally',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-safe-redirect-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[record()]);const starts:number[]=[];let now=0;
 const samples=[0.25,0.75,0.5],queue=new RequestQueue({fromCompletion:true,random:()=>samples.shift()!,clock:{now:()=>now,sleep:async ms=>{now+=ms;}}});
 const cache=new MediaCache(store,{directory,queue,onAccess:()=>{},fetch:async()=>{starts.push(now);now+=100;return starts.length===1?new Response('',{status:302,headers:{Location:'https://i.redd.it/current.jpg'}}):new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/jpeg'}});}});
 try{await cache.syncPost('abc','redirect',3,new AbortController().signal);await queue.run(async()=>starts.push(now));assert.deepEqual(starts,[0,4600,10200]);assert.equal(samples.length,0);assert.equal(store.mediaSync('abc')?.status,'ready');assert.equal((await cache.items('abc'))[0]?.state,'ready');}
 finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('a post with more than forty files drains every bounded queue batch during the same sync',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-many-files-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[{...record(),attachments:mediaReferences(Array.from({length:65},(_,i)=>`https://i.redd.it/many${i}.png`))}]);let requests=0;
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>{requests++;return new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}});}});
 try{await cache.syncPost('abc','many-files',80,new AbortController().signal);assert.equal(requests,65);assert.equal((await cache.items('abc')).filter(item=>item.state==='ready').length,65);assert.equal(store.mediaSync('abc')?.status,'ready');}
 finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

for(const failure of [404,503])test(`a ${failure} file cannot strand later queue batches or retry itself within the same sync`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-batch-failure-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[{...record(),attachments:mediaReferences(Array.from({length:65},(_,i)=>`https://i.redd.it/file${i}.png`))}]);const requests:string[]=[];
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async url=>{requests.push(String(url));return String(url).endsWith('/file0.png')?new Response('',{status:failure}):new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}});}});
 try{await assert.rejects(cache.syncPost('abc','mixed-batches',80,new AbortController().signal),error=>error instanceof Error&&(failure===404?error instanceof UnsupportedMediaError:!(error instanceof UnsupportedMediaError)));assert.equal(requests.length,65);assert.equal(requests.filter(url=>url.endsWith('/file0.png')).length,1);assert.equal((await cache.items('abc')).filter(item=>item.state==='ready').length,64);}
 finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('streamed media above the former per-file limit is saved within the configured storage cap',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-large-image-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[record()]);
 const chunk=new Uint8Array(1024*1024),total=33*chunk.length;let count=0;
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>new Response(new ReadableStream({pull(controller){if(count++<33)controller.enqueue(chunk);else controller.close();}}),{headers:{'Content-Type':'image/jpeg','Content-Length':String(total)}})});
 try{await cache.syncPost('abc','large-file',1,new AbortController().signal);assert.equal(cache.status.bytes,total);assert.equal(store.mediaSync('abc')?.status,'ready');}
 finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('a media 429 pauses all collection and cancels queued files without automatic retries',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-media-test-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[record(),record('def','https://i.redd.it/other.jpg')]);let calls=0;let reason='';
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:error=>{reason=error.message;store.setSetting('accessPause',{reason,notBefore:error.notBefore});cache.stop();},fetch:async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'120'}});}});
 try{await Promise.all([cache.enqueue('t3_abc'),cache.enqueue('t3_def')]);await settled(cache);assert.equal(calls,1);assert.match(reason,/429/);assert(store.getSetting<{notBefore:number}>('accessPause')!.notBefore>Date.now());assert.equal(cache.status.bytes,0);}finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('clear aborts in-flight media and a known live removal blocks archived attachments',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-media-test-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[record()]);
 let finish:((response:Response)=>void)|undefined;
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>new Promise<Response>(resolve=>{finish=resolve;})});
 try{
  await cache.enqueue('t3_abc');while(!finish)await new Promise(resolve=>setTimeout(resolve,1));store.clearContent();const cleared=cache.clear();finish(new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/jpeg'}}));await cleared;assert.equal(cache.status.bytes,0);assert.deepEqual(await cache.items('t3_abc'),[]);
  store.importArchiveBatch(store.generation,[record()]);store.saveSnapshot(store.generation,{id:'deleted-fixture',postId:'t3_abc',source:'live',capturedAt:Date.now(),observedAt:1900000000000,sort:'best',body:null,availability:'removed',comments:[],omitted:0,sample:'fixture'});store.importArchiveBatch(store.generation,[{...record(),observedAt:2000000000000}]);assert.deepEqual(store.getPost('abc')?.attachments,[]);assert.deepEqual(await cache.items('t3_abc'),[]);await assert.rejects(cache.enqueue('t3_abc'),/unavailable/);
 }finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('removed posts release media ownership and disk space while another current owner keeps shared files',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-removed-media-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[record(),record('def')]);
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/jpeg'}})});
 try{
  await cache.syncPost('abc','first',10,new AbortController().signal);await cache.syncPost('def','second',10,new AbortController().signal);
  store.markPostUnavailable(store.generation,'abc','removed',1900000000000);
  assert.equal(store.ownedMediaKeys('aww').length,1);await cache.reconcile();assert.equal(cache.status.bytes,3);assert.equal((await cache.items('def'))[0]?.state,'ready');
  store.markPostUnavailable(store.generation,'def','deleted',1900000000000);
  assert.deepEqual(store.ownedMediaKeys('aww'),[]);await cache.reconcile();assert.equal(cache.status.bytes,0);assert.deepEqual(await readdir(directory),[]);
 }finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('startup removes orphaned files left by an interrupted post deletion without making requests',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-orphan-media-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[record()]);
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/jpeg'}})});
 try{
  await cache.syncPost('abc','first',10,new AbortController().signal);await cache.close();store.deletePost('abc');
  const reopened=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>assert.fail('Startup must stay offline')});
  try{await reopened.initialize();assert.equal(reopened.status.bytes,0);assert.deepEqual(await readdir(directory),[]);}finally{await reopened.close();}
 }finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('startup requeues former implementation-limit failures while retaining genuine missing-file gaps without making requests',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-retry-old-limits-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[record(),record('def')]);store.setMediaSync(store.generation,'abc','unavailable','Media exceeds the per-file download limit.');store.setMediaSync(store.generation,'def','unavailable','Media unavailable (HTTP 404); no automatic retry.');
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>assert.fail('Startup cannot make website requests')});
 try{await cache.initialize();assert.equal(store.mediaSync('abc')?.status,'pending');assert.equal(store.mediaSync('def')?.status,'unavailable');assert.equal(cache.status.requests,0);}
 finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('DASH selects the main supported video and explicit audio, rejects hostile XML and does not invent segment URLs',async()=>{
 const {dashMedia}=await import('../src/dash.ts');const {readFile}=await import('node:fs/promises');const xml=await readFile(new URL('./fixtures/media.mpd',import.meta.url),'utf8'),url='https://v.redd.it/fixture/DASHPlaylist.mpd';
 assert.deepEqual(dashMedia(xml,url),{kind:'video',url:'https://v.redd.it/fixture/DASH_720.mp4',audioUrl:'https://v.redd.it/fixture/audio.mp4'});
 for(const invalid of ['<!DOCTYPE MPD [<!ENTITY x SYSTEM "file:///etc/passwd">]><MPD>&x;</MPD>','<MPD><Period>','<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation><SegmentTemplate media="guess-$Number$.mp4"/></Representation></AdaptationSet></Period></MPD>',xml.replaceAll('DASH_720.mp4','https://127.0.0.1/file.mp4').replaceAll('CMAF_96.mp4','https://evil.example/file.mp4').replaceAll('DASH_1080.mp4','https://evil.example/file.mp4')])assert.throws(()=>dashMedia(invalid,url));
});

test('invalid video tracks are an unavailable format rather than an endlessly retryable mux failure',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-invalid-tracks-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');
 store.importArchiveBatch(store.generation,[{...record(),media:['Video'],attachments:[{kind:'video',url:'https://v.redd.it/fixture/video.mp4',audioUrl:'https://v.redd.it/fixture/audio.mp4'}]}]);
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'video/mp4'}})});
 try{await assert.rejects(cache.syncPost('abc','invalid-tracks',10,new AbortController().signal),UnsupportedMediaError);assert.equal(cache.status.bytes,0);assert.deepEqual(await readdir(directory),[]);}
 finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

for(const failure of ['network','capacity','temporary'] as const)test(`a dead attachment cannot hide a ${failure} failure on another file`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-mixed-media-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');
 store.importArchiveBatch(store.generation,[{...record(),attachments:mediaReferences(['https://i.redd.it/gone.png','https://i.redd.it/retry.png'])}]);
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),maxBytes:failure==='capacity'?0:undefined,onAccess:()=>{},fetch:async url=>{
  if(String(url).includes('gone'))return new Response('',{status:404});
  if(failure==='network')throw new TypeError('fetch failed');
  return failure==='temporary'?new Response('',{status:503}):new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}});
 }});
 try{await assert.rejects(cache.syncPost('abc','mixed',10,new AbortController().signal),error=>failure==='temporary'?error instanceof Error&&!(error instanceof UnsupportedMediaError):error instanceof SyncLimitError);}
 finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});
