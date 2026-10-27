import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReaderStore} from '../src/store.ts';
import {SCHEMA_VERSION} from '../src/schema.ts';

test('a fresh database has only the current schema and reopens without bootstrapping legacy state',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-clean-schema-')),path=join(directory,'reader.sqlite');
 let store:ReaderStore|undefined;
 try{
  store=new ReaderStore(path);store.addSubreddit('python');store.setHistoryLimit('python',3);store.removeSubreddit('python');store.close();store=undefined;
  const db=new DatabaseSync(path);
  try{
   assert.equal(db.prepare('PRAGMA user_version').get()!.user_version,SCHEMA_VERSION);
   const tables=db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all().map(row=>row.name);
   for(const obsolete of ['subreddits','feed_history','source_heads','summaries','media_owners','media_post_owners'])assert(!tables.includes(obsolete),obsolete);
   assert(tables.includes('feeds'));assert(tables.includes('post_media'));
   const columns=db.prepare('PRAGMA table_info(targets)').all().map(row=>row.name);assert(!columns.includes('kind'));assert(columns.includes('anchor_ms'));
   assert.equal(db.prepare('SELECT count(*) AS n FROM settings').get()!.n,0,'No migration flags are written');
   assert.throws(()=>db.prepare("UPDATE feeds SET history_months=2 WHERE name='python'").run(),/CHECK/);
   assert.throws(()=>db.prepare("UPDATE targets SET status='done' WHERE subreddit='python'").run(),/CHECK/);
   assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{db.close();}
  store=new ReaderStore(path);assert.deepEqual(store.followedSources(),[]);assert.equal(store.getHistoryPreference('python').months,3);assert.equal(store.feedSync('python').state,'never');
 }finally{store?.close();await rm(directory,{recursive:true,force:true});}
});

test('the additive text-work upgrade preserves a version-one library and queues missing live bodies without starting collection',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-body-upgrade-')),path=join(directory,'reader.sqlite');let store=new ReaderStore(path);
 try{
  store.addSubreddit('python');store.setSetting('storageCapBytes',1_000_000_000);
  store.importArchiveBatch(store.generation,[{id:'abc',subreddit:'python',title:'Retained archive',body:'Complete archive text',permalink:'/r/python/comments/abc/',created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'upgrade',observedAt:1800000000000,media:['Text']}]);
  const target=store.createTarget({subreddit:'python',upperMs:1800000000000});store.commitBatch({generation:store.generation,targetId:target,observations:[{id:'def',subreddit:'python',title:'Missing body',permalink:'/r/python/comments/def/',created:{epochMs:1700000000001,precisionMs:1000},source:'live',observedAt:1800000000000,media:['Text']}],continuation:null});
  store.close();const old=new DatabaseSync(path);old.exec('DROP TRIGGER search_insert; DROP TRIGGER search_update; DROP TRIGGER search_delete; DROP TABLE search_index; DROP TABLE search_text; DROP TABLE read_states; DROP TABLE body_sync; PRAGMA user_version=1;');old.close();
  store=new ReaderStore(path);assert.equal(store.getPost('abc')?.body,'Complete archive text');assert.equal(store.getPost('def')?.title,'Missing body');assert.equal(store.bodySync('abc')?.status,'ready');assert.equal(store.bodySync('def')?.status,'pending');assert.deepEqual(store.pendingBodies('python'),['t3_def']);assert.equal(store.getSetting('storageCapBytes'),1_000_000_000);assert.deepEqual(store.followedSources(),['python']);
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});

test('unsupported prototype and future schemas are rejected without rewriting their data',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-schema-rejection-'));
 try{
  for(const version of [0,SCHEMA_VERSION,SCHEMA_VERSION+1]){
   const path=join(directory,`unsupported-${version}.sqlite`),db=new DatabaseSync(path);
   db.exec(`CREATE TABLE preserved(value TEXT); INSERT INTO preserved VALUES ('Keep this data'); PRAGMA user_version=${version};`);db.close();
   const before=await readFile(path);assert.throws(()=>new ReaderStore(path),/Unsupported reader database schema/);assert.deepEqual(await readFile(path),before);
   const check=new DatabaseSync(path,{readOnly:true});try{assert.equal(check.prepare('SELECT value FROM preserved').get()!.value,'Keep this data');}finally{check.close();}
  }
 }finally{await rm(directory,{recursive:true,force:true});}
});

test('a completed scan without boundary evidence is rejected atomically',()=>{
 const store=new ReaderStore(':memory:');try{
  const target=store.addSource({name:'python'});
  assert.throws(()=>store.commitBatch({generation:store.generation,targetId:target,observations:[],continuation:null,status:'done'}),/completion evidence/);
  assert.equal(store.getTarget(target)?.status,'queued');assert.equal(store.feedSync('python').lastSuccessAt,null);
 }finally{store.close();}
});
