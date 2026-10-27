import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReaderStore} from '../src/store.ts';
import {ReaderJobs} from '../src/jobs.ts';
import {MediaCache} from '../src/media.ts';
import {RequestQueue} from '../src/request-gate.ts';
import {UnsupportedMediaError,PostUnavailableError,PostIdentityError} from '../src/sync-errors.ts';
import type {PostObservation} from '../src/domain.ts';

const png=new Uint8Array([1,2,3]);
const image=(n:number):PostObservation=>({id:'t3_'+n.toString(36),subreddit:'aww',title:'Offline image '+n,permalink:`/r/aww/comments/${n.toString(36)}/`,created:{epochMs:1700000000000+n*1000,precisionMs:1000},source:'live',observedAt:Date.now(),media:['Image'],attachments:[{kind:'image',url:`https://i.redd.it/offline${n}.png`}]});
// These fixtures persist over 100 files and indexed rows; allow for concurrent disk load.
async function settle(jobs:ReaderJobs){const deadline=Date.now()+30_000;while(jobs.state.running){if(Date.now()>deadline)throw new Error('Sync did not settle: '+jobs.state.message);await new Promise(resolve=>setTimeout(resolve,5));}}
async function setup(options:{directory?:string;records?:PostObservation[];fetch?:typeof fetch;discover?:any}={}){
 const directory=options.directory??await mkdtemp(join(tmpdir(),'reader-offline-')),store=new ReaderStore(join(directory,'reader.sqlite'));store.addSubreddit('aww');
 const network=new RequestQueue({intervalMs:0}),visits:string[]=[],requests:string[]=[];let open=false;
 const counts={released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000};
 const browser={counts,mediaCandidates:[],async open(){if(!open){counts.released=0;open=true;}},async close(){open=false;},async manualSignIn(){},async navigate(url:string){visits.push(url);counts.released++;return {url:()=>url}as any;}};
 let jobs:ReaderJobs;const cache=new MediaCache(store,{directory:join(directory,'media'),queue:network,onAccess:error=>jobs.accessFailure(error),fetch:async(input,init)=>{requests.push(String(input));return options.fetch?options.fetch(input,init):new Response(png,{headers:{'Content-Type':'image/png'}});}});
 await cache.initialize();jobs=new ReaderJobs(store,{browser,network,mediaSync:cache,readAccount:async()=> 'fixture_user',discoverMedia:options.discover??(async()=>{throw new UnsupportedMediaError('Unsupported fixture provider in this layout');}),readListing:async()=>({account:'fixture_user',posts:options.records??[],ordinary:[],unknownTime:false,omissions:0,next:null,empty:false,signature:'offline-fixture'})});
 const target=()=>store.createTarget({subreddit:'aww',upperMs:Date.now()});
 return {directory,store,jobs,cache,visits,requests,target,async close(){await jobs.close();await cache.close();store.close();}};
}

test('sync saves every media post without opening the feed, including more than one scan chunk and native discovery',async()=>{
 const video=await readFile(new URL('./fixtures/media.mp4',import.meta.url));
 const records=[...Array.from({length:61},(_,i)=>image(i+100)),{...image(500),media:['Video']as const,attachments:[]}as PostObservation];let discovered=0;
 const h=await setup({records,discover:async()=>{discovered++;assert.equal(h.requests.length,24,'Known files in this batch must save before browser discovery');return[{kind:'video',url:'https://v.redd.it/fixture/DASHPlaylist.mpd'}];},fetch:async url=>String(url).includes('.mpd')?new Response('<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation height="720"><BaseURL>main.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>',{headers:{'Content-Type':'application/dash+xml'}}):new Response(String(url).includes('main.mp4')?video:png,{headers:{'Content-Type':String(url).includes('main.mp4')?'video/mp4':'image/png'}})});
 try{const id=h.target();h.jobs.targets([id]);await settle(h.jobs);assert.equal(h.store.getTarget(id)?.status,'done');assert.equal(discovered,1);assert.equal(h.requests.length,63);assert.deepEqual(h.store.offlineMedia('aww'),{total:62,ready:62,pending:0,failed:0,unavailable:0});for(const record of records){const file=(await h.cache.items(record.id))[0]!;assert.equal(file.state,'ready');assert((await stat(file.localPath!)).isFile());}assert.equal(h.jobs.state.accessPause,null);}
 finally{await h.close();await rm(h.directory,{recursive:true,force:true});}
});

