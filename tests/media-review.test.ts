import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReaderStore} from '../src/store.ts';
import {postMediaReferences,mediaReferences} from '../src/media-reference.ts';
import type {MediaKind,PostObservation,Availability} from '../src/domain.ts';
import {archivePost} from '../src/archive.ts';
import {hasExternalAttachment} from '../src/sources.ts';

test('full live media replacement does not resurrect an old archived player or removed attachment, while archive provenance stays readable',()=>{
 const store=new ReaderStore(':memory:');
 try{
  store.addSubreddit('tumblr:staff');const base={id:'tumblr:staff:12345',subreddit:'tumblr:staff',permalink:'https://www.tumblr.com/staff/12345',title:'Media replacement',created:{epochMs:1700000000000,precisionMs:1000}};
  const archived:PostObservation={...base,source:'archive',exportId:'earlier-copy',observedAt:1,body:'Older caption',media:['Text','Video'],outbound:'https://www.youtube.com/embed/abcDEF12345'};
  store.importArchiveBatch(store.generation,[archived]);store.saveCollectedPost(store.generation,{...base,source:'live',observedAt:2,availability:'available',body:'Complete current caption',bodyNeedsFetch:false,media:['Text','Video'],attachments:[{kind:'video',url:'https://va.media.tumblr.com/current.mp4'}]});
  const video=store.getPost(base.id)!;assert.equal(video.outbound,null);assert.equal(hasExternalAttachment(video),false);assert.equal(video.attachments.length,1);assert.equal(store.queryFeed({media:'Video'}).posts.length,1);
  store.saveCollectedPost(store.generation,{...base,source:'live',observedAt:3,availability:'available',body:'Complete current text only',bodyNeedsFetch:false,media:['Text'],attachments:[]});
  store.importArchiveBatch(store.generation,[{...archived,observedAt:4}]);const text=store.getPost(base.id)!;assert.equal(text.outbound,null);assert.deepEqual(text.attachments,[]);assert.equal(store.mediaSync(base.id),null);assert.equal(store.queryFeed({media:'Video'}).posts.length,0);assert.equal(store.getPost(base.id,'archive')!.outbound,archived.outbound);
  const target=store.createTarget({subreddit:'tumblr:staff',upperMs:1700000001000});store.commitBatch({generation:store.generation,targetId:target,continuation:null,observations:[{...base,source:'live',observedAt:5,bodyNeedsFetch:true,media:['Text'],attachments:[]}]});assert.equal(store.getPost(base.id)!.outbound,null);assert.deepEqual(store.getPost(base.id)!.attachments,[]);
  store.saveMediaReferences(store.generation,base.id,[{kind:'video',url:'https://va.media.tumblr.com/earlier.mp4'}]);assert.equal(store.getPost(base.id)!.attachments.length,1);
  store.commitBatch({generation:store.generation,targetId:target,continuation:null,observations:[{...base,source:'live',observedAt:Date.now()+1,body:'Verified full text',bodyNeedsFetch:false,availability:'available',media:['Text'],attachments:[]}]});assert.deepEqual(store.getPost(base.id)!.attachments,[]);assert.equal(store.mediaSync(base.id),null);
 }finally{store.close();}
});

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

test('a Reddit listing with an empty visible body cannot discard archive or discovered attachments',()=>{
 const store=new ReaderStore(':memory:');
 try{
  store.addSubreddit('aww');const base={id:'abc',subreddit:'aww',permalink:'/r/aww/comments/abc/',title:'Gallery preview',created:{epochMs:1700000000000,precisionMs:1000}};
  store.importArchiveBatch(store.generation,[{...base,source:'archive',exportId:'gallery',observedAt:1,body:'Earlier full caption',media:['Image'],outbound:'https://www.reddit.com/gallery/abc',attachments:[{kind:'image',url:'https://i.redd.it/archived.jpg'}]}]);
  const target=store.createTarget({subreddit:'aww',upperMs:1700000001000});
  const preview:PostObservation={...base,source:'live',observedAt:2,body:'',bodyNeedsFetch:false,media:['Image'],attachments:[]};
  store.commitBatch({generation:store.generation,targetId:target,continuation:null,observations:[preview]});assert.equal(store.getPost('abc')!.outbound,'https://www.reddit.com/gallery/abc');assert.equal(store.getPost('abc')!.attachments[0]!.url,'https://i.redd.it/archived.jpg');
  store.saveMediaReferences(store.generation,'abc',[{kind:'image',url:'https://i.redd.it/discovered.jpg'}]);store.commitBatch({generation:store.generation,targetId:target,continuation:null,observations:[{...preview,observedAt:Date.now()+1}]});assert.equal(store.getPost('abc')!.attachments[0]!.url,'https://i.redd.it/discovered.jpg');
  assert.throws(()=>store.saveCollectedPost(store.generation,{...preview,availability:'available',attachments:undefined,bodyNeedsFetch:undefined}),/Expected complete/);
 }finally{store.close();}
});

