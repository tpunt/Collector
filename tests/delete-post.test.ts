import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Readable} from 'node:stream';
import {ReaderStore} from '../src/store.ts';
import {ReaderJobs} from '../src/jobs.ts';
import {ArchiveImporter} from '../src/archive.ts';
import {MediaCache} from '../src/media.ts';
import {RequestQueue} from '../src/request-gate.ts';
import type {PostObservation} from '../src/domain.ts';
import type {ThreadSnapshot} from '../src/extract.ts';

const record=(id:string,name='python',url?:string):PostObservation=>({id,subreddit:name,title:'Saved '+id,permalink:`/r/${name}/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'delete-fixture',observedAt:1800000000000,body:'Saved body',media:[url?'Image':'Text'],attachments:url?[{kind:'image',url}]:[]});
const snapshot=(id:string):ThreadSnapshot=>({id:'snapshot-'+id,postId:'t3_'+id,source:'live',observedAt:1800000000001,capturedAt:null,sort:'best',body:'Discussion body',availability:'available',comments:[{id:'t1_comment'+id,postId:'t3_'+id,parentId:'t3_'+id,ancestry:'known',body:'Saved comment',availability:'available',createdMs:1700000000001}],omitted:0,sample:'Fixture'});

test('post deletion removes its content , preserves other posts and checkpoints, and persists exclusions across Clear and restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-delete-persist-')),database=join(directory,'reader.sqlite');let store=new ReaderStore(database);
 try{
  store.addSubreddit('python');const target=store.createTarget({subreddit:'python',upperMs:1900000000000}),cursor='https://old.reddit.com/r/python/new/?after=t3_def';
  store.commitBatch({generation:store.generation,targetId:target,observations:['abc','def'].map(id=>({...record(id),source:'live'})),continuation:cursor});
  store.saveSnapshot(store.generation,snapshot('abc'));store.saveSnapshot(store.generation,snapshot('def'));

  const other=store.getPost('def');store.deletePost('abc');
  assert.equal(store.getPost('abc'),null);assert.equal(store.latestSnapshot('abc'),null);assert.deepEqual(store.getPost('def'),other);assert(store.latestSnapshot('def'));assert.equal(store.getTarget(target)?.continuation,cursor);assert.equal(store.isPostExcluded('abc'),true);
  assert.throws(()=>store.saveSnapshot(store.generation,snapshot('abc')),/cleared|unavailable/);store.saveMediaReferences(store.generation,'abc',[{kind:'image',url:'https://i.redd.it/late.png'}]);assert.equal(store.getPost('abc'),null);
  assert.equal(store.importArchiveBatch(store.generation,[record('abc')]),0);
  store.commitBatch({generation:store.generation,targetId:target,observations:[{...record('abc'),source:'live'},{...record('ghi'),source:'live'}],continuation:null,status:'done',completion:'listing-end'});assert.equal(store.stats().posts,2);assert.equal(store.getPost('abc'),null);
  store.close();store=new ReaderStore(database);assert(store.isPostExcluded('abc'));assert.equal(store.getPost('abc'),null);
  store.clearSubreddit('python');assert.equal(store.importArchiveBatch(store.generation,[record('abc')]),0);store.clearContent();assert.equal(store.importArchiveBatch(store.generation,[record('abc')]),0);assert(store.isPostExcluded('abc'));assert.deepEqual(store.deletePost('abc'),[]);
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('history still advances through pages containing only excluded posts',async()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');store.importArchiveBatch(store.generation,[record('abc'),record('def')]);store.deletePost('abc');store.deletePost('def');let pages=0;
 const jobs=new ReaderJobs(store,{browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(url){return{url:()=>url}as any;}},readListing:async()=>{const id=pages++===0?'abc':'def',post={...record(id),source:'live' as const};return{account:'fixture_user',posts:[post],ordinary:[{id:'t3_'+id,createdMs:post.created.epochMs,precisionMs:1000}],unknownTime:false,omissions:0,next:pages===1?'https://old.reddit.com/r/python/new/?after=t3_abc':null,empty:false,signature:id};}});
 try{
  const target=store.createTarget({subreddit:'python',upperMs:1900000000000});jobs.targets([target]);const deadline=Date.now()+2000;while(jobs.state.running){if(Date.now()>deadline)throw new Error('Excluded-page history stalled');await new Promise(resolve=>setTimeout(resolve,2));}
  assert.equal(pages,2);assert.equal(store.stats().posts,0);assert.equal(store.getTarget(target)?.status,'done');assert.equal(store.getTarget(target)?.completion,'listing-end');
 }finally{await jobs.close();store.close();}
});

test('individual deletion removes exclusive and superseded media but preserves files used by another post, including in the same subreddit',async()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('aww');store.addSubreddit('python');const shared='https://i.redd.it/shared.png';store.importArchiveBatch(store.generation,[record('abc','aww',shared),record('def','aww',shared),record('ghi','aww','https://i.redd.it/old.png'),record('jkl','python',shared)]);
 const directory=await mkdtemp(join(tmpdir(),'reader-delete-media-'));const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}})});
 try{
  await cache.initialize();await cache.syncPost('abc','one',10,new AbortController().signal);await cache.syncPost('ghi','two',10,new AbortController().signal);
  store.importArchiveBatch(store.generation,[{...record('ghi','aww','https://i.redd.it/new.png'),observedAt:1800000000001}]);await cache.syncPost('ghi','three',10,new AbortController().signal);assert.equal(cache.status.bytes,6);
  await cache.clearPost('ghi',store.deletePost('ghi'));assert.equal(cache.status.bytes,3);assert.equal((await cache.items('abc'))[0]?.state,'ready');
  await cache.clearPost('abc',store.deletePost('abc'));assert.equal((await cache.items('def'))[0]?.state,'ready');
  await cache.clearPost('def',store.deletePost('def'));assert.equal((await cache.items('jkl'))[0]?.state,'ready');assert.equal(cache.status.bytes,3);
  await cache.clearPost('jkl',store.deletePost('jkl'));assert.equal(cache.status.bytes,0);assert.deepEqual(await readdir(directory),[]);
 }finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('deleting queued media does not wait for or abort another post download in the same subreddit',async()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');store.importArchiveBatch(store.generation,[record('abc','python','https://i.redd.it/abc.png'),record('def','python','https://i.redd.it/def.png')]);const directory=await mkdtemp(join(tmpdir(),'reader-delete-queued-'));
 let release!:(value:Response)=>void,started!:()=>void,aborted=false,calls=0;const began=new Promise<void>(resolve=>{started=resolve;});
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async(_input,init)=>{calls++;init?.signal?.addEventListener('abort',()=>{aborted=true;});started();return new Promise<Response>(resolve=>{release=resolve;});}});
 try{
  await cache.initialize();const other=cache.syncPost('def','other',10,new AbortController().signal);await began;await cache.enqueue('abc',true);
  await Promise.race([cache.clearPost('abc',store.deletePost('abc')),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Delete waited on another post')),500))]);assert.equal(aborted,false);
  release(new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}}));await other;assert.equal(calls,1);assert.equal((await cache.items('def'))[0]?.state,'ready');assert.equal(cache.status.pending,0);
 }finally{release?.(new Response(''));await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('archive import filters deleted posts and comments, including a post buffered before deletion',async()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');store.importArchiveBatch(store.generation,[record('abc')]);const importer=new ArchiveImporter(store);
 const first=JSON.stringify({id:'abc',subreddit:'python',title:'Spam',created_utc:1700000000,is_self:true,selftext:'Spam body'})+'\n',rest=[{id:'abc',subreddit:'python',title:'Spam again',created_utc:1700000000},{id:'def',subreddit:'python',title:'Keep',created_utc:1700000000},{id:'comment',link_id:'t3_abc',parent_id:'t3_abc',subreddit:'python',created_utc:1700000000,body:'Deleted comment'}].map(row=>JSON.stringify(row)).join('\n');
 const input=new Readable({read(){}});
 try{
  const run=importer.run(input,{subreddit:'python',filename:'posts.jsonl',size:Buffer.byteLength(first+rest),modified:1,postIds:['abc']});input.push(first);const deadline=Date.now()+1000;while(!importer.progress?.lines){if(Date.now()>deadline)throw new Error('Import did not buffer first record');await new Promise(resolve=>setTimeout(resolve,2));}
  store.deletePost('abc');input.push(rest);input.push(null);const result=await run;assert.equal(result.state,'done');assert.equal(result.filtered,2);assert.equal(result.added,1);assert.equal(store.getPost('abc'),null);assert.equal(store.latestSnapshot('abc'),null);assert(store.getPost('def'));
 }finally{await importer.close();store.close();}
});

test('deletion remains available at the storage cap',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');
  try{store.importArchiveBatch(store.generation,[{...record('abc'),body:'x'.repeat(600000)},{...record('abc'),exportId:'second-capture',body:'y'.repeat(600000)}]);store.setStorageLimit(1000000);assert(store.storage.full);store.deletePost('abc');assert.equal(store.storage.full,false);assert(store.isPostExcluded('abc'));}finally{store.close();}
});