test('stopping media leaves a durable pending item, and restart resumes it even when post history is complete',async()=>{
 let started=false;const h=await setup({records:[image(100),image(101)],fetch:async(_url,init)=>{started=true;return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('Aborted fixture')),{once:true}));}});
 const directory=h.directory;let closed=false;
 try{const id=h.target();h.jobs.targets([id]);while(!started)await new Promise(resolve=>setTimeout(resolve,1));assert.equal(h.store.getTarget(id)?.status,'done');await h.jobs.stopSource('aww');await settle(h.jobs);assert.equal(h.store.offlineMedia('aww').pending,2);await h.close();closed=true;
  const restarted=await setup({directory});try{assert.equal(restarted.jobs.state.running,false);assert.equal(restarted.requests.length,0);restarted.jobs.syncMedia(['aww'],{resume:true});await settle(restarted.jobs);assert.equal(restarted.store.offlineMedia('aww').ready,2);assert.equal(restarted.requests.length,2);assert.equal(restarted.visits.length,0);}finally{await restarted.close();}
 }finally{if(!closed)await h.close();await rm(directory,{recursive:true,force:true});}
});

test('one failed or unsupported asset does not strand other media, and only the next explicit sync retries failures',async()=>{
 let fail=true;const h=await setup({records:[image(100),image(101),{...image(102),media:['Video'],attachments:[]}],fetch:async url=>fail&&String(url).includes('offline100')?new Response('',{status:503}):new Response(png,{headers:{'Content-Type':'image/png'}})});
 try{h.jobs.targets([h.target()]);await settle(h.jobs);assert.deepEqual(h.store.offlineMedia('aww'),{total:3,ready:1,pending:0,failed:1,unavailable:1});assert.equal(h.requests.length,2);assert.equal(h.jobs.state.accessPause,null);fail=false;h.jobs.syncMedia(['aww']);await settle(h.jobs);assert.equal(h.requests.length,3);assert.equal(h.store.offlineMedia('aww').ready,2);assert.equal(h.store.offlineMedia('aww').unavailable,1);}
 finally{await h.close();await rm(h.directory,{recursive:true,force:true});}
});

test('an explicitly removed post skips its media, preserves saved comments and lets the remaining sync finish',async()=>{
 const h=await setup({discover:async(_page:any,id:string)=>{
  if(id==='t3_2u')throw new PostUnavailableError('removed');
  return[{kind:'image',url:'https://i.redd.it/remaining.png'}];
 }});
 try{
  h.store.importArchiveBatch(h.store.generation,[image(102),image(101)].map(record=>({...record,source:'archive',exportId:'removed-media-fixture',body:'Old post body',attachments:[]})));
  h.store.saveSnapshot(h.store.generation,{id:'saved-comments',postId:'t3_2u',source:'archive',capturedAt:null,observedAt:Date.now()-1000,sort:'chronological',body:'Old post body',availability:'available',comments:[{id:'t1_comment',postId:'t3_2u',parentId:'t3_2u',ancestry:'known',body:'Surviving comment',availability:'available',createdMs:1700000000000}],omitted:0,sample:'Fixture'});
  h.jobs.syncMedia(['aww']);await settle(h.jobs);
  const post=h.store.getPost('2u')!,snapshot=h.store.latestSnapshot('2u')!;
  assert.equal(post.availability,'removed');assert.equal(post.body,null);assert.deepEqual(post.attachments,[]);assert.equal(h.store.mediaSync('2u'),null);
  assert.equal(snapshot.id,'saved-comments');assert.equal(snapshot.body,null);assert.equal(snapshot.comments[0]?.body,'Surviving comment');
  assert.equal(h.store.offlineMedia('aww').ready,1);assert.equal(h.requests.length,1);assert.equal(h.visits.length,2);assert.equal(h.jobs.state.accessPause,null);
  h.store.importArchiveBatch(h.store.generation,[{...image(102),source:'archive',exportId:'older-copy',body:'Do not restore'}]);assert.equal(h.store.getPost('2u')?.body,null);
 }finally{await h.close();await rm(h.directory,{recursive:true,force:true});}
});

