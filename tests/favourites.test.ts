import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {ReaderStore} from '../src/store.ts';
import {archivePost} from '../src/archive.ts';
import {redditAuthor,redditDomAuthor} from '../src/reddit-author.ts';
import {authorIdentity} from '../src/authors.ts';
import type {PostObservation} from '../src/domain.ts';
const alice=redditAuthor('Alice_Example')!,bob=redditAuthor('Bob_Example')!;
const record=(id:string,author=alice,subreddit='python',time=1700000000)=>archivePost({id,subreddit,author:author.name,title:'Saved '+id,selftext:'Complete body '+id,created_utc:time,is_self:true},subreddit,'favourite-fixture',1800000000000);
const ids=(store:ReaderStore,filter:Parameters<ReaderStore['queryFeed']>[0])=>store.queryFeed(filter).posts.map(post=>post.id);

test('author extraction validates rendered profile identity, normalizes Reddit identity and excludes deleted/unknown users',()=>{
 assert.equal(redditAuthor('ALICE_Example')!.id,alice.id);assert.equal(redditAuthor('[deleted]'),null);assert.equal(redditAuthor(undefined),undefined);assert.equal(redditAuthor('bad/name'),undefined);
 assert.deepEqual(redditDomAuthor({name:'Alice_Example',href:'https://old.reddit.com/user/alice_example/'}),alice);
 for(const href of ['https://example.com/user/Alice_Example','/user/Bob_Example','javascript:alert(1)',null])assert.equal(redditDomAuthor({name:'Alice_Example',href}),undefined);
 assert.equal(redditDomAuthor({name:'[deleted]',href:null}),null);
 assert.throws(()=>authorIdentity({platform:'reddit',id:'bad\nidentity',name:'Alice'}),/Invalid author/);
});

test('favourites compose with paging, search, read/media and subreddit filters and include retained unsubscribed content',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');store.addSubreddit('aww');
 try{
  store.importArchiveBatch(store.generation,[record('abc'),record('def',alice,'aww',1700000001),{...record('ghi',bob,'python',1700000002),media:['Image'],body:undefined}]);
  assert.throws(()=>store.setPostFavourite('missing',true),/no longer stored/);assert.throws(()=>store.setPostFavourite('abc','yes'),/Invalid favourite/);
  store.setPostFavourite('abc',true);store.setPostFavourite('abc',true);store.setPostFavourite('def',true);store.setUserFavourite(alice,true);store.setRead('abc',true);
  assert.equal(store.favourites().posts,2);assert.deepEqual(ids(store,{favourites:'posts'}),['t3_def','t3_abc']);assert.deepEqual(ids(store,{favourites:'users'}),['t3_def','t3_abc']);
  assert.deepEqual(ids(store,{favourites:'posts',subreddit:'python',text:'Complete',scope:'body',read:'read',readBefore:Date.now()+1,media:'Text'}),['t3_abc']);assert.deepEqual(ids(store,{favourites:'users',media:'Image'}),[]);
  const page=store.queryFeed({favourites:'users',limit:1});assert.deepEqual(page.posts.map(post=>post.id),['t3_def']);assert.deepEqual(ids(store,{favourites:'users',limit:1,cursor:page.next!}),['t3_abc']);
  store.removeSubreddit('python');assert.deepEqual(ids(store,{}),['t3_def']);assert.deepEqual(ids(store,{favourites:'posts'}),['t3_def','t3_abc']);
  store.setPostFavourite('abc',false);assert.deepEqual(ids(store,{favourites:'posts'}),['t3_def']);assert.equal(store.getPost('abc')!.favourite,false);
  store.setUserFavourite(alice,false);assert.deepEqual(ids(store,{favourites:'users'}),[]);assert(store.getPost('abc'));assert.equal(store.getPost('abc')!.favouriteUser,false);
  assert.throws(()=>store.queryFeed({favourites:'invalid'}),/Invalid favourites/);assert.throws(()=>store.queryFeed({authorId:'alice'}),/Invalid author/);
 }finally{store.close();}
});

