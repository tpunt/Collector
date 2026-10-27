import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReaderStore} from '../src/store.ts';
import {MediaCache} from '../src/media.ts';
import {RequestQueue} from '../src/request-gate.ts';
import {cleanupCriteria,cleanupPreview,storageBreakdown} from '../src/library-storage.ts';

const shared='https://i.redd.it/shared.jpg';
const record=(id:string,subreddit:string,url=shared,createdMs=Date.parse('2020-01-01'))=>({id,subreddit,title:'Storage '+id,body:'Saved body',permalink:`/r/${subreddit}/comments/${id}/`,created:{epochMs:createdMs,precisionMs:1000},source:'archive' as const,exportId:'cleanup-fixture',observedAt:1800000000000,media:[url.includes('.mp4')?'Video' as const:'Image' as const],attachments:[{kind:url.includes('.mp4')?'video' as const:'image' as const,url}]});

test('storage attributes shared files once; selective deletion preserves every remaining owner and exclusions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'collector-storage-')),store=new ReaderStore(join(root,'reader.sqlite'));for(const name of ['aww','python','old'])store.addSubreddit(name);
 const rows=[record('aaa','aww'),record('aaa2','aww'),record('bbb','python'),record('ccc','aww','https://v.redd.it/fixture/main.mp4',Date.parse('2020-01-03')),record('ddd','old','https://i.redd.it/old.jpg',Date.parse('2021-01-01'))];store.importArchiveBatch(store.generation,rows);let requests=0;
 const media=new MediaCache(store,{directory:join(root,'media'),queue:new RequestQueue({intervalMs:0}),onAccess:()=>assert.fail(),fetch:async url=>{requests++;return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':String(url).includes('.mp4')?'video/mp4':'image/jpeg'}});}});
 try{
  await media.initialize();for(const row of rows)await media.syncPost(row.id,'fixture',10,new AbortController().signal);store.removeSubreddit('old');store.setRead('aaa',true);store.setRead('ccc',true);
  const inventory=await media.inventory(),sizes=storageBreakdown(store,inventory);assert.equal(requests,3);assert.equal(sizes.mediaBytes,inventory.reduce((sum,file)=>sum+file.bytes,0));assert.equal(sizes.feeds.reduce((sum,feed)=>sum+feed.bytes,0),sizes.mediaBytes);assert.equal(sizes.totalBytes,store.storage.usedBytes);assert.equal(sizes.types.reduce((sum,type)=>sum+type.files,0),3);assert.equal(sizes.feeds.find(feed=>feed.feed==='old')!.subscribed,false);
  const one=cleanupPreview(store,inventory,cleanupCriteria({feed:'aww',before:'2020-01-03',readOnly:true}));assert.deepEqual(one.ids,['t3_aaa']);assert.equal(one.files,0);assert.equal(one.sharedFilesKept,1);
  const selected=cleanupPreview(store,inventory,cleanupCriteria({feed:'aww',kind:'Media',before:'2020-01-04',readOnly:true}));assert.equal(selected.posts,2);assert.equal(selected.files,1);assert.equal(selected.sharedFilesKept,1);
  const video=inventory.find(file=>file.kind==='video')!;assert.equal(selected.reclaimableBytes,video.bytes);
  const before=store.getPost('aaa');assert.throws(()=>store.deletePosts(['aaa','missing']),/Post not found/);assert.deepEqual(store.getPost('aaa'),before);assert.equal(store.isPostExcluded('aaa'),false);
  const keys=store.deletePosts(selected.ids);await media.clearPosts(selected.ids,keys);assert.equal(store.stats().posts,3);assert(store.isPostExcluded('aaa'));assert(store.isPostExcluded('ccc'));assert.equal((await media.items('bbb'))[0]!.state,'ready');assert.equal((await media.items('aaa2'))[0]!.state,'ready');assert.equal((await media.inventory()).length,2);assert.equal(requests,3);
  store.importArchiveBatch(store.generation,rows);assert.equal(store.getPost('aaa'),null);assert.equal(store.getPost('ccc'),null);
 }finally{await media.close();store.close();await rm(root,{recursive:true,force:true});}
});

test('invalid cleanup criteria cannot silently broaden the selection',()=>{
 for(const input of [{before:0},{before:false},{before:null},{before:'2020-02-30'},{feed:null},{kind:'unsupported'},{readOnly:'true'}])assert.throws(()=>cleanupCriteria(input));
 assert.equal(cleanupCriteria({}).readOnly,true);assert.equal(cleanupCriteria({before:'2020-01-01'}).beforeMs,Date.parse('2020-01-01T00:00:00Z'));
});

test('size inspection notices missing local files, updates capacity and keeps them resumable without fetching',async()=>{
 const root=await mkdtemp(join(tmpdir(),'collector-storage-missing-')),store=new ReaderStore(':memory:');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[record('aaa','aww')]);let requests=0;
 const media=new MediaCache(store,{directory:join(root,'media'),queue:new RequestQueue({intervalMs:0}),onAccess:()=>assert.fail(),fetch:async()=>{requests++;return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/jpeg'}});}});
 try{
  await media.initialize();await media.syncPost('aaa','first',1,new AbortController().signal);const item=(await media.items('aaa'))[0]!,before=store.storage.usedBytes;await rm(item.localPath!);
  const inventory=await media.inventory();assert(store.storage.usedBytes<before);assert.equal(inventory[0]!.kind,'other');assert.equal(store.mediaSync('aaa')!.status,'pending');assert.equal((await media.items('aaa'))[0]!.state,'idle');assert.equal(requests,1);
  assert.equal(media.preparePost('aaa','resume')!.discover,false);await media.syncPost('aaa','resume',1,new AbortController().signal);assert.equal((await stat((await media.items('aaa'))[0]!.localPath!)).size,3);assert.equal(requests,2);
 }finally{await media.close();store.close();await rm(root,{recursive:true,force:true});}
});
