import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReaderStore} from '../src/store.ts';
import {ArchiveImporter} from '../src/archive.ts';
import {Readable} from 'node:stream';
import type {PostObservation} from '../src/domain.ts';
import {MediaCache} from '../src/media.ts';
import {RequestQueue} from '../src/request-gate.ts';
import {mkdtemp,rm,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const record=(name:string,id:string):PostObservation=>({id,subreddit:name,title:name+' saved post',permalink:`/r/${name}/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'clear-fixture',observedAt:1800000000000,body:'Saved body',media:['Image'],attachments:[{kind:'image',url:`https://i.redd.it/${id}.png`}]});

test('scoped Clear removes all content and provenance, resets progress, and keeps other feeds and the selected history limit',()=>{
 const store=new ReaderStore(':memory:');
 try{
  const a=store.addSource({name:'aww',historyMonths:3,lowerMs:1600000000000}),b=store.addSource({name:'python',historyMonths:1});
  store.importArchiveBatch(store.generation,[record('aww','abc'),record('python','def')]);
  for(const [id,name] of [['abc','aww'],['def','python']])store.saveSnapshot(store.generation,{id:'snapshot-'+id,postId:'t3_'+id,source:'archive',exportId:'comments',capturedAt:null,observedAt:1800000000000,sort:'chronological',availability:'available',body:'Discussion '+name,comments:[],omitted:0,sample:'Fixture'});

  store.setSetting('imports',[{subreddit:'aww',id:'aww-import'},{subreddit:'python',id:'python-import'}]);
  const other=store.getPost('def'),generation=store.generation,keys=store.ownedMediaKeys('aww');assert.equal(keys.length,1);
  store.clearSubreddit('aww');
  assert.equal(store.generation,generation);assert.equal(store.sourceRevision('aww'),1);assert.equal(store.sourceRevision('python'),0);assert.equal(store.getPost('abc'),null);assert.equal(store.latestSnapshot('abc'),null);assert.equal(store.mediaSync('abc'),null);assert.equal(store.getTarget(a),null);assert(store.getTarget(b));
  assert.deepEqual(store.getPost('def'),other);assert(store.latestSnapshot('def'));
  assert.deepEqual(store.followedSources(),['aww','python']);assert.equal(store.getHistoryPreference('aww').months,3);assert.equal(store.getHistoryPreference('aww').targetId,null);assert.equal(store.feedSources()[0]?.sync.startedAt,null);assert.equal(store.feedSources()[0]?.oldestMs,null);assert.deepEqual(store.ownedMediaKeys('aww'),[]);assert.equal(store.hasMediaOwner(keys[0]!),false);assert.deepEqual(store.getSetting('imports'),[{subreddit:'python',id:'python-import'}]);
  assert.throws(()=>store.commitBatch({generation,targetId:a,observations:[{...record('aww','abc'),source:'live'}],continuation:null}),/no longer active/);
  const refresh=store.planSync(['aww']);assert.equal(store.getTarget(refresh.heads[0]!)?.continuation,null);assert.equal(store.getHistoryPreference('aww').months,3);
 }finally{store.close();}
});

test('scoped Clear retains minimal removal evidence so older archives cannot restore removed posts or comments',()=>{
 const store=new ReaderStore(':memory:');
 try{
  store.addSubreddit('aww');const target=store.createTarget({subreddit:'aww',upperMs:Date.now()});
  store.commitBatch({generation:store.generation,targetId:target,continuation:null,observations:[{...record('aww','abc'),source:'live',availability:'removed'}]});
  store.saveSnapshot(store.generation,{id:'removed',postId:'t3_abc',source:'live',capturedAt:null,observedAt:1800000000001,sort:'best',body:null,availability:'removed',comments:[{id:'t1_x',postId:'t3_abc',parentId:'t3_abc',ancestry:'known',body:'',availability:'removed',createdMs:1700000000000}],omitted:0,sample:'Removed fixture'});
  store.importArchiveBatch(store.generation,[record('aww','def')]);store.saveSnapshot(store.generation,{id:'removed-comment',postId:'t3_def',source:'live',capturedAt:null,observedAt:1800000000001,sort:'best',body:'Available post',availability:'available',comments:[{id:'t1_y',postId:'t3_def',parentId:'t3_def',ancestry:'known',body:'',availability:'removed',createdMs:1700000000000}],omitted:0,sample:'Removed comment'});
  store.setPostTags('abc',['remove-local-tag']);store.setPostFavourite('abc',true);store.setRead('abc',true);store.clearSubreddit('aww');const db=(store as any).db;
  assert.equal(db.prepare('SELECT count(*) AS n FROM posts').get().n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM comment_states').get().n,2);
  for(const table of ['observations','targets','thread_snapshots','media_sync','media_evidence','post_media','body_sync','post_tags','favourite_posts','read_states','search_text'])assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,0,table);
  assert.equal(store.stats().posts,0);store.importArchiveBatch(store.generation,[record('aww','abc')]);assert.equal(store.getPost('abc')!.availability,'removed');assert.equal(store.getPost('abc')!.body,null);assert.deepEqual(store.getPost('abc')!.attachments,[]);
  store.importArchiveBatch(store.generation,[record('aww','def')]);store.saveSnapshot(store.generation,{id:'older-comments',postId:'t3_def',source:'archive',exportId:'older-comments',capturedAt:null,observedAt:1800000000002,sort:'chronological',body:'Old archive text',availability:'available',comments:[{id:'t1_y',postId:'t3_def',parentId:'t3_def',ancestry:'known',body:'Old removed comment text',availability:'available',createdMs:1700000000000}],omitted:0,sample:'Old archive'});assert.equal(store.latestSnapshot('def')!.comments[0]!.availability,'removed');assert.equal(store.latestSnapshot('def')!.comments[0]!.body,'');
 }finally{store.close();}
});

test('individual deletion and scoped Clear do not run a blocking database compaction; explicit reclaim still does',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[record('aww','abc'),record('aww','def')]);const db=(store as any).db,exec=db.exec.bind(db);let compactions=0;
 db.exec=(sql:string)=>{if(sql.includes('VACUUM'))compactions++;return exec(sql);};
 try{store.deletePost('abc');store.clearSubreddit('aww');assert.equal(compactions,0);store.compactStorage();assert.equal(compactions,1);}finally{db.exec=exec;store.close();}
});

test('clearing a source aborts only its own active import and discards its progress',async()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');const importer=new ArchiveImporter(store),input=new Readable({read(){}});
 try{
  const run=importer.run(input,{subreddit:'python',filename:'pending.jsonl',size:100,modified:1});
  await importer.clearSource('aww');assert.equal(importer.progress?.state,'running');
  await importer.clearSource('python');assert.equal((await run).state,'paused');assert.equal(importer.progress,null);
 }finally{await importer.close();store.close();}
});

