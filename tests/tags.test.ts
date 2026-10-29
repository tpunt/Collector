import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReaderStore} from '../src/store.ts';
import {cleanupCriteria} from '../src/library-storage.ts';
import {tagName,postTags} from '../src/tags.ts';
import {feedName,feedIdentity,tumblrBlog,tumblrUrl,validateListingUrl,tumblrResourceAllowed,listingUrl,tumblrPostUrl,tumblrArchiveUrl,tumblrContentUrl} from '../src/sources.ts';
import {postId,validateObservation} from '../src/domain.ts';
const record=(id:string,feed='aww')=>({id,subreddit:feed,title:'Photo '+id,body:'A complete caption',author:{platform:'reddit',id:'alice',name:'Alice'},permalink:`/r/${feed}/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,exportId:'tags',observedAt:1800000000000,media:['Image' as const],attachments:[{kind:'image' as const,url:'https://i.redd.it/photo.jpg'}]});

test('local tags compose with source, media, search, read, favourites and cursor filters without losing media',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('aww');store.addSubreddit('python');
 try{
  store.importArchiveBatch(store.generation,[record('aaa'),record('bbb'),record('ccc','python')]);
  for(const id of ['aaa','bbb','ccc'])store.setPostTags(id,[' Cats ','cats','Inspiration']);
  assert.deepEqual(store.getPost('aaa')!.tags,['cats','inspiration']);assert.deepEqual(store.tags(),[{name:'cats',posts:3},{name:'inspiration',posts:3}]);
  store.setRead('aaa',true);store.setPostFavourite('aaa',true);
  const filter={tag:'CATS',media:'Image' as const,subreddit:'aww',text:'caption',scope:'body',read:'read',favourites:'posts'};
  const page=store.queryFeed(filter);assert.deepEqual(page.posts.map(post=>post.id),['t3_aaa']);assert.equal(page.posts[0]!.attachments.length,1);
  const first=store.queryFeed({tag:'cats',media:'Media',limit:1});assert(first.next);assert.equal(store.queryFeed({tag:'cats',media:'Media',cursor:first.next!,limit:1}).posts[0]!.id,'t3_bbb');
  store.importArchiveBatch(store.generation,[{...record('aaa'),observedAt:1900000000000}]);assert.deepEqual(store.getPost('aaa')!.tags,['cats','inspiration']);
  store.setPostTags('aaa',[]);assert.deepEqual(store.getPost('aaa')!.tags,[]);store.deletePost('bbb');store.clearSubreddit('python');assert.deepEqual(store.tags(),[]);
  assert.throws(()=>store.setPostTags('missing',['cats']),/no longer stored/);
 }finally{store.close();}
});
test('tag validation normalizes labels and rejects malformed or unbounded updates atomically',()=>{
 assert.equal(tagName('  ＣＡＴＳ   & Dogs '),'cats & dogs');assert.deepEqual(postTags(['Cats','cats']),['cats']);
 for(const value of ['',null,1,'x'.repeat(61),'bad\u0000tag'])assert.throws(()=>tagName(value));
 assert.throws(()=>postTags('cats'));assert.throws(()=>postTags(Array(51).fill('cats')));
});
test('bulk read includes every matching page and preserves nonmatching posts and manual unread',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('aww');
 try{
  store.importArchiveBatch(store.generation,Array.from({length:121},(_,index)=>record('p'+index)));
  for(let index=0;index<120;index++)store.setPostTags('p'+index,['review']);
  assert.equal(store.markFeedRead({tag:'review',media:'Image',read:'unread',readBefore:Date.now()},store.generation),120);
  assert.equal(store.queryFeed({read:'unread'}).posts.length,1);assert.equal(store.getPost('p120')!.readAt,null);
  store.setRead('p1',false);assert.equal(store.queryFeed({tag:'review',read:'unread'}).posts.length,1);
  const old=store.generation;store.clearContent();assert.throws(()=>store.markFeedRead({},old),/cleared/);
 }finally{store.close();}
});
test('cleanup protects post favourites by default and the explicit checkbox includes them without protecting every favourite author',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('aww');
 try{
  store.importArchiveBatch(store.generation,[record('aaa'),record('bbb')]);store.setPostFavourite('aaa',true);store.setUserFavourite(record('aaa').author,true);
  assert.deepEqual(store.cleanupIds(cleanupCriteria({readOnly:false})),['t3_bbb']);
  assert.deepEqual(store.cleanupIds(cleanupCriteria({readOnly:false,excludeFavourites:false})),['t3_bbb','t3_aaa']);
  assert.throws(()=>cleanupCriteria({excludeFavourites:'false'}));
 }finally{store.close();}
});
test('Tumblr feed and item keys are disjoint from Reddit, scoped to the blog, and reject arbitrary hosts, redirects and APIs',()=>{
 assert.equal(feedName('tumblr:staff'),'tumblr:staff');assert.equal(feedIdentity('staff').key,'reddit:staff');assert.equal(feedIdentity('tumblr:staff').key,'tumblr:staff');
 assert.equal(tumblrBlog('https://www.tumblr.com/staff'),'staff');assert.equal(tumblrBlog('@staff'),'staff');
 assert.equal(postId('tumblr:staff:12345678901234567890'),'tumblr:staff:12345678901234567890');
 for(const url of ['https://evil.test/','https://staff.tumblr.com/api/read/json','https://www.tumblr.com/other','https://staff.tumblr.com/page/2?before=1','https://staff.tumblr.com:444/page/2','https://staff.tumblr.com@evil.test/'])assert.throws(()=>tumblrUrl(url,'staff',true));
 assert.equal(validateListingUrl('https://staff.tumblr.com/page/2','tumblr:staff').pathname,'/page/2');
 assert.equal(listingUrl('tumblr:staff'),'https://www.tumblr.com/staff');
 assert.equal(tumblrPostUrl('tumblr:staff:12345'),'https://www.tumblr.com/staff/12345');
 assert.equal(validateListingUrl('https://www.tumblr.com/staff','tumblr:staff').pathname,'/staff');
 assert.equal(tumblrUrl('https://www.tumblr.com/staff/12345/title','staff').pathname,'/staff/12345/title');
 for(const url of ['https://www.tumblr.com/staff/12345?x=1','https://www.tumblr.com/other/12345','https://www.tumblr.com/staff/api','https://www.tumblr.com/staff/12345/extra/path'])assert.throws(()=>tumblrUrl(url,'staff'));

 const post={...record('12345'),id:'tumblr:staff:12345',subreddit:'tumblr:staff',permalink:'https://staff.tumblr.com/post/12345/example'};
 assert.equal(validateObservation(post).permalink,'https://staff.tumblr.com/post/12345/');assert.equal(validateObservation({...post,permalink:'https://www.tumblr.com/staff/12345/title'}).permalink,'https://www.tumblr.com/staff/12345');assert.throws(()=>validateObservation({...post,subreddit:'tumblr:other'}));assert.throws(()=>validateObservation({...post,id:'t3_abc'}));
});
test('Tumblr browser resources cannot dispatch legacy API frames, unrelated blogs, scripts or external trackers',()=>{
 assert(tumblrResourceAllowed('https://staff.tumblr.com/page/2','Document','staff'));
 assert(tumblrResourceAllowed('https://www.tumblr.com/staff','Document','staff'));
 assert(tumblrResourceAllowed('https://www.tumblr.com/staff/12345/title','Document','staff'));
 assert.equal(tumblrResourceAllowed('https://www.tumblr.com/other/12345','Document','staff'),false);
 assert(tumblrResourceAllowed('https://staff.tumblr.com/post/12345/example','Document','staff'));
 assert(tumblrResourceAllowed('https://assets.tumblr.com/theme.css?v=1','Stylesheet','staff'));
 for(const [url,type] of [['https://staff.tumblr.com/api/read/json','Document'],['https://api.tumblr.com/v2/blog/staff/posts','Document'],['https://other.tumblr.com/','Document'],['https://staff.tumblr.com/','Script'],['https://staff.tumblr.com/','XHR'],['https://staff.tumblr.com/api/read/json','Stylesheet'],['https://evil.test/track.css','Stylesheet'],['http://staff.tumblr.com/','Document']])assert.equal(tumblrResourceAllowed(url!,type!,'staff'),false);
 assert.equal(tumblrResourceAllowed('https://staff.tumblr.com/','Document',null),false);
});


test('Tumblr native frames require explicit navigation and remain bound to their blog and post',()=>{
 const frame='https://staff.tumblr.com/photoset_iframe/12345/token/500/';
 assert.equal(tumblrResourceAllowed(frame,'Document','staff'),false);
 assert(tumblrResourceAllowed(frame,'Document','staff',frame));
 assert.equal(tumblrResourceAllowed(frame.replace('staff','other'),'Document','staff',frame),false);
 assert.equal(tumblrResourceAllowed('https://www.tumblr.com/video/staff/12345/500/','Document','staff',frame),false);
});

test('documented Tumblr archives require an explicit same-blog navigation and are never normal listings',()=>{
 const archive='https://staff.tumblr.com/archive';assert.equal(tumblrArchiveUrl(archive,'tumblr:staff').href,archive);assert.equal(tumblrContentUrl(archive,'staff').href,archive);
 assert.equal(tumblrResourceAllowed(archive,'Document','staff'),false);assert(tumblrResourceAllowed(archive,'Document','staff',archive));assert.throws(()=>validateListingUrl(archive,'tumblr:staff'));
 for(const url of ['https://other.tumblr.com/archive','https://staff.tumblr.com/archive?before=1','https://staff.tumblr.com/archive#month','https://staff.tumblr.com/api/read','https://staff.tumblr.com:444/archive'])assert.throws(()=>tumblrArchiveUrl(url,'staff'));
});