test('a later listing removal reclaims saved media during sync without a separate Clear or restart',async()=>{
 const records=[image(100)],h=await setup({records});try{
  h.jobs.targets([h.target()]);await settle(h.jobs);const path=(await h.cache.items(records[0]!.id))[0]!.localPath!;assert.equal(h.cache.status.bytes,3);
  records[0]={...records[0]!,availability:'removed',observedAt:Date.now()+1};
  h.jobs.targets([h.target()]);await settle(h.jobs);
  assert.equal(h.store.getPost(records[0]!.id)?.availability,'removed');assert.equal(h.cache.status.bytes,0);await assert.rejects(stat(path),{code:'ENOENT'});assert.equal(h.requests.length,1);
 }finally{await h.close();await rm(h.directory,{recursive:true,force:true});}
});

test('a genuine unidentified media page pauses the queue and keeps posts pending rather than guessing a removal',async()=>{
 const h=await setup({discover:async()=>{throw new PostIdentityError('t3_2u',['t3_other'],'https://old.reddit.com/r/aww/comments/other/?ignored=secret');}});
 try{
  h.store.importArchiveBatch(h.store.generation,[image(102),image(101)].map(record=>({...record,source:'archive',exportId:'identity-fixture',attachments:[]})));
  h.jobs.syncMedia(['aww']);await settle(h.jobs);
  assert.equal(h.requests.length,0);assert.equal(h.visits.length,1);assert.equal(h.store.getPost('2u')?.availability,'available');assert.equal(h.store.offlineMedia('aww').pending,2);
  assert.match(h.jobs.state.message,/t3_2u/);assert.match(h.jobs.state.message,/t3_other/);assert(!h.jobs.state.message.includes('secret'));
 }finally{await h.close();await rm(h.directory,{recursive:true,force:true});}
});

test('one sync budget covers listing and asset requests; Continue resumes media after the listing has finished',async()=>{
 const h=await setup({records:Array.from({length:121},(_,i)=>image(i+100))});
 try{h.jobs.targets([h.target()]);await settle(h.jobs);assert.equal(h.requests.length,119);assert.equal(h.store.offlineMedia('aww').pending,2);assert.match(h.jobs.state.accessPause?.reason??'',/budget/);h.jobs.syncMedia(['aww'],{resume:true});await settle(h.jobs);assert.equal(h.requests.length,121);assert.equal(h.visits.length,1);assert.equal(h.store.offlineMedia('aww').ready,121);assert.equal(h.jobs.state.accessPause,null);}
 finally{await h.close();await rm(h.directory,{recursive:true,force:true});}
});

test('clear during media sync aborts work and cannot publish late offline files or progress',async()=>{
 let started=false;const h=await setup({records:[image(100)],fetch:async(_url,init)=>{started=true;return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('Aborted fixture')),{once:true}));}});
 try{h.jobs.targets([h.target()]);while(!started)await new Promise(resolve=>setTimeout(resolve,1));h.jobs.pause('Content cleared');h.store.clearContent();await h.cache.clear();await settle(h.jobs);assert.equal(h.store.stats().posts,0);assert.equal(h.cache.status.bytes,0);assert.equal(h.store.offlineMedia('aww').total,0);}
 finally{await h.close();await rm(h.directory,{recursive:true,force:true});}
});

test('loss of connectivity pauses the sync after one failure instead of trying every remaining asset',async()=>{
 let offline=true;const h=await setup({records:[image(100),image(101),image(102)],fetch:async()=>{if(offline)throw new TypeError('fetch failed');return new Response(png,{headers:{'Content-Type':'image/png'}});}});
 try{h.jobs.targets([h.target()]);await settle(h.jobs);assert.equal(h.requests.length,1);assert.match(h.jobs.state.accessPause?.reason??'',/network/);assert.equal(h.store.offlineMedia('aww').pending,3);offline=false;h.jobs.syncMedia(['aww'],{resume:true});await settle(h.jobs);assert.equal(h.store.offlineMedia('aww').ready,3);}
 finally{await h.close();await rm(h.directory,{recursive:true,force:true});}
});

