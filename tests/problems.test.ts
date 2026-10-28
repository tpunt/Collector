import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm,stat,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProblemLog} from '../src/problems.ts';
import {ExtractionError,SyncLimitError} from '../src/sync-errors.ts';
import {EXTERNAL_ATTACHMENT_NOTE} from '../src/sources.ts';
import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const problem=()=>new ExtractionError('listing-records','Raw error message never belongs in diagnostics',{rows:10,accepted:9,rejected:1,missingFields:['datetime']});

test('repeat counters update without per-occurrence writes, flush on close and survive restart with bounded acknowledgement',async()=>{
 const root=await mkdtemp(join(tmpdir(),'collector-problems-'));let now=100000;let log=new ProblemLog(root,{now:()=>now});
 try{
  log.report({operation:'listing',feed:'python'},problem());const first=await readFile(log.path,'utf8');
  for(let index=0;index<1000;index++){now++;log.report({operation:'listing',feed:'python'},problem());}
  assert.equal(log.status.groups,1);assert.equal(log.status.unseen,1001);assert.equal(await readFile(log.path,'utf8'),first);assert.equal(log.list().records[0]!.count,1001);assert.equal(log.list().records[0]!.lastAt,now);
  log.close();log=new ProblemLog(root,{now:()=>now});assert.equal(log.list().records[0]!.count,1001);assert.equal(log.status.unseen,1001);
  const row=log.list().records[0]!;log.acknowledge([{id:row.id,count:1000}]);assert.equal(log.status.unseen,1);assert.throws(()=>log.acknowledge([{id:'invalid',count:1}]),/Invalid displayed/);
  log.close();log=new ProblemLog(root,{now:()=>now});assert.equal(log.status.unseen,1);assert.equal((await stat(log.path)).mode&0o777,0o600);
 }finally{log.close();await rm(root,{recursive:true,force:true});}
});
test('fresh problem storms respect the shared write throttle and retention bounds even before the next flush',async()=>{
 const root=await mkdtemp(join(tmpdir(),'collector-problems-bound-'));let now=100000;const log=new ProblemLog(root,{now:()=>now,maxEntries:10,maxBytes:6000,burst:3});
 try{
  for(let index=0;index<3;index++)log.report({operation:'listing',feed:'feed'+index},problem());
  const initial=await readFile(log.path,'utf8');
  for(let index=3;index<500;index++)log.report({operation:'listing',feed:'feed'+index},problem());
  assert(log.status.groups<=10);assert(log.status.dropped>=490);assert.equal(await readFile(log.path,'utf8'),initial);assert((await stat(log.path)).size<=6000);
  now+=60001;log.report({operation:'listing',feed:'later'},problem());assert((await stat(log.path)).size<=6000);assert(log.list().records.some(row=>row.feed==='later'));
  log.close();const restored=new ProblemLog(root,{maxEntries:10,maxBytes:6000});assert(restored.status.groups<=10);assert.equal(restored.status.writeError,null);restored.close();
 }finally{log.close();await rm(root,{recursive:true,force:true});}
});
test('diagnostics keep structural facts and source locations while excluding content, credentials, signed parameters and title slugs',async()=>{
 const root=await mkdtemp(join(tmpdir(),'collector-problems-redaction-')),log=new ProblemLog(root);
 try{
  const error=new ExtractionError('listing-records','PRIVATE_BODY password=SECRET_PASSWORD',{rows:2,rejected:1,missingFields:['datetime','PRIVATE_BODY'],selector:'PRIVATE_BODY',visibleIds:['t3_abc','PRIVATE_BODY / SECRET_PASSWORD']});
  error.stack='Error: PRIVATE_BODY\n at parser (/Users/private-user/private-folder/src/extract.ts:100:4)\n at SECRET_PASSWORD (https://site.test/token=SECRET_TOKEN)';
  log.report({operation:'listing',feed:'python',post:'abc',url:'https://someone:SECRET_PASSWORD@old.reddit.com/r/python/comments/abc/PRIVATE_TITLE/?token=SECRET_TOKEN#SECRET_FRAGMENT'},error);
  log.report({operation:'download',feed:'python',url:'https://v.redd.it/SECRET_PATH/DASH_720.mp4?token=SECRET_TOKEN'},new Error('HTTP 403 PRIVATE_BODY'));log.close();
  const raw=await readFile(log.path,'utf8');for(const secret of ['PRIVATE_BODY','SECRET_PASSWORD','PRIVATE_TITLE','SECRET_TOKEN','SECRET_FRAGMENT','SECRET_PATH','private-user','private-folder','someone'])assert(!raw.includes(secret),secret);
  assert(raw.includes('src/extract.ts:100:4'));assert(raw.includes('datetime'));assert(raw.includes('https://old.reddit.com/r/python/comments/abc/'));assert(raw.includes('https://v.redd.it/[media]'));assert(raw.includes('403'));
  const restored=new ProblemLog(root);assert.equal(restored.status.writeError,null);assert.equal(restored.status.groups,2);restored.close();
 }finally{log.close();await rm(root,{recursive:true,force:true});}
});
test('expected operating pauses and online-only media do not create problem activity or a file',async()=>{
 const root=await mkdtemp(join(tmpdir(),'collector-problems-expected-')),log=new ProblemLog(root);
 try{
  log.report({operation:'collection'},new SyncLimitError('Sync request budget reached; Resume to fetch remaining posts and media.'));log.report({operation:'download'},new Error(EXTERNAL_ATTACHMENT_NOTE));
  assert.equal(log.status.groups,0);await assert.rejects(stat(log.path),{code:'ENOENT'});log.close();log.report({operation:'listing'},problem());assert.equal(log.status.groups,0);
 }finally{log.close();await rm(root,{recursive:true,force:true});}
});
test('unwritable, corrupt and oversized logs surface health errors without interrupting collection or loading arbitrary content',async()=>{
 const root=await mkdtemp(join(tmpdir(),'collector-problems-io-')),blocked=join(root,'blocked');await writeFile(blocked,'A file instead of a directory');let log=new ProblemLog(join(blocked,'logs'));
 try{
  assert.doesNotThrow(()=>log.report({operation:'listing',feed:'python'},problem()));assert.equal(log.status.groups,1);assert(log.status.writeError);log.close();
  const directory=join(root,'corrupt');await mkdir(directory);await writeFile(join(directory,'problems.json'),'{corrupt SECRET_CONTENT');log=new ProblemLog(directory);assert(log.status.writeError);assert.equal(log.status.groups,0);assert(!JSON.stringify(log.list()).includes('SECRET_CONTENT'));
  log.report({operation:'listing'},problem());assert.equal(log.status.writeError,null);log.close();
  await writeFile(join(directory,'problems.json'),'x'.repeat(300000));log=new ProblemLog(directory);assert(log.status.writeError);assert.equal(log.status.groups,0);
 }finally{log.close();await rm(root,{recursive:true,force:true});}
});
test('failed disk writes are throttled too, so a logging failure cannot create its own filesystem storm',async()=>{
 const root=await mkdtemp(join(tmpdir(),'collector-problems-failed-rate-')),log=new ProblemLog(root,{now:()=>100000});let attempts=0;const original=fs.mkdirSync;
 fs.mkdirSync=((...args:Parameters<typeof fs.mkdirSync>)=>{if(String(args[0])===root){attempts++;throw Object.assign(new Error('No diagnostic write permission'),{code:'EACCES'});}return original(...args);}) as typeof fs.mkdirSync;syncBuiltinESMExports();
 try{
  for(let index=0;index<1000;index++)log.report({operation:'listing',feed:'feed'+index},problem());
  assert.equal(attempts,20);assert(log.status.writeError);assert(log.status.groups<=200);log.close();assert.equal(attempts,21,'Normal shutdown gets one final attempt to preserve counters');
 }finally{fs.mkdirSync=original;syncBuiltinESMExports();log.close();await rm(root,{recursive:true,force:true});}
});