test('clearing queued media finishes without aborting or waiting for another source download',async()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('aww');store.addSubreddit('python');store.importArchiveBatch(store.generation,[record('aww','abc'),record('python','def')]);
 const directory=await mkdtemp(join(tmpdir(),'reader-clear-queue-'));let release!:(response:Response)=>void,started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});let requests=0,aborted=false;
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async(_input,init)=>{requests++;init?.signal?.addEventListener('abort',()=>{aborted=true;});started();return new Promise<Response>(resolve=>{release=resolve;});}});
 try{
  await cache.initialize();const other=cache.syncPost('def','python',10,new AbortController().signal);await began;await cache.enqueue('abc',true);
  const keys=store.ownedMediaKeys('aww');store.clearSubreddit('aww');
  await Promise.race([cache.clearSource('aww',keys),new Promise((_,reject)=>setTimeout(()=>reject(new Error('Clear waited on the other source')),500))]);
  assert.equal(aborted,false);assert.equal(cache.feedStatus('aww'),'idle');assert.equal(cache.feedStatus('python'),'syncing');assert.equal(requests,1);
  release(new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}}));await other;
  assert.equal((await cache.items('def'))[0]?.state,'ready');assert.equal(requests,1);assert.equal((await readdir(directory)).length,2);assert.equal(cache.feedStatus('aww'),'idle');
 }finally{release?.(new Response(''));await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});

test('clearing active media cancels its download and prevents late file publication',async()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[record('aww','abc')]);const directory=await mkdtemp(join(tmpdir(),'reader-clear-active-'));let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
 const cache=new MediaCache(store,{directory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>{},fetch:async(_input,init)=>{started();return new Promise<Response>((_resolve,reject)=>init?.signal?.addEventListener('abort',()=>reject(new Error('Aborted')),{once:true}));}});
 try{
  await cache.initialize();const download=cache.syncPost('abc','aww',10,new AbortController().signal),rejected=assert.rejects(download,/not saved/);await began;
  const keys=store.ownedMediaKeys('aww');store.clearSubreddit('aww');await cache.clearSource('aww',keys);await rejected;
  assert.deepEqual(await readdir(directory),[]);assert.equal(cache.status.bytes,0);assert.equal(cache.status.pending,0);
 }finally{await cache.close();store.close();await rm(directory,{recursive:true,force:true});}
});