test('a single rendered gallery slide never counts as a complete offline gallery',async()=>{
 const h=await setup({records:[{...image(100),outbound:'https://www.reddit.com/gallery/2s'},image(101)],discover:async()=>{throw new Error('Gallery slide did not finish loading; Resume to retry');}});
 try{h.jobs.targets([h.target()]);await settle(h.jobs);assert.equal(h.requests.length,1);assert.equal(h.store.offlineMedia('aww').ready,1);assert.equal(h.store.offlineMedia('aww').failed,1);assert.equal(h.store.offlineMedia('aww').unavailable,0);assert.match(h.store.mediaSync('t3_2s')?.reason??'',/Gallery slide/);assert.equal(h.visits.length,2);}
 finally{await h.close();await rm(h.directory,{recursive:true,force:true});}
});

test('a formerly unsupported gallery resumes after Stop and restart without rediscovering or redownloading saved slides',async()=>{
 const record={...image(100),outbound:'https://www.reddit.com/gallery/2s'},references=[0,1].map(index=>({kind:'image' as const,url:`https://i.redd.it/slide${index}.png`,collection:{id:'reddit:t3_2s',index,total:2}}));
 let started=false;const h=await setup({discover:async()=>references,fetch:async(url,init)=>{
  if(String(url).includes('slide1')){started=true;return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('Stopped gallery fixture')),{once:true}));}
  return new Response(png,{headers:{'Content-Type':'image/png'}});
 }});const directory=h.directory;let closed=false;
 try{
  h.store.importArchiveBatch(h.store.generation,[{...record,source:'archive',exportId:'old-gallery'}]);h.store.setMediaSync(h.store.generation,record.id,'unavailable','Complete gallery downloads are not supported by the current Reddit layout');
  h.jobs.syncMedia(['aww']);while(!started)await new Promise(resolve=>setTimeout(resolve,2));assert.equal((await h.cache.items(record.id)).filter(item=>item.state==='ready').length,1);assert.equal(h.store.getPost(record.id)?.attachments.length,2);
  await h.jobs.stopSource('aww');await settle(h.jobs);await h.close();closed=true;
  const restarted=await setup({directory,discover:async()=>assert.fail('The complete saved gallery list must survive restart')});
  try{assert.equal(restarted.requests.length,0);restarted.jobs.syncMedia(['aww'],{resume:true});await settle(restarted.jobs);assert.equal(restarted.requests.length,1);assert(restarted.requests[0]?.includes('slide1'));assert.equal((await restarted.cache.items(record.id)).filter(item=>item.state==='ready').length,2);assert.equal(restarted.store.mediaSync(record.id)?.status,'ready');}
  finally{await restarted.close();}
 }finally{if(!closed)await h.close();await rm(directory,{recursive:true,force:true});}
});

test('a denied signed manifest pauses globally and explicit Continue rediscovers it, including after restart',async()=>{
 const record:PostObservation={...image(100),media:['Video'],attachments:[{kind:'video',url:'https://v.redd.it/fixture/DASHPlaylist.mpd?expired=1'}]};
 const h=await setup({records:[record],fetch:async()=>new Response('',{status:403})});const directory=h.directory;let closed=false;
 try{
  h.jobs.targets([h.target()]);await settle(h.jobs);assert.equal(h.requests.length,1);assert.match(h.jobs.state.accessPause?.reason??'',/403/);assert.equal(h.store.mediaSync(record.id)?.status,'failed');
  await new Promise(resolve=>setTimeout(resolve,20));assert.equal(h.requests.length,1,'No automatic retry');await h.close();closed=true;
  let discoveries=0;const video=await readFile(new URL('./fixtures/media.mp4',import.meta.url));
  const restarted=await setup({directory,discover:async()=>{discoveries++;return[{kind:'video',url:'https://v.redd.it/fixture/DASHPlaylist.mpd?fresh=1'}];},fetch:async url=>String(url).includes('.mpd')?new Response('<MPD><Period><AdaptationSet mimeType="video/mp4"><Representation height="360"><BaseURL>main.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>',{headers:{'Content-Type':'application/dash+xml'}}):new Response(video,{headers:{'Content-Type':'video/mp4'}})});
  try{
   assert.equal(restarted.requests.length,0);restarted.jobs.syncMedia(['aww'],{resume:true});await settle(restarted.jobs);
   assert.equal(discoveries,1);assert(restarted.requests[0]?.includes('fresh=1'));assert.equal(restarted.requests.length,2);assert.equal(restarted.store.mediaSync(record.id)?.status,'ready');assert.equal(restarted.jobs.state.accessPause,null);
  }finally{await restarted.close();}
 }finally{if(!closed)await h.close();await rm(directory,{recursive:true,force:true});}
});

