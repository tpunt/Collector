import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { zstdCompressSync } from 'node:zlib';
import { ReaderStore } from '../src/store.ts';
import { ArchiveImporter } from '../src/archive.ts';
import { advanceBoundary } from '../src/history.ts';
import type { Listing, ThreadSnapshot } from '../src/extract.ts';

const row=(id='abc',overrides={})=>({id,subreddit:'python',title:'An older Python story',created_utc:1600000000,selftext:'A saved body',is_self:true,...overrides});
function setup(t: {after: (fn:()=>void)=>void}){const store=new ReaderStore(':memory:');store.addSubreddit('python');t.after(()=>store.close());return store;}
async function runImport(store:ReaderStore,content:Buffer|string,filename='sample.jsonl',postIds:string[]=[]) {const buf=Buffer.from(content);return new ArchiveImporter(store).run(Readable.from([buf.subarray(0,7),buf.subarray(7)]),{subreddit:'python',filename,size:buf.length,modified:1,postIds});}

test('streamed JSONL and zstd imports keep provenance, filters, omissions and deduplicated IDs',async t=>{
  const store=setup(t);const data=[row(),row('def',{created_utc:1600000001}),row('zzz',{subreddit:'other'}),{...row('bad'),title:null}].map(item=>JSON.stringify(item)).join('\n');
  const result=await runImport(store,zstdCompressSync(Buffer.from(data)),'posts.zst');
  assert.equal(result.state,'done');assert.equal(result.accepted,2);assert.equal(result.omitted,1);assert.equal(result.filtered,1);assert.equal(store.stats().posts,2);
  await runImport(store,data);assert.equal(store.stats().posts,2);assert.equal(store.getPost('abc')?.capturedAt,null);assert.equal(store.listUnfinishedTargets().length,0);
  const page=store.queryFeed({media:'Text',text:'body',limit:1});assert.equal(page.posts[0]?.id,'t3_def');assert(page.next);assert.equal(store.queryFeed({cursor:page.next!,limit:1}).posts[0]?.id,'t3_abc');
});
test('truncated compression, oversized lines and invalid UTF-8 pause rather than claim exhaustion',async t=>{
  const store=setup(t);const compressed=zstdCompressSync(Buffer.from(JSON.stringify(row())));
  assert.equal((await runImport(store,compressed.subarray(0,compressed.length-4),'bad.zst')).state,'paused');
  assert.equal((await runImport(store,'x'.repeat(1_000_001))).state,'paused');
  assert.equal((await runImport(store,Buffer.from([255]))).state,'paused');
  const oversizedWindow=Buffer.from([0x28,0xb5,0x2f,0xfd,0,144,1,0,0]);
  const windowResult=await runImport(store,oversizedWindow,'window.zst');assert.equal(windowResult.state,'paused');assert.match(windowResult.reason!,/window|memory/i);
});
test('archive removal metadata redacts old body and imported comments retain explicit missing ancestry',async t=>{
  const store=setup(t);await runImport(store,JSON.stringify(row('abc',{_meta:{was_deleted_later:true}})));
  assert.equal(store.getPost('abc')?.body,null);
  await runImport(store,JSON.stringify(row('def')));
  const comments=[{id:'c1',subreddit:'python',link_id:'t3_def',parent_id:'t3_def',body:'Root',created_utc:1600000001},{id:'c2',subreddit:'python',link_id:'t3_def',parent_id:'t1_missing',body:'Missing root',created_utc:1600000002}];
  await runImport(store,comments.map(item=>JSON.stringify(item)).join('\n'),'comments.jsonl',['t3_def']);
  const snapshot=store.latestSnapshot('def')!;assert.equal(snapshot.source,'archive');assert.equal(snapshot.comments.length,2);assert.equal(snapshot.comments[1]?.ancestry,'unresolved');
});

test('large archive comment samples have an aggregate memory bound and disclose omissions',async t=>{
 const store=setup(t);await runImport(store,JSON.stringify(row()));
 const comments=Array.from({length:6},(_,index)=>JSON.stringify({id:'c'+index,subreddit:'python',link_id:'t3_abc',parent_id:'t3_abc',body:'x'.repeat(900_000),created_utc:1600000001+index})).join('\n');
 const result=await runImport(store,comments,'comments.jsonl',['t3_abc']);assert.equal(result.state,'done');assert.equal(result.omitted,2);
 const snapshot=store.latestSnapshot('abc')!;assert.equal(snapshot.comments.length,4);assert.equal(snapshot.omitted,2);assert(snapshot.comments.reduce((sum,comment)=>sum+comment.body.length,0)<=4_000_000);
});

