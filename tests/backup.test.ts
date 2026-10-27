import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,mkdir,writeFile,stat,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,basename} from 'node:path';
import {Readable} from 'node:stream';
import tar from 'tar-stream';
import {Encrypter} from 'age-encryption';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {ReaderStore} from '../src/store.ts';
import {MediaCache} from '../src/media.ts';
import {RequestQueue} from '../src/request-gate.ts';
import {LibraryBackups,recoverLibraryRestore} from '../src/library-backup.ts';
import {SCHEMA_VERSION} from '../src/schema.ts';
import {redditAuthor} from '../src/reddit-author.ts';

const secret='backup test passphrase';
const post=(id='abc')=>({id,subreddit:'python',title:'Private library title',author:redditAuthor('Backup_Author'),body:'Offline body sentinel',permalink:`/r/python/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,exportId:'backup-test',observedAt:1800000000000,media:['Image' as const,'Text' as const],attachments:[{kind:'image' as const,url:'https://i.redd.it/backup.jpg'}]});
async function setup(){
 const root=await mkdtemp(join(tmpdir(),'collector-backup-')),database=join(root,'reader.sqlite'),mediaDirectory=join(root,'media'),work=join(root,'work'),store=new ReaderStore(database);
 store.addSubreddit('python');store.importArchiveBatch(store.generation,[post(),post('spam')]);store.setRead('abc',true);store.setPostFavourite('abc',true);store.setUserFavourite(redditAuthor('Backup_Author')!,true);store.deletePost('spam');store.setHistoryLimit('python',3);store.bindAccount('fixture_user');
 const media=new MediaCache(store,{directory:mediaDirectory,queue:new RequestQueue({intervalMs:0}),onAccess:()=>assert.fail(),fetch:async()=>new Response(new ReadableStream({start(controller){for(let i=0;i<8;i++)controller.enqueue(new Uint8Array(1024*1024).fill(i));controller.close();}}),{headers:{'Content-Type':'image/jpeg'}})});
 await media.initialize();await media.syncPost('abc','backup',1,new AbortController().signal);
 const backups=new LibraryBackups(store,media,work,mediaDirectory,10);
 return{root,database,mediaDirectory,work,store,media,backups,async close(){await backups.close();await media.close();store.close();await rm(root,{recursive:true,force:true});}};
}

test('encrypted streaming backup restores owned media, preferences, exclusions and reads without cookies or collection',async()=>{
 const h=await setup();
 try{
  const backup=await h.backups.create(secret),file=h.backups.download(backup.id);assert(backup.bytes>8*1024*1024);
  const raw=await readFile(file.path);assert(raw.subarray(0,23).toString().startsWith('age-encryption.org/v1'));assert(!raw.includes(Buffer.from('Offline body sentinel')));
  h.store.importArchiveBatch(h.store.generation,[post('later')]);const preview=await h.backups.prepare(createReadStream(file.path),secret);assert.equal(preview.posts,1);assert.equal(preview.files,1);assert(h.store.getPost('later'));
  await h.backups.discard(preview.id);assert(h.store.getPost('later'));
  const replacement=await h.backups.prepare(createReadStream(file.path),secret);h.store.setStorageLimit(1_000_000);await assert.rejects(h.backups.restore(replacement.id),/storage cap/);assert(h.store.getPost('later'));h.store.setStorageLimit(10_000_000_000);await h.backups.restore(replacement.id);
  assert.equal(h.store.getPost('later'),null);assert.equal(h.store.getPost('abc')!.body,'Offline body sentinel');assert.notEqual(h.store.getPost('abc')!.readAt,null);assert.equal(h.store.getHistoryPreference('python').months,3);assert.equal(h.store.getPost('abc')!.favourite,true);assert.equal(h.store.getPost('abc')!.favouriteUser,true);assert.equal(h.store.getPost('abc')!.author?.name,'Backup_Author');
  assert(h.store.isPostExcluded('spam'));assert.equal(h.store.getSetting('account'),null);assert.equal((await h.media.items('abc'))[0]!.state,'ready');assert.equal(h.media.status.requests,1);
  assert.equal((await stat((await h.media.items('abc'))[0]!.localPath!)).size,8*1024*1024);assert.equal(h.store.queryFeed({read:'read'}).posts.length,1);
 }finally{await h.close();}
});

test('wrong passwords, corruption, truncation and cap failures never publish staged content',async()=>{
 const h=await setup();
 try{
  const backup=await h.backups.create(secret),raw=await readFile(h.backups.download(backup.id).path),before=h.store.getPost('abc');
  await assert.rejects(h.backups.prepare(Readable.from([raw]),'wrong password'));
  await assert.rejects(h.backups.prepare(Readable.from([raw.subarray(0,raw.length-1)]),secret));
  const corrupt=Buffer.from(raw);corrupt[corrupt.length-1]^=1;await assert.rejects(h.backups.prepare(Readable.from([corrupt]),secret));
  await assert.rejects(h.backups.prepare(Readable.from((async function*(){yield raw.subarray(0,256*1024);throw new Error('Interrupted backup stream');})()),secret));
  h.store.setStorageLimit(1_000_000);await assert.rejects(h.backups.prepare(Readable.from([raw]),secret),/storage cap/);
  assert.deepEqual(h.store.getPost('abc'),before);assert.equal(h.store.getSetting('account'),'fixture_user');assert.equal((await h.media.items('abc'))[0]!.state,'ready');
 }finally{await h.close();}
});

test('authenticated archives still reject unsafe paths and non-file entries',async()=>{
 const h=await setup();
 try{
  for(const unsafe of ['../escape','/absolute','media/../../escape']){
   const pack=tar.pack(),manifest=JSON.stringify({format:'Collector',version:1,schema:SCHEMA_VERSION,files:[{name:unsafe,bytes:1,sha256:'0'.repeat(64)}]});pack.entry({name:'manifest.json'},manifest);pack.finalize();
   const e=new Encrypter();e.setScryptWorkFactor(10);e.setPassphrase(secret);const bytes=await e.encrypt(Readable.toWeb(Readable.from(pack)) as ReadableStream<Uint8Array>);
   await assert.rejects(h.backups.prepare(Readable.fromWeb(bytes as any),secret),/Invalid backup file index/);
  }
  const pack=tar.pack();pack.entry({name:'manifest.json'},JSON.stringify({format:'Collector',version:1,schema:SCHEMA_VERSION,files:[{name:'reader.sqlite',bytes:0,sha256:'0'.repeat(64)}]}));pack.entry({name:'reader.sqlite',type:'symlink',linkname:'../outside'});pack.finalize();
  const encryption=new Encrypter();encryption.setScryptWorkFactor(10);encryption.setPassphrase(secret);const stream=await encryption.encrypt(Readable.toWeb(Readable.from(pack)) as ReadableStream<Uint8Array>);
  await assert.rejects(h.backups.prepare(Readable.fromWeb(stream as any),secret),/non-file/);
  assert.equal(h.store.stats().posts,1);assert.equal(h.store.getSetting('account'),'fixture_user');
 }finally{await h.close();}
});



test('a failed publication rolls the database and media back before accepting more operations',async()=>{
 const h=await setup();
 try{
  const backup=await h.backups.create(secret);h.store.importArchiveBatch(h.store.generation,[post('later')]);
  const prepared=await h.backups.prepare(createReadStream(h.backups.download(backup.id).path),secret);const reload=h.media.reload.bind(h.media);let calls=0;
  h.media.reload=async()=>{if(calls++===0)throw new Error('Fixture disk failure');await reload();};
  await assert.rejects(h.backups.restore(prepared.id),/Fixture disk failure/);assert(h.store.getPost('later'));assert.equal(h.store.getSetting('account'),'fixture_user');assert.equal((await h.media.items('abc'))[0]!.state,'ready');assert.equal(h.backups.recoveryRequired,false);
 }finally{await h.close();}
});

test('a rollback-snapshot disk failure preserves the current library and a retryable validation ticket',async()=>{
 const h=await setup();
 try{
  const backup=await h.backups.create(secret);h.store.importArchiveBatch(h.store.generation,[post('later')]);
  const prepared=await h.backups.prepare(createReadStream(h.backups.download(backup.id).path),secret),snapshot=h.store.snapshot.bind(h.store);
  h.store.snapshot=async()=>{throw new Error('No space left on device');};
  await assert.rejects(h.backups.restore(prepared.id),/No space/);assert(h.store.getPost('later'));assert.equal(h.backups.recoveryRequired,false);
  h.store.snapshot=snapshot;await h.backups.restore(prepared.id);assert.equal(h.store.getPost('later'),null);assert.equal((await h.media.items('abc'))[0]!.state,'ready');
 }finally{await h.close();}
});

test('startup recovers an interrupted database/media replacement before opening the library',async()=>{
 const root=await mkdtemp(join(tmpdir(),'collector-recovery-')),path=join(root,'reader.sqlite'),work=join(root,'work'),stage=join(work,'stage-fixture'),media=join(root,'media');let store=new ReaderStore(path);
 try{
  store.addSubreddit('python');store.importArchiveBatch(store.generation,[post()]);await mkdir(stage,{recursive:true});await store.snapshot(join(stage,'previous.sqlite'));
  store.importArchiveBatch(store.generation,[post('later')]);store.close();await mkdir(join(stage,'previous-media'));await writeFile(join(stage,'previous-media','kept'),'Old media');await mkdir(media);await writeFile(join(media,'partial'),'New media');
  await writeFile(join(work,'restore.json'),JSON.stringify({stage:'stage-fixture',committed:false}));recoverLibraryRestore(path,media,work);store=new ReaderStore(path);
  assert(store.getPost('abc'));assert.equal(store.getPost('later'),null);assert.equal(await readFile(join(media,'kept'),'utf8'),'Old media');
 }finally{store.close();await rm(root,{recursive:true,force:true});}
});

for(const schema of [3,4])test(`published version-${schema} backups upgrade only in staging and preserve saved content`,async()=>{
 const h=await setup();
 try{
  const path=join(h.root,'legacy.sqlite');await h.store.snapshot(path);const old=new DatabaseSync(path);
  old.exec("DROP TABLE observation_authors; DROP TABLE favourite_posts; DROP TABLE favourite_users;"+(schema===3?"DROP TRIGGER search_insert; DROP TRIGGER search_update; DROP TRIGGER search_delete; DROP TABLE search_index; DROP TABLE search_text;":"")+"UPDATE media_sync SET status='pending'; PRAGMA user_version="+schema+";");old.close();
  const raw=await readFile(path),manifest=JSON.stringify({format:'Collector',version:1,schema,files:[{name:'reader.sqlite',bytes:raw.length,sha256:createHash('sha256').update(raw).digest('hex')}]});
  const pack=tar.pack();pack.entry({name:'manifest.json'},manifest);pack.entry({name:'reader.sqlite'},raw);pack.finalize();
  const encryption=new Encrypter();encryption.setPassphrase(secret);encryption.setScryptWorkFactor(10);const bytes=await encryption.encrypt(Readable.toWeb(Readable.from(pack)) as ReadableStream<Uint8Array>);
  const preview=await h.backups.prepare(Readable.fromWeb(bytes as any),secret);assert.equal(h.store.getSetting('account'),'fixture_user');await h.backups.restore(preview.id);
  assert.equal(h.store.queryFeed({text:'sentinel',scope:'body'}).posts[0]!.id,'t3_abc');assert.notEqual(h.store.getPost('abc')!.readAt,null);assert.equal(h.store.getSetting('account'),null);
 }finally{await h.close();}
});

test('restore validation can be cancelled after upload finishes without publishing a ticket',async()=>{
 const h=await setup();
 try{
  const backup=await h.backups.create(secret),controller=new AbortController(),validate=h.store.validateBackup.bind(h.store);
  h.store.validateBackup=(...args)=>{const result=validate(...args);controller.abort();return result;};
  await assert.rejects(h.backups.prepare(createReadStream(h.backups.download(backup.id).path),secret,controller.signal),{name:'AbortError'});
  assert.equal(h.store.stats().posts,1);assert.equal(h.store.getSetting('account'),'fixture_user');assert.equal((await h.media.items('abc'))[0]!.state,'ready');
  assert.deepEqual(await readdir(h.work),[basename(h.backups.download(backup.id).directory)]);
 }finally{await h.close();}
});

test('portable restore keeps the destination cap and reclaims the previous database allocation',async()=>{
 const h=await setup();
 try{
  h.store.setStorageLimit(1_000_000);const backup=await h.backups.create(secret);
  h.store.setStorageLimit(100_000_000);h.store.importArchiveBatch(h.store.generation,Array.from({length:80},(_,index)=>({...post('large'+index),body:'x'.repeat(64_000),media:['Text' as const],attachments:[]})));
  const destinationCap=16_000_000;assert(h.store.storage.usedBytes>destinationCap);h.store.setStorageLimit(destinationCap);
  const staged=await h.backups.prepare(createReadStream(h.backups.download(backup.id).path),secret);await h.backups.restore(staged.id);
  assert.equal(h.store.storageLimit,destinationCap);assert.equal(h.store.storage.full,false);assert.equal(h.store.stats().posts,1);assert.equal((await h.media.items('abc'))[0]!.state,'ready');assert.equal(h.store.compactionWarning,null);
 }finally{await h.close();}
});