test('native video references reject posters, low-resolution previews and another video’s manifest',()=>{
 const outbound='https://v.redd.it/mainvideo',manifest=outbound+'/DASHPlaylist.mpd';
 const references=mediaReferences(['https://preview.redd.it/poster.jpg',outbound+'/CMAF_96.mp4','https://v.redd.it/other/DASHPlaylist.mpd',manifest]);
 assert.deepEqual(postMediaReferences(outbound,references),[{kind:'video',url:manifest}]);
 const direct=outbound+'/DASH_720.mp4';assert.deepEqual(postMediaReferences(direct,mediaReferences([direct])),[{kind:'video',url:direct}]);
 const image='https://i.redd.it/image.jpg';assert.deepEqual(postMediaReferences(image,mediaReferences([image])),[{kind:'image',url:image}]);
});

test('archive gallery metadata must establish the whole ordered set, and native video metadata supplies only observed owned manifests',()=>{
 const row={id:'abc',subreddit:'aww',title:'Archived gallery',created_utc:1700000000,is_gallery:true,url:'https://www.reddit.com/gallery/abc',gallery_data:{items:[{media_id:'one',caption:'Original caption'},{media_id:'two'}]},media_metadata:{one:{status:'valid',e:'Image',s:{u:'https://i.redd.it/one.jpg'}},two:{status:'valid',e:'AnimatedImage',s:{gif:'https://i.redd.it/two.gif'}}}};
 const full=archivePost(row,'aww','gallery-meta',Date.now());assert.equal(full.attachments?.length,2);assert.equal(full.attachments?.[0]?.caption,'Original caption');assert.deepEqual(full.attachments?.map(item=>item.collection?.index),[0,1]);
 const partial=archivePost({...row,media_metadata:{one:row.media_metadata.one}},'aww','gallery-meta',Date.now());assert.deepEqual(partial.attachments,[]);
 const video=archivePost({...row,is_gallery:false,gallery_data:undefined,media_metadata:undefined,url:'https://v.redd.it/mainvideo',is_video:true,secure_media:{reddit_video:{dash_url:'https://v.redd.it/mainvideo/DASHPlaylist.mpd'}}},'aww','video-meta',Date.now());assert.deepEqual(video.attachments,[{kind:'video',url:'https://v.redd.it/mainvideo/DASHPlaylist.mpd'}]);
 const unrelated=archivePost({...row,is_gallery:false,gallery_data:undefined,media_metadata:undefined,url:'https://v.redd.it/mainvideo',is_video:true,secure_media:{reddit_video:{dash_url:'https://v.redd.it/other/DASHPlaylist.mpd'}}},'aww','video-meta',Date.now());assert.deepEqual(unrelated.attachments,[]);
});

test('listing previews and on-demand discussion reads preserve complete saved gallery evidence',()=>{
 const store=new ReaderStore(':memory:');try{
  store.addSubreddit('aww');store.importArchiveBatch(store.generation,[{id:'abc',subreddit:'aww',title:'Gallery',permalink:'/r/aww/comments/abc/',created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'gallery-evidence',observedAt:1800000000000,media:['Image'],outbound:'https://www.reddit.com/gallery/abc'}]);
  const refs=[0,1].map(index=>({kind:'image' as const,url:`https://i.redd.it/gallery${index}.jpg`,collection:{id:'reddit:t3_abc',index,total:2}}));store.saveMediaReferences(store.generation,'abc',refs);store.setMediaSync(store.generation,'abc','ready');
  const target=store.createTarget({subreddit:'aww',upperMs:1800000000001});store.commitBatch({generation:store.generation,targetId:target,observations:[{id:'abc',subreddit:'aww',title:'Gallery',permalink:'/r/aww/comments/abc/',created:{epochMs:1700000000000,precisionMs:1000},source:'live',observedAt:1800000000001,media:['Image'],outbound:'https://www.reddit.com/gallery/abc',attachments:[]}],continuation:null});
  assert.deepEqual(store.getPost('abc')?.attachments,refs);assert.equal(store.mediaSync('abc')?.status,'ready');
  store.saveSnapshot(store.generation,{id:'gallery-comments',postId:'t3_abc',source:'live',capturedAt:null,observedAt:1800000000002,sort:'best',body:null,availability:'available',comments:[],omitted:0,sample:'On-demand discussion'});assert.deepEqual(store.getPost('abc')?.attachments,refs);
 }finally{store.close();}
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
