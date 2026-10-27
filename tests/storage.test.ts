import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReaderStore} from '../src/store.ts';
import {MediaCache,mediaKey} from '../src/media.ts';
import {RequestQueue} from '../src/request-gate.ts';
import {DEFAULT_STORAGE_CAP,StorageLimitError} from '../src/storage-limit.ts';
import type {PostObservation} from '../src/domain.ts';

const record=(id:string,body=''):PostObservation=>({id,subreddit:'aww',title:'Stored '+id,permalink:`/r/aww/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'storage-fixture',observedAt:Date.now(),body,media:['Text']});
const image:PostObservation={...record('abc'),media:['Image'],attachments:[{kind:'image',url:'https://i.redd.it/storage.png'}]};

test('the persisted combined cap rolls back oversized batches and checkpoints, retains content when lowered, and Clear reclaims database space',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-storage-')),database=join(directory,'reader.sqlite');let store=new ReaderStore(database);
 try{
  store.addSubreddit('aww');assert.equal(store.storageLimit,DEFAULT_STORAGE_CAP);
  for(const value of [0,-1,999999,Infinity,1.5,'1000000',null])assert.throws(()=>store.setStorageLimit(value));
  store.setStorageLimit(1_000_000);store.importArchiveBatch(store.generation,[record('abc','a'.repeat(100_000))]);
  const targetId=store.createTarget({subreddit:'aww',upperMs:Date.now()});
  const batch={generation:store.generation,targetId,observations:['def','ghi'].map(id=>({...record(id,'b'.repeat(500_000)),source:'live' as const})),continuation:'https://old.reddit.com/r/aww/new/?after=t3_ghi',batchKey:'large-fixture',status:'queued' as const};
  assert.throws(()=>store.commitBatch(batch),StorageLimitError);assert.equal(store.stats().posts,1);assert.equal(store.getTarget(targetId)?.continuation,null);assert.equal(store.getTarget(targetId)?.observedCount,0);assert(store.storage.usedBytes<=store.storageLimit);
  assert.throws(()=>store.importArchiveBatch(store.generation,[record('def','b'.repeat(900_000))]),StorageLimitError);assert.equal(store.stats().posts,1);
  store.setStorageLimit(10_000_000);store.commitBatch(batch);assert.equal(store.stats().posts,3);store.setStorageLimit(1_000_000);assert(store.storage.full);assert(store.storage.percentUsed>100);assert.throws(()=>store.assertStorageAvailable(),StorageLimitError);
  store.close();store=new ReaderStore(database);assert.equal(store.storageLimit,1_000_000);assert.equal(store.stats().posts,3);store.clearContent();assert.equal(store.stats().posts,0);assert.equal(store.storage.full,false);assert(store.storage.usedBytes<1_000_000);assert.deepEqual(store.followedSources(),['aww']);
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('media headers and streamed bytes obey the database-plus-files cap, clean partial files, and an explicit retry succeeds after an increase',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-storage-media-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[image]);store.setStorageLimit(1_000_000);
 let mode='header',calls=0,cancelled=false;
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>assert.fail('A storage cap is not an access failure'),fetch:async()=>{
  calls++;
  if(mode==='header')return new Response(new ReadableStream({cancel(){cancelled=true;}}),{headers:{'Content-Type':'image/png','Content-Length':'1200000'}});
  return new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(600_000));controller.enqueue(new Uint8Array(600_000));controller.close();}}),{headers:{'Content-Type':'image/png'}});
 }});
 try{
  await cache.initialize();await assert.rejects(cache.syncPost('abc','one',10,new AbortController().signal),/Storage cap/);assert(cancelled);assert.equal(cache.status.bytes,0);assert.deepEqual(await readdir(directory),[]);
  mode='stream';await assert.rejects(cache.syncPost('abc','two',10,new AbortController().signal),/Storage cap/);assert.equal(cache.status.bytes,0);assert.deepEqual(await readdir(directory),[]);assert(store.storage.usedBytes<=1_000_000);
  store.setStorageLimit(2_000_000);await cache.syncPost('abc','three',10,new AbortController().signal);assert.equal(calls,3);assert.equal(cache.status.bytes,1_200_000);assert.equal(store.mediaSync('abc')?.status,'ready');assert(store.storage.usedBytes>store.stats().databaseBytes+cache.status.bytes,'Cache metadata must also count');assert((await stat((await cache.items('abc'))[0]!.localPath!)).isFile());
  store.setStorageLimit(1_000_000);assert(store.storage.full);assert.equal((await cache.items('abc'))[0]!.state,'ready');
 }finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('saved files still count after restart, and lowering the cap never deletes offline media',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-storage-restart-')),database=join(directory,'reader.sqlite'),media=join(directory,'media');let store=new ReaderStore(database);store.addSubreddit('aww');store.importArchiveBatch(store.generation,[image]);
 let cache=new MediaCache(store,{directory:media,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>new Response(new Uint8Array(1_200_000),{headers:{'Content-Type':'image/png'}})});
 try{
  await cache.initialize();await cache.syncPost('abc','first',10,new AbortController().signal);const path=(await cache.items('abc'))[0]!.localPath!;store.setStorageLimit(1_000_000);await cache.close();store.close();
  store=new ReaderStore(database);cache=new MediaCache(store,{directory:media,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>assert.fail('Restart must not download')});await cache.initialize();assert.equal(store.storageLimit,1_000_000);assert(store.storage.full);assert.equal(store.mediaSync('abc')?.status,'ready');assert.equal((await cache.items('abc'))[0]!.localPath,path);assert.equal((await stat(path)).size,1_200_000);assert.equal(cache.status.requests,0);
 }finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('startup frees orphan files while owned files with invalid metadata still count towards the cap until cleared',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-storage-orphan-')),store=new ReaderStore(':memory:');
 store.addSubreddit('aww');store.importArchiveBatch(store.generation,[image]);
 const orphan='a'.repeat(64),corrupt=mediaKey(image.attachments![0]!);
 await writeFile(join(directory,orphan),new Uint8Array(1_200_000));await writeFile(join(directory,corrupt),new Uint8Array(900_000));await writeFile(join(directory,corrupt+'.json'),'invalid metadata');
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>assert.fail('Startup must not download')});
 try{
  await cache.initialize();store.setStorageLimit(1_000_000);assert.equal(cache.status.bytes,900_000);assert.equal(store.storage.usedBytes,store.stats().databaseBytes+900_000+16);assert.equal(store.storage.full,true);
  await assert.rejects(stat(join(directory,orphan)),{code:'ENOENT'});assert.equal((await stat(join(directory,corrupt))).size,900_000);await cache.clear();assert.deepEqual(await readdir(directory),[]);assert.equal(cache.status.bytes,0);
 }finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('compaction failure cannot prevent logical Clear or media cleanup',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-storage-clear-failure-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[image]);
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}})});
 try{
  await cache.initialize();await cache.syncPost('abc','first',10,new AbortController().signal);
  const db=(store as any).db,exec=db.exec.bind(db);db.exec=(sql:string)=>{if(sql.includes('VACUUM'))throw new Error('Injected compaction failure');return exec(sql);};
  const generation=store.generation;assert.equal(store.clearContent(),generation+1);await cache.clear();
  assert.equal(store.stats().posts,0);assert.equal(cache.status.bytes,0);assert.deepEqual(await readdir(directory),[]);assert.match(store.compactionWarning??'',/compaction failed/);assert.deepEqual(store.followedSources(),['aww']);
 }finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});
