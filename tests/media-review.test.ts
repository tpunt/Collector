import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReaderStore} from '../src/store.ts';
import {postMediaReferences,mediaReferences} from '../src/media-reference.ts';
import type {MediaKind,PostObservation,Availability} from '../src/domain.ts';

test('combined Media filter includes images, videos and discovered attachments with no duplicates, and composes with pagination, source and search',()=>{
 const store=new ReaderStore(':memory:');try{
  store.addSubreddit('aww');store.addSubreddit('python');
  const record=(id:string,media:MediaKind[],subreddit='aww',availability:Availability='available'):PostObservation=>({id,subreddit,title:'Media fixture '+id,body:id==='text'?'text-only sentinel':'Caption '+id,permalink:`/r/${subreddit}/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'combined-filter',observedAt:1800000000000,media,availability});
  store.importArchiveBatch(store.generation,[record('text',['Text']),record('image',['Image']),record('video',['Video']),record('mixed',['Text','Image','Video']),record('link',['Link']),record('discover',['Unknown']),record('gone',['Image'],'aww','removed'),record('other',['Image'],'python')]);
  store.saveMediaReferences(store.generation,'discover',[{kind:'video',url:'https://i.imgur.com/discovered.mp4'}]);
  const ids:string[]=[];let cursor:string|undefined;
  do{const page=store.queryFeed({media:'Media',limit:2,cursor});ids.push(...page.posts.map(post=>post.id));cursor=page.next??undefined;}while(cursor);
  assert.deepEqual(ids.sort(),['t3_discover','t3_image','t3_mixed','t3_other','t3_video']);assert.equal(new Set(ids).size,ids.length);
  assert.equal(store.queryFeed({media:'Media',subreddit:'aww'}).posts.length,4);
  assert.equal(store.queryFeed({media:'Media',text:'text-only sentinel'}).posts.length,0);
  assert.deepEqual(store.queryFeed({media:'Media',subreddit:'aww',text:'Caption mixed'}).posts.map(post=>post.id),['t3_mixed']);
  assert.equal(store.queryFeed({media:'Image',subreddit:'aww'}).posts.length,2);assert.equal(store.queryFeed({media:'Video',subreddit:'aww'}).posts.length,3);
 }finally{store.close();}
});

test('native video references reject posters, low-resolution previews and another video’s manifest',()=>{
 const outbound='https://v.redd.it/mainvideo',manifest=outbound+'/DASHPlaylist.mpd';
 const references=mediaReferences(['https://preview.redd.it/poster.jpg',outbound+'/CMAF_96.mp4','https://v.redd.it/other/DASHPlaylist.mpd',manifest]);
 assert.deepEqual(postMediaReferences(outbound,references),[{kind:'video',url:manifest}]);
 const direct=outbound+'/DASH_720.mp4';assert.deepEqual(postMediaReferences(direct,mediaReferences([direct])),[{kind:'video',url:direct}]);
 const image='https://i.redd.it/image.jpg';assert.deepEqual(postMediaReferences(image,mediaReferences([image])),[{kind:'image',url:image}]);
});

test('media filters use the same accepted attachments as the displayed post',()=>{
 const store=new ReaderStore(':memory:');try{
  store.addSubreddit('aww');
  store.importArchiveBatch(store.generation,[{id:'video',subreddit:'aww',title:'Native video',permalink:'/r/aww/comments/video/',created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'poster-fixture',observedAt:1800000000000,media:['Video'],outbound:'https://v.redd.it/mainvideo',attachments:[{kind:'image',url:'https://preview.redd.it/poster.jpg'}]}]);
  assert.deepEqual(store.getPost('video')?.attachments,[]);assert.equal(store.queryFeed({media:'Image'}).posts.length,0);assert.equal(store.queryFeed({media:'Video'}).posts.length,1);
 }finally{store.close();}
});

test('reading an archived post’s live discussion preserves known media when the thread supplies only text',()=>{
 const store=new ReaderStore(':memory:');
 try{
  store.addSubreddit('aww');
  for(const [id,kind,outbound,url] of [['image','Image','https://i.redd.it/photo.jpg','https://i.redd.it/photo.jpg'],['video','Video','https://v.redd.it/mainvideo','https://v.redd.it/mainvideo/DASHPlaylist.mpd']] as const){
   store.importArchiveBatch(store.generation,[{id,subreddit:'aww',title:'Archived '+kind,permalink:`/r/aww/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'archive-text-fixture',observedAt:1800000000000,body:'Archive caption',media:['Text',kind],outbound,attachments:[{kind:kind==='Image'?'image':'video',url}]}]);
   const previous=store.getPost(id)!;
   store.saveSnapshot(store.generation,{id:'discussion-'+id,postId:previous.id,source:'live',capturedAt:1800000000001,observedAt:1800000000001,sort:'best',body:'Live caption',availability:'available',comments:[],omitted:0,sample:'Fixture'});
   const saved=store.getPost(id)!;
   assert.equal(saved.body,'Live caption');assert.equal(saved.source,'live');assert.deepEqual(saved.media,previous.media);assert.deepEqual(saved.attachments,previous.attachments);assert.equal(saved.outbound,outbound);assert.equal(store.mediaSync(id)?.status,'pending');
   store.saveSnapshot(store.generation,{id:'removed-'+id,postId:previous.id,source:'live',capturedAt:1800000000002,observedAt:1800000000002,sort:'best',body:null,availability:'removed',comments:[],omitted:0,sample:'Fixture'});
   assert.deepEqual(store.getPost(id)?.attachments,[]);assert.equal(store.getPost(id)?.body,null);assert.equal(store.mediaSync(id),null);
  }
 }finally{store.close();}
});