test('a denied ordinary image is rediscovered only on explicit Resume, including after restart',async()=>{
 const record=image(100),h=await setup({records:[record],fetch:async()=>new Response('',{status:403})});const directory=h.directory;let closed=false;
 try{
  h.jobs.targets([h.target()]);await settle(h.jobs);assert.equal(h.requests.length,1);assert.match(h.jobs.state.accessPause?.reason??'',/403/);assert.equal(h.store.mediaSync(record.id)?.status,'failed');await h.close();closed=true;
  let began!:()=>void;const discoveryStarted=new Promise<void>(resolve=>{began=resolve;});
  const interrupted=await setup({directory,discover:async(_page:any,_id:string,_candidates:()=>string[],signal:AbortSignal)=>{began();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('Discovery stopped')),{once:true}));}});
  try{interrupted.jobs.syncMedia(['aww'],{resume:true});await discoveryStarted;await interrupted.jobs.stopSource('aww');await settle(interrupted.jobs);assert.match(interrupted.store.mediaSync(record.id)?.reason??'',/^Media URL expired/);assert.equal(interrupted.requests.length,0);}finally{await interrupted.close();}
  let discoveries=0;const restarted=await setup({directory,discover:async()=>{discoveries++;return[{kind:'image',url:'https://i.redd.it/fresh-image.png'}];}});
  try{assert.equal(restarted.requests.length,0);restarted.jobs.syncMedia(['aww'],{resume:true});await settle(restarted.jobs);assert.equal(discoveries,1);assert.deepEqual(restarted.requests,['https://i.redd.it/fresh-image.png']);assert.equal(restarted.store.mediaSync(record.id)?.status,'ready');assert.equal(restarted.visits.length,1);}finally{await restarted.close();}
 }finally{if(!closed)await h.close();await rm(directory,{recursive:true,force:true});}
});

test('reconciliation promptly aborts obsolete downloads even when another post still owns the old URL',async()=>{
 let started!:()=>void,aborted=0;const began=new Promise<void>(resolve=>{started=resolve;}),a=image(100),b={...image(101),attachments:a.attachments};
 const h=await setup({fetch:async(url,init)=>{if(String(url).includes('offline100')){started();return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>{aborted++;reject(new Error('Obsolete file aborted'));},{once:true}));}return new Response(png,{headers:{'Content-Type':'image/png'}});}});
 let saving:Promise<void>|undefined;
 try{
  h.store.importArchiveBatch(h.store.generation,[a,b].map(row=>({...row,source:'archive',exportId:'orphan-reconcile'})));saving=h.cache.syncPost(a.id,'first',10,new AbortController().signal);await began;
  h.store.saveMediaReferences(h.store.generation,a.id,[{kind:'image',url:'https://i.redd.it/replacement.png'}]);await Promise.race([h.cache.reconcile(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Reconciliation waited for an obsolete request')),500))]);
  await saving;assert.equal(aborted,1);assert.equal((await h.cache.items(a.id))[0]!.state,'ready');assert.equal(h.store.hasMediaOwner((await h.cache.items(b.id))[0]!.key),true);
 }finally{await h.cache.close();await saving?.catch(()=>{});await h.close();await rm(h.directory,{recursive:true,force:true});}
});

test('an explicit removed-media redirect is unavailable rather than a saved placeholder',async()=>{
 let calls=0;const h=await setup({records:[{...image(100),attachments:[{kind:'image',url:'https://i.imgur.com/old-image.jpg'}]}],fetch:async()=>{calls++;return calls===1?new Response('',{status:302,headers:{Location:'https://i.imgur.com/removed.png'}}):new Response(png,{headers:{'Content-Type':'image/png'}});}});
 try{h.jobs.targets([h.target()]);await settle(h.jobs);assert.equal(calls,1);assert.equal(h.store.mediaSync(image(100).id)?.status,'unavailable');assert.equal(h.cache.status.bytes,0);}finally{await h.close();await rm(h.directory,{recursive:true,force:true});}
});
