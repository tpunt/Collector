import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReaderStore} from '../src/store.ts';
import {VisibleCoverage} from '../ui/read-tracking.ts';
import {DatabaseSync} from 'node:sqlite';

test('reading requires a dwell for every part; scrolling and layout changes cannot fill unseen coverage',()=>{
  const seen=new VisibleCoverage();
  assert.equal(seen.sample(1600,600,0,700,0,800),false);
  assert.equal(seen.sample(1600,600,300,1000,500,800),false);
  assert.equal(seen.sample(1600,600,900,1600,900,800),false);
  assert.equal(seen.sample(1600,600,900,1600,1900,800),false);
  seen.resetDwell();assert.equal(seen.sample(1600,600,0,700,2000,800),false);
  assert.equal(seen.sample(1600,600,0,700,3000,800),false);
  assert.equal(seen.sample(1600,600,650,1350,3100,800),false);
  assert.equal(seen.sample(1600,600,650,1350,4100,800),true);
  assert.equal(seen.sample(1800,600,650,1350,4200,800),false);
  assert.equal(seen.sample(1800,600,650,1350,5200,800),false);
});

test('read status survives refresh/import/restart, composes with pagination and is deleted with content',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'collector-read-')),path=join(directory,'reader.sqlite');let store=new ReaderStore(path);
  const rows=Array.from({length:4},(_,i)=>({id:'read'+i,subreddit:'python',title:'Read fixture '+i,body:'Saved body',permalink:`/r/python/comments/read${i}/`,created:{epochMs:1700000000000+i,precisionMs:1000},source:'archive' as const,exportId:'read-fixture',observedAt:1800000000000,media:['Text' as const]}));
  try{
    store.addSubreddit('python');store.importArchiveBatch(store.generation,rows);
    store.close();const prior=new DatabaseSync(path);prior.exec('DROP TABLE observation_authors; DROP TABLE favourite_posts; DROP TABLE favourite_users; DROP TRIGGER search_insert; DROP TRIGGER search_update; DROP TRIGGER search_delete; DROP TABLE search_index; DROP TABLE search_text; DROP TABLE read_states; PRAGMA user_version=2;');prior.close();store=new ReaderStore(path);
    assert.equal(store.getPost('read1')!.body,'Saved body');assert.equal(store.getPost('read1')!.readAt,null);
    store.setRead('read1',true);const at=store.getPost('read1')!.readAt!;
    assert.deepEqual(store.queryFeed({read:'read'}).posts.map(p=>p.id),['t3_read1']);
    const snapshot=at-1;assert.equal(store.queryFeed({read:'unread',readBefore:snapshot}).posts.length,4);
    const first=store.queryFeed({read:'unread',limit:1});assert(first.next);assert.equal(store.queryFeed({read:'unread',limit:1,cursor:first.next}).posts[0]!.id,'t3_read2');
    store.importArchiveBatch(store.generation,rows.map(p=>({...p,observedAt:1900000000000})));assert.equal(store.getPost('read1')!.readAt,at);
    store.close();store=new ReaderStore(path);assert.equal(store.getPost('read1')!.readAt,at);
    store.setRead('read1',false);assert.equal(store.queryFeed({read:'unread'}).posts.length,4);
    assert.throws(()=>store.setRead('missing',true),/no longer stored/);assert.throws(()=>store.queryFeed({read:'invalid'}),/Invalid read/);
    store.setRead('read1',true);store.deletePost('read1');assert.equal(store.queryFeed({read:'read'}).posts.length,0);
    store.setRead('read0',true);store.clearSubreddit('python');assert.equal(store.queryFeed({read:'read'}).posts.length,0);
  }finally{store.close();await rm(directory,{recursive:true,force:true});}
});


test('cards that fit the viewport require one complete view; resize resets tall-card coverage',()=>{
 const seen=new VisibleCoverage();
 for(const [top,bottom,time] of [[0,300,0],[0,300,1100],[200,500,1200],[200,500,2300]])assert.equal(seen.sample(500,600,top!,bottom!,time!,800),false);
 assert.equal(seen.sample(500,600,0,500,2400,800),false);assert.equal(seen.sample(500,600,0,500,3500,800),true);
 const resized=new VisibleCoverage();assert.equal(resized.sample(1600,600,0,800,0,800),false);assert.equal(resized.sample(1600,600,0,800,1100,800),false);
 assert.equal(resized.sample(1600,600,800,1600,1200,900),false);assert.equal(resized.sample(1600,600,800,1600,2300,900),false);
});
