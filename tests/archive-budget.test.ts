import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {createOnlineReaderServer} from './online-fixture.ts';
import type {ReaderStore} from '../src/store.ts';
import {RequestQueue} from '../src/request-gate.ts';

test('a temporary archive media failure keeps its checkpoint incomplete until explicit Resume saves it',async()=>{
 let fail=true,archiveCalls=0;const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS9sAAAAASUVORK5CYII=','base64');
 const app=await createOnlineReaderServer({database:':memory:',jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async()=>fail?new Response('',{status:503}):new Response(png,{headers:{'Content-Type':'image/png'}})},
  archive:{fetch:async()=>{archiveCalls++;return new Response(JSON.stringify({data:archiveCalls===1?[{id:'abc',subreddit:'aww',title:'Offline archive fixture',created_utc:1577836801,is_self:false,url:'https://i.redd.it/fixture.png'}]:[]}),{headers:{'Content-Type':'application/json'}});}}});
 const settle=async()=>{const deadline=Date.now()+4000;while(app.archive.running||app.jobs.state.running){if(Date.now()>deadline)throw new Error('Archive failure fixture did not settle');await delay(2);}};
 try{
  const id=app.archive.start({subreddit:'aww',from:'2020-01-01',to:'2020-01-01'});await settle();
  assert.equal(archiveCalls,1);assert.equal(app.store.archiveFetch(id)?.state,'paused');assert.equal(app.store.archiveFetch(id)?.phase,'media');assert.match(app.store.archiveFetch(id)?.reason??'',/could not be saved/);
  fail=false;app.archive.resume(id);await settle();assert.equal(app.store.archiveFetch(id)?.state,'done');assert.equal(app.store.archiveMediaCounts(id).ready,1);assert.equal(archiveCalls,2);
 }finally{await app.close();}
});

test('permanently missing archive media is recorded as a gap without blocking later pages or retrying every sync',async()=>{
 let archiveCalls=0,mediaCalls=0;const app=await createOnlineReaderServer({database:':memory:',jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async()=>{mediaCalls++;return new Response('',{status:404});}},
  archive:{fetch:async()=>{archiveCalls++;return new Response(JSON.stringify({data:archiveCalls===1?[{id:'gone',subreddit:'aww',title:'Missing old image',created_utc:1577836801,is_self:false,url:'https://i.redd.it/gone.png'}]:[]}),{headers:{'Content-Type':'application/json'}});}}});
 const settle=async()=>{const deadline=Date.now()+4000;while(app.archive.running||app.jobs.state.running){if(Date.now()>deadline)throw new Error('Permanent media fixture did not settle');await delay(2);}};
 try{
  const id=app.archive.start({subreddit:'aww',from:'2020-01-01',to:'2020-01-01'});await settle();
  assert.equal(app.store.archiveFetch(id)?.state,'done');assert.equal(archiveCalls,2);assert.equal(app.store.archiveMediaCounts(id).unavailable,1);
  app.jobs.syncMedia(['aww'],{resume:true});await settle();assert.equal(mediaCalls,1);
 }finally{await app.close();}
});