test('closing an importer aborts and awaits its active stream before database shutdown',async()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');const importer=new ArchiveImporter(store);
 const input=new Readable({read(){}});const run=importer.run(input,{subreddit:'python',filename:'unfinished.jsonl',size:100,modified:1});
 await importer.close();assert.equal((await run).state,'paused');assert.equal(importer.progress?.state,'paused');store.close();
});
test('date boundaries need distinct older ordinary records across two batches; unknown time resets evidence',t=>{
  const store=setup(t);const id=store.createTarget({subreddit:'python',lowerMs:1700000000000,upperMs:1800000000000});const target=store.getTarget(id)!;
  const listing={ordinary:['a','b','c','d','e'].map(id=>({id:'t3_'+id,createdMs:1600000000000,precisionMs:1000})),unknownTime:false,signature:'a',next:'https://old.reddit.com/r/python/new/?after=t3_e'} as Listing;
  const first=advanceBoundary(target,listing);assert.equal(first.done,false);
  const second=advanceBoundary({...target,boundary:first.boundary},{...listing,signature:'b',ordinary:[{id:'t3_f',createdMs:1600000000000,precisionMs:1000}]});assert.equal(second.done,true);
  assert.equal(advanceBoundary({...target,boundary:first.boundary},{...listing,unknownTime:true}).done,false);
  assert.equal(advanceBoundary(target,{...listing,ordinary:[{id:'t3_g',createdMs:1699999999500,precisionMs:1000}]}).boundary.olderIds.length,0);
});
test('live comment removal blocks archive resurrection without deleting surviving discussion',async t=>{
  const store=setup(t);await runImport(store,JSON.stringify(row()));
  const snapshot:ThreadSnapshot={id:'s1',postId:'t3_abc',source:'live',capturedAt:1,observedAt:1800000000000,sort:'best',body:null,availability:'available',comments:[{id:'t1_c',postId:'t3_abc',parentId:'t3_abc',ancestry:'known',body:'Current',availability:'available',createdMs:1}],omitted:0,sample:'test'};
  store.saveSnapshot(store.generation,snapshot);
  store.saveSnapshot(store.generation,{...snapshot,id:'s2',observedAt:1800000000001,availability:'removed',comments:[{...snapshot.comments[0]!,body:'',availability:'deleted'}]});
  assert.equal(store.latestSnapshot('abc')?.availability,'removed');assert.equal(store.latestSnapshot('abc')?.comments[0]?.body,'');
  store.clearContent();assert.throws(()=>store.saveSnapshot(0,snapshot),/cleared/);
});
test('delayed comment removal cannot erase a newer verified reinstatement',async t=>{
 const store=setup(t);await runImport(store,JSON.stringify(row()));
 const snapshot:ThreadSnapshot={id:'new',postId:'t3_abc',source:'live',capturedAt:2,observedAt:2000,sort:'best',body:'Body',availability:'available',comments:[{id:'t1_x',postId:'t3_abc',parentId:'t3_abc',ancestry:'known',body:'Reinstated',availability:'available',createdMs:1}],omitted:0,sample:'test'};
 store.saveSnapshot(store.generation,snapshot);store.saveSnapshot(store.generation,{...snapshot,id:'late',observedAt:1000,comments:[{...snapshot.comments[0]!,availability:'removed',body:''}]});
 assert.equal(store.latestSnapshot('abc')?.comments[0]?.body,'Reinstated');
});

test('global Clear retains comment removal evidence when the surviving post is imported again',async t=>{
 const store=setup(t);await runImport(store,JSON.stringify(row()));
 const snapshot:ThreadSnapshot={id:'removed-comment',postId:'t3_abc',source:'live',capturedAt:null,observedAt:1800000000000,sort:'best',body:null,availability:'available',comments:[{id:'t1_x',postId:'t3_abc',parentId:'t3_abc',ancestry:'known',body:'',availability:'removed',createdMs:1}],omitted:0,sample:'Fixture'};
 store.saveSnapshot(store.generation,snapshot);store.clearContent();await runImport(store,JSON.stringify(row()));
 store.saveSnapshot(store.generation,{...snapshot,id:'old-archive',source:'archive',observedAt:1900000000000,comments:[{...snapshot.comments[0]!,body:'Old deleted text',availability:'available'}]});
 assert.equal(store.latestSnapshot('abc')?.comments[0]?.body,'');assert.equal(store.latestSnapshot('abc')?.comments[0]?.availability,'removed');
});

test('media filters recognise explicit video/gallery URLs without inferring from thumbnails or channel pages',async()=>{
 const {classifyMedia}=await import('../src/extract.ts');const classify=(outbound:string)=>classifyMedia({self:false,video:false,image:false,outbound});
 assert.deepEqual(classify('https://www.youtube.com/watch?v=abc123'),['Video']);assert.deepEqual(classify('https://youtu.be/abc123'),['Video']);
 assert.deepEqual(classify('https://www.youtube.com/@channel'),['Link']);assert.deepEqual(classify('https://www.reddit.com/gallery/abc123'),['Image']);assert.deepEqual(classify('https://youtube.com.evil.test/watch?v=abc'),['Link']);
});

test('streamed file import can pass the former million-record ceiling without retaining the whole file',async t=>{
 const store=setup(t),line=Buffer.from('{"subreddit":"other"}\n'),chunk=Buffer.concat(Array.from({length:1000},()=>line));
 async function* chunks(){for(let index=0;index<1000;index++)yield chunk;yield line;}
 const count=1_000_001,result=await new ArchiveImporter(store).run(Readable.from(chunks()),{subreddit:'python',filename:'large.jsonl',size:count*line.length,modified:1});
 assert.equal(result.state,'done');assert.equal(result.lines,count);assert.equal(result.filtered,count);assert.equal(result.accepted,0);assert.equal(store.stats().posts,0);
});
