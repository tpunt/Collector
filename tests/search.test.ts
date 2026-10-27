import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReaderStore} from '../src/store.ts';
import type {PostObservation} from '../src/domain.ts';

const record=(id:string,title:string,body:string,subreddit='python'):PostObservation=>({id,subreddit,title,body,permalink:`/r/${subreddit}/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'search-fixture',observedAt:1800000000000,media:['Text']});
test('literal title/body scopes support Unicode and compose with read, source and cursor filters',()=>{
 const store=new ReaderStore(':memory:');
 try{
  store.addSubreddit('python');store.addSubreddit('aww');store.importArchiveBatch(store.generation,[record('aaa','Needle title','Other body'),record('bbb','Other title','Needle body'),record('ccc','CAFÉ ΩΜΕΓΑ','Literal %_\\" quote\' and café'),record('ddd','Needle elsewhere','Different source','aww')]);
  assert.deepEqual(store.queryFeed({text:'needle',scope:'title',subreddit:'python'}).posts.map(p=>p.id),['t3_aaa']);
  assert.deepEqual(store.queryFeed({text:'needle',scope:'body'}).posts.map(p=>p.id),['t3_bbb']);
  assert.equal(store.queryFeed({text:'needle',scope:'both',subreddit:'python'}).posts.length,2);
  assert.equal(store.queryFeed({text:'cafe\u0301',scope:'title'}).posts[0]!.id,'t3_ccc');
  assert.equal(store.queryFeed({text:'ωμεγα',scope:'title'}).posts[0]!.id,'t3_ccc');
  assert.equal(store.queryFeed({text:'%_\\"',scope:'body'}).posts[0]!.id,'t3_ccc');
  const page=store.queryFeed({text:'needle',scope:'both',subreddit:'python',limit:1});assert(page.next);assert.equal(store.queryFeed({text:'needle',scope:'both',subreddit:'python',limit:1,cursor:page.next}).posts.length,1);
  store.setRead('bbb',true);assert.deepEqual(store.queryFeed({text:'needle',scope:'both',subreddit:'python',read:'read',media:'Text'}).posts.map(p=>p.id),['t3_bbb']);
  assert.throws(()=>store.queryFeed({scope:'comments'}),/Invalid search scope/);assert.throws(()=>store.queryFeed({text:'a'.repeat(501)}),/at most 500/);
 }finally{store.close();}
});

test('body search follows reader-visible provenance and never searches removed or superseded text',()=>{
 const store=new ReaderStore(':memory:');
 try{
  store.addSubreddit('python');store.importArchiveBatch(store.generation,[record('aaa','Title sentinel','Archive fallback sentinel')]);
  const target=store.createTarget({subreddit:'python',upperMs:1800000000000});const live={...record('aaa','Title sentinel',''),source:'live' as const,exportId:undefined,body:undefined,observedAt:1800000000001};
  store.commitBatch({generation:store.generation,targetId:target,observations:[live],continuation:null});
  assert.equal(store.queryFeed({text:'Archive fallback',scope:'body'}).posts.length,1);
  store.savePostBody(store.generation,'aaa','Live replacement sentinel',1800000000002);
  assert.equal(store.queryFeed({text:'Archive fallback',scope:'body'}).posts.length,0);assert.equal(store.queryFeed({text:'Live replacement',scope:'body'}).posts.length,1);
  store.markPostUnavailable(store.generation,'aaa','removed',1800000000003);assert.equal(store.queryFeed({text:'Live replacement',scope:'body'}).posts.length,0);assert.equal(store.queryFeed({text:'Title sentinel',scope:'title'}).posts.length,1);
 }finally{store.close();}
});

test('broad indexed terms never truncate later matches when combined with source and read filters',()=>{
 const store=new ReaderStore(':memory:');
 try{
  store.addSubreddit('python');store.addSubreddit('aww');store.importArchiveBatch(store.generation,Array.from({length:650},(_,i)=>record('post'+i,'Indexed '+i,'Common phrase',i===649?'aww':'python')));
  store.setRead('post649',true);assert.equal(store.queryFeed({text:'common',scope:'body',subreddit:'aww',read:'read'}).posts[0]!.id,'t3_post649');
  const page=store.queryFeed({text:'common',scope:'both',limit:50});assert.equal(page.posts.length,50);assert(page.next);assert.equal(store.queryFeed({text:'common',scope:'both',cursor:page.next,limit:50}).posts.length,50);
 }finally{store.close();}
});