test('author evidence follows observation precedence; explicit deletion and late observations cannot resurrect authors',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');
 try{
  const first=record('abc');store.importArchiveBatch(store.generation,[first]);store.setUserFavourite(alice,true);
  store.importArchiveBatch(store.generation,[{...first,exportId:'unknown-author',observedAt:1800000000001,author:undefined}]);assert.deepEqual(store.getPost('abc')!.author,alice);
  const target=store.createTarget({subreddit:'python',upperMs:1900000000000});const saveLive=(observation:PostObservation)=>store.commitBatch({generation:store.generation,targetId:target,observations:[observation],continuation:null});
  const live={...first,source:'live' as const,exportId:undefined,observedAt:1800000000001,author:undefined};saveLive(live);assert.deepEqual(store.getPost('abc')!.author,alice);assert.equal(store.getPost('abc')!.favouriteUser,true);
  saveLive({...live,observedAt:1800000000002,author:null});assert.equal(store.getPost('abc')!.author,null);assert.deepEqual(ids(store,{favourites:'users'}),[]);
  saveLive({...live,author:alice});assert.equal(store.getPost('abc')!.author,null);
  store.savePostBody(store.generation,'abc','Rechecked body',1800000000003,bob);assert.deepEqual(store.getPost('abc')!.author,bob);
  store.setUserFavourite(bob,true);saveLive({...live,author:bob,observedAt:1800000000004,availability:'deleted'});assert.equal(store.getPost('abc')!.author,null);assert.deepEqual(ids(store,{favourites:'users'}),[]);
  store.importArchiveBatch(store.generation,[{...first,observedAt:1800000000005}]);assert.equal(store.getPost('abc')!.author,null);
 }finally{store.close();}
});

test('favourite users are platform-scoped and include new posts automatically; deletion and Clear keep preferences but remove post favourites',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');store.addSubreddit('aww');
 try{
  store.importArchiveBatch(store.generation,[record('abc'),record('def',alice,'aww')]);store.setUserFavourite({...alice,platform:'another-source'},true);assert.deepEqual(ids(store,{favourites:'users'}),[]);
  store.setUserFavourite(alice,true);store.setPostFavourite('abc',true);store.setPostFavourite('def',true);store.importArchiveBatch(store.generation,[record('new',alice,'aww',1700000002)]);assert.equal(store.queryFeed({favourites:'users',authorPlatform:'reddit',authorId:alice.id}).posts.length,3);
  store.deletePost('abc');assert.equal(store.favourites().posts,1);assert(store.isPostExcluded('abc'));
  store.clearSubreddit('python');assert.equal(store.favourites().posts,1);assert.equal(store.favouriteUsers().length,2);
  store.clearContent();assert.equal(store.favourites().posts,0);assert.equal(store.favouriteUsers().length,2);assert.deepEqual(ids(store,{favourites:'users'}),[]);
  store.importArchiveBatch(store.generation,[record('later')]);assert.equal(store.getPost('later')!.favouriteUser,true);assert.equal(store.getPost('later')!.favourite,false);
 }finally{store.close();}
});

test('author-only discussion evidence cannot reinstate a removed post without a newly available body',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');
 try{
  store.importArchiveBatch(store.generation,[record('abc')]);store.markPostUnavailable(store.generation,'abc','removed',1800000000001);
  const snapshot={id:'author-only',postId:'t3_abc',source:'live' as const,observedAt:1800000000002,capturedAt:null,body:null,author:bob,availability:'available' as const,sort:'best',comments:[],omitted:0,sample:'Author-only fixture'};
  store.saveSnapshot(store.generation,snapshot);assert.equal(store.getPost('abc')!.availability,'removed');assert.equal(store.getPost('abc')!.body,null);assert.deepEqual(store.getPost('abc')!.author,alice);
  store.saveSnapshot(store.generation,{...snapshot,id:'reinstated',observedAt:1800000000003,body:'Explicitly visible reinstated text'});assert.equal(store.getPost('abc')!.availability,'available');assert.deepEqual(store.getPost('abc')!.author,bob);
 }finally{store.close();}
});

test('version-four libraries upgrade without losing content or reads and favourites survive a real restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'collector-favourites-')),path=join(directory,'reader.sqlite');let store=new ReaderStore(path);
 try{
  store.addSubreddit('python');store.importArchiveBatch(store.generation,[record('abc')]);store.setRead('abc',true);store.close();
  const old=new DatabaseSync(path);old.exec('DROP TABLE observation_authors; DROP TABLE favourite_posts; DROP TABLE favourite_users; PRAGMA user_version=4;');old.close();
  store=new ReaderStore(path);assert.equal(store.getPost('abc')!.author,null);assert.notEqual(store.getPost('abc')!.readAt,null);assert.equal(store.getPost('abc')!.body,'Complete body abc');
  store.importArchiveBatch(store.generation,[record('abc')]);store.setPostFavourite('abc',true);store.setUserFavourite(alice,true);store.close();store=new ReaderStore(path);
  assert.equal(store.getPost('abc')!.favourite,true);assert.equal(store.getPost('abc')!.favouriteUser,true);assert.equal(store.getPost('abc')!.body,'Complete body abc');
  assert.equal(store.queryFeed({favourites:'posts'}).posts.length,1);assert.equal(store.queryFeed({favourites:'users'}).posts.length,1);
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});
