import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {ReaderStore} from '../src/store.ts';
import {ArchiveImporter} from '../src/archive.ts';
import {ReaderJobs} from '../src/jobs.ts';

const post={id:'abc',subreddit:'python',title:'Saved fixture',created_utc:1600000000,selftext:'Body',is_self:true};
function fixture(){const store=new ReaderStore(':memory:');store.addSubreddit('python');return{store,importer:new ArchiveImporter(store)};}

test('rejected comment selection leaves no running import and a valid import can start immediately',async()=>{
 const {store,importer}=fixture(),data=Buffer.from(JSON.stringify(post));
 try{
  for(const postIds of [Array.from({length:11},(_,i)=>(1000+i).toString(36)),['invalid!']]){
   await assert.rejects(importer.run(Readable.from([data]),{subreddit:'python',filename:'fixture.jsonl',size:data.length,modified:1,postIds}));
   assert.equal(importer.progress,null);
  }
  const result=await importer.run(Readable.from([data]),{subreddit:'python',filename:'fixture.jsonl',size:data.length,modified:1});assert.equal(result.state,'done');assert.equal(store.stats().posts,1);
 }finally{await importer.close();store.close();}
});

test('unknown archive capture timestamps represented as null do not discard otherwise valid posts',async()=>{
 const {store,importer}=fixture(),data=Buffer.from(JSON.stringify({...post,retrieved_on:null}));
 try{const result=await importer.run(Readable.from([data]),{subreddit:'python',filename:'unknown-capture.jsonl',size:data.length,modified:1});assert.equal(result.state,'done');assert.equal(result.omitted,0);assert.equal(result.accepted,1);assert.equal(store.getPost('abc')?.capturedAt,null);}finally{await importer.close();store.close();}
});

test('failure to persist import diagnostics cannot strand shutdown or leave the importer busy',async()=>{
 const {store,importer}=fixture(),original=store.setSetting.bind(store),data=Buffer.from(JSON.stringify(post));
 store.setSetting=(key,value)=>{if(key==='imports')throw new Error('Fixture disk full while saving import progress');original(key,value);};
 try{
  await assert.rejects(importer.run(Readable.from([data]),{subreddit:'python',filename:'fixture.jsonl',size:data.length,modified:1}),/Fixture disk full/);
  const completed=await Promise.race([importer.close().then(()=>true),new Promise<boolean>(resolve=>setTimeout(()=>resolve(false),100))]);assert.equal(completed,true);assert.equal(importer.progress?.state,'paused');assert.equal(store.stats().posts,1);
 }finally{store.setSetting=original;store.close();}
});

for(const kind of ['thread','media'] as const)test(`a late ${kind} account read cannot restore the account binding after Clear all`,async()=>{
 const {store,importer}=fixture();store.bindAccount('old_user');
 store.importArchiveBatch(store.generation,[{id:'abc',subreddit:'python',title:'Account fixture',permalink:'/r/python/comments/abc/',created:{epochMs:1600000000000,precisionMs:1000},source:'archive',exportId:'account-fixture',observedAt:Date.now(),media:['Video']}]);
 let release!:(value:string)=>void,started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;}),account=new Promise<string>(resolve=>{release=resolve;});
 const jobs=new ReaderJobs(store,{browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(){return{}as any;}},
  readAccount:async()=>{started();return account;},readThread:async()=>assert.fail('Cleared thread must not be read'),discoverMedia:async()=>assert.fail('Cleared media must not be discovered'),
  mediaSync:{status:{requests:0},pendingPosts:(name,session)=>store.pendingMedia(name,session),preparePost:()=>({discover:true}),async syncPost(){assert.fail('Cleared media must not be downloaded');},stop(){}}});
 try{
  if(kind==='thread')jobs.thread('t3_abc');else jobs.syncMedia(['python']);await began;
  jobs.pause('Content cleared');store.clearContent();release('old_user');
  const deadline=Date.now()+1000;while(jobs.state.running){if(Date.now()>deadline)throw new Error('Account fixture did not stop');await new Promise(resolve=>setTimeout(resolve,2));}
  assert.equal(store.getSetting('account'),null);store.bindAccount('new_user');
 }finally{release('old_user');await jobs.close();await importer.close();store.close();}
});