test('one archive Start/Resume shares its media budget across pages and resumes pending files without refetching posts',async()=>{
 let store!:ReaderStore,requests=0,archiveCalls=0;
 const start=Date.parse('2020-01-01T00:00:00Z');
 const rows=Array.from({length:150},(_,index)=>({id:(1000+index).toString(36),subreddit:'aww',title:'Image '+index,created_utc:start/1000+index,is_self:false,url:`https://i.redd.it/fixture${index}.jpg`}));
 const app=await createOnlineReaderServer({database:':memory:',jobs:{network:new RequestQueue({intervalMs:0}),
  browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){assert.fail('Direct files need no browser');},async close(){},async manualSignIn(){},async navigate(){assert.fail('Direct files need no browser');}},
  mediaSync:{get status(){return{requests};},pendingPosts(source,session){return store.pendingMedia(source,session);},preparePost(id){return store.mediaSync(id)?.status==='ready'?null:{discover:false};},async syncPost(id,session,allowance,signal){signal.throwIfAborted();assert(allowance>=1);requests++;store.setMediaSync(store.generation,id,'ready',null,session);},stop(){}}},
  archive:{fetch:async input=>{archiveCalls++;const after=Date.parse(new URL(String(input)).searchParams.get('after')!);return new Response(JSON.stringify({data:rows.filter(row=>row.created_utc*1000>after).slice(0,50)}),{headers:{'Content-Type':'application/json'}});}}});
 store=app.store;
 const settle=async()=>{const deadline=Date.now()+5000;while(app.archive.running||app.jobs.state.running){if(Date.now()>deadline)throw new Error('Archive budget fixture did not settle');await delay(2);}};
 try{
  const id=app.archive.start({subreddit:'aww',from:'2020-01-01',to:'2020-01-01'});await settle();
  assert.equal(requests,120);assert.equal(archiveCalls,3);assert.equal(store.stats().posts,150);assert.equal(store.archiveFetch(id)?.state,'paused');assert.equal(store.archiveFetch(id)?.phase,'media');assert.match(store.archiveFetch(id)?.reason??'',/budget/);assert.equal(store.offlineMedia('aww').pending,30);
  app.archive.resume(id);await settle();
  assert.equal(requests,150);assert.equal(archiveCalls,4);assert.equal(store.archiveFetch(id)?.state,'done');assert.equal(store.archiveFetch(id)?.observed,150);assert.equal(store.offlineMedia('aww').ready,150);assert.equal(app.jobs.state.accessPause,null);
 }finally{await app.close();}
});

test('the archive allowance counts browser discovery and CDN requests across browser restarts and pages',async()=>{
 let store!:ReaderStore,cdnRequests=0,browserRequests=0,openRequests=0;
 const start=Date.parse('2020-01-01T00:00:00Z');
 const rows=Array.from({length:60},(_,index)=>({id:(2000+index).toString(36),subreddit:'aww',title:'Video '+index,created_utc:start/1000+index,is_self:false,is_video:true,url:`https://v.redd.it/owner${index}`}));
 const app=await createOnlineReaderServer({database:':memory:',jobs:{network:new RequestQueue({intervalMs:0}),
  browser:{counts:{get released(){return openRequests;},intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(limit){assert((limit??0)>=2);openRequests=0;},async close(){},async manualSignIn(){},async navigate(){openRequests+=2;browserRequests+=2;return{}as any;}},
  readAccount:async()=> 'fixture_user',discoverMedia:async(_page,id)=>[{kind:'video',url:store.getPost(id)!.outbound+'/DASHPlaylist.mpd'}],
  mediaSync:{get status(){return{requests:cdnRequests};},pendingPosts(source,session){return store.pendingMedia(source,session);},preparePost(id){return store.mediaSync(id)?.status==='ready'?null:{discover:store.getPost(id)!.attachments.length===0};},async syncPost(id,session,allowance,signal){signal.throwIfAborted();assert(allowance>=1);cdnRequests++;store.setMediaSync(store.generation,id,'ready',null,session);},stop(){}}},
  archive:{fetch:async input=>{const after=Date.parse(new URL(String(input)).searchParams.get('after')!);return new Response(JSON.stringify({data:rows.filter(row=>row.created_utc*1000>after).slice(0,30)}),{headers:{'Content-Type':'application/json'}});}}});
 store=app.store;
 const settle=async()=>{const deadline=Date.now()+5000;while(app.archive.running||app.jobs.state.running){if(Date.now()>deadline)throw new Error('Archive mixed-budget fixture did not settle');await delay(2);}};
 try{
  const id=app.archive.start({subreddit:'aww',from:'2020-01-01',to:'2020-01-01'});await settle();
  assert.equal(browserRequests+cdnRequests,120);assert.equal(cdnRequests,40);assert.equal(store.archiveFetch(id)?.state,'paused');assert.equal(store.offlineMedia('aww').pending,20);assert.equal(store.stats().posts,60);
  app.archive.resume(id);await settle();
  assert.equal(browserRequests+cdnRequests,180);assert.equal(cdnRequests,60);assert.equal(store.archiveFetch(id)?.state,'done');assert.equal(store.archiveFetch(id)?.observed,60);assert.equal(store.offlineMedia('aww').ready,60);
 }finally{await app.close();}
});
