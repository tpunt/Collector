import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createOnlineReaderServer} from './online-fixture.ts';
import {RequestQueue} from '../src/request-gate.ts';
import {readTumblrListing,readTumblrPost} from '../src/tumblr.ts';
import {ReaderStore} from '../src/store.ts';
import {readFile,rm} from 'node:fs/promises';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVQAAAAASUVORK5CYII=','base64');
const article=(id:string,full=false)=>`<article data-post-id="${id}" data-timestamp="1700000000"><a class="permalink" href="https://staff.tumblr.com/post/${id}/">Post</a><h2>Tumblr ${id}</h2><div class="post-content"><p>${full?'Complete Tumblr body including the rest of the text.':'Listing excerpt.'}</p><img src="https://64.media.tumblr.com/fixture-${id}-one.png"><img src="https://64.media.tumblr.com/fixture-${id}-two.png"></div>${full?'':'<a href="https://staff.tumblr.com/post/'+id+'/">Keep reading</a>'}<footer><a>Like</a></footer></article>`;
const html=(body:string)=>`<!doctype html><html><head><title>Staff</title></head><body><main>${body}</main></body></html>`;
async function settle(app:Awaited<ReturnType<typeof createOnlineReaderServer>>){const until=Date.now()+15000;while(app.jobs.state.running){if(Date.now()>until)throw new Error('Tumblr sync did not settle');await delay(5);}}

test('public Tumblr extraction reads ordered full attachments, binds identities and refuses unknown dates, hidden galleries and access gates',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html(article('12345')+'<a rel="next" href="/page/2">Older</a>')}));await page.goto('https://staff.tumblr.com/');
  const listing=await readTumblrListing(page,'tumblr:staff');assert.equal(listing.next,'https://staff.tumblr.com/page/2');assert.equal(listing.posts[0]!.id,'tumblr:staff:12345');assert.equal(listing.posts[0]!.bodyNeedsFetch,true);assert.deepEqual(listing.posts[0]!.attachments,[]);
  await page.goto('https://staff.tumblr.com/post/12345/');await page.setContent(html(article('12345',true)));const post=await readTumblrPost(page,'tumblr:staff:12345');assert.match(post.body!,/rest of the text/);assert.equal(post.attachments!.length,2);assert.deepEqual(post.attachments!.map(file=>file.collection?.index),[0,1]);assert.equal(post.author!.platform,'tumblr');
  await assert.rejects(readTumblrPost(page,'tumblr:staff:99999'),/requested post/);
  await page.locator('article').evaluate(node=>node.insertAdjacentHTML('beforeend','<video src="https://va.media.tumblr.com/native.mp4"></video><iframe src="https://www.youtube.com/embed/abcDEF12345"></iframe>'));
  const mixed=await readTumblrPost(page,'tumblr:staff:12345');assert.equal(mixed.attachments!.length,3);assert.equal(mixed.outbound,'https://www.youtube.com/embed/abcDEF12345');assert(mixed.media!.includes('Video'));
  await page.locator('article').evaluate(node=>node.insertAdjacentHTML('beforeend','<figure class="invalid-block" data-npf="{">Unrecognised media</figure>'));await assert.rejects(readTumblrPost(page,'tumblr:staff:12345'),/hides some content/);await page.locator('.invalid-block').evaluate(node=>node.remove());
  await page.locator('article').evaluate(node=>node.insertAdjacentHTML('beforeend','<iframe src="https://staff.tumblr.com/photoset_iframe/12345"></iframe>'));await assert.rejects(readTumblrPost(page,'tumblr:staff:12345'),/hides some content/);
  await page.goto('https://staff.tumblr.com/');await page.locator('article').evaluate(node=>node.removeAttribute('data-timestamp'));await assert.rejects(readTumblrListing(page,'tumblr:staff'),/checkpoint kept for retry/);
  await page.setContent('<main><h1>Log in to view this blog</h1></main>');await assert.rejects(readTumblrListing(page,'tumblr:staff'),/access confirmation/);
 }finally{await browser.close();}
});

test('mixed Tumblr posts save hosted images and video while disclosing a separate online player; image/video filters restrict the displayed attachments',async()=>{
 const video=await readFile(new URL('./fixtures/media.mp4',import.meta.url));let downloads=0;
 const app=await createOnlineReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async input=>{downloads++;return new Response(String(input).endsWith('.mp4')?video:png,{headers:{'Content-Type':String(input).endsWith('.mp4')?'video/mp4':'image/png'}});}}});
 app.store.addSubreddit('tumblr:staff');app.store.importArchiveBatch(app.store.generation,[{id:'tumblr:staff:77777',subreddit:'tumblr:staff',permalink:'https://staff.tumblr.com/post/77777/',title:'Mixed attachments',body:'Hosted media and a separate online video',created:{epochMs:1700000000000,precisionMs:1000},observedAt:Date.now(),source:'archive',exportId:'mixed-fixture',media:['Text','Image','Video'],outbound:'https://www.youtube.com/embed/abcDEF12345',attachments:[{kind:'image',url:'https://64.media.tumblr.com/mixed.png',collection:{id:'tumblr:staff:77777',index:0,total:2}},{kind:'video',url:'https://va.media.tumblr.com/mixed.mp4',collection:{id:'tumblr:staff:77777',index:1,total:2}}]}]);
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  app.jobs.syncMedia(['tumblr:staff'],{resume:true});await settle(app);assert.equal(downloads,2);assert.equal(app.store.mediaSync('tumblr:staff:77777')!.status,'unavailable');assert((await app.media.items('tumblr:staff:77777')).every(item=>item.state==='ready'));
  await app.networkMode.change(true);const page=await browser.newPage(),external:string[]=[];await page.route('**/*',route=>{if(route.request().url().startsWith(origin))return route.continue();external.push(route.request().url());return route.abort();});await page.goto(origin);
  await page.getByText('Partially downloaded',{exact:true}).waitFor();await page.getByRole('button',{name:'View image full screen: Mixed attachments — image 1',exact:true}).waitFor();assert.equal(await page.locator('video').count(),1);assert.equal(await page.locator('iframe').count(),0);
  await page.getByRole('button',{name:'Image',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-media img').length===1&&document.querySelectorAll('.post-media video').length===0);assert.equal(await page.locator('.online-media').count(),0);
  await page.getByRole('button',{name:'Video',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-media video').length===1&&document.querySelectorAll('.post-media img').length===0);await page.getByText('Offline mode · Online player paused',{exact:true}).waitFor();
  assert.deepEqual(external,[]);assert.equal(downloads,2);
  await page.close();const cached=(await app.media.items('tumblr:staff:77777'))[0]!;await rm(cached.localPath!);await app.media.inventory();assert.equal(app.store.mediaSync('tumblr:staff:77777')!.status,'pending');
  await app.networkMode.change(false);app.jobs.syncMedia(['tumblr:staff'],{resume:true});await settle(app);assert.equal(downloads,3);assert.equal(app.store.mediaSync('tumblr:staff:77777')!.status,'unavailable');assert((await app.media.items('tumblr:staff:77777')).every(item=>item.state==='ready'));
 }finally{await browser.close();await app.close();}
});

test('Tumblr sync pages history, saves full text and every attachment before success, composes shared filters and serves offline media',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'}),collector=await browser.newPage();let navigations=0,downloads=0;
 const counts={released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:0};
 await collector.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.hostname!=='staff.tumblr.com')return route.abort();
  const id=url.pathname.match(/\/post\/([0-9]+)/)?.[1];return route.fulfill({contentType:'text/html',body:html(id?article(id,true):url.pathname==='/page/2'?article('12344'):article('12345')+'<a href="/page/2">Older</a>')});
 });
 const app=await createOnlineReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0}),browser:{counts,async open(_limit,mode){assert.equal(mode,'tumblr');},async close(){},async manualSignIn(){assert.fail('Public Tumblr does not sign into Reddit');},async navigate(url,signal){signal?.throwIfAborted();navigations++;counts.released++;await collector.goto(url);return collector;}}},media:{fetch:async()=>{downloads++;return new Response(png,{headers:{'Content-Type':'image/png'}});}}});
 const origin=await app.listen();
 try{
  const state=await(await fetch(origin+'/api/state')).json();const response=await fetch(origin+'/api/sources',{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':state.token},body:JSON.stringify({platform:'tumblr',name:'staff',historyMonths:0})});assert.equal(response.status,200);await settle(app);
  assert.equal(app.store.feedSync('tumblr:staff').state,'gaps');assert.match(app.store.feedSync('tumblr:staff').reason??'',/end Tumblr serves/);assert.equal(app.store.feedSync('tumblr:staff').lastSuccessAt,null);assert(app.store.feedSync('tumblr:staff').lastCompletedAt);assert.equal(app.store.stats().posts,2);assert.equal(downloads,4);assert.equal(app.store.getSetting('account'),null);assert(navigations>=4);
  const post=app.store.getPost('tumblr:staff:12345')!;assert.match(post.body!,/Complete Tumblr body/);assert.equal(post.attachments.length,2);assert.equal(app.store.mediaSync(post.id)!.status,'ready');
  app.store.setPostTags(post.id,['inspiration']);app.store.setPostFavourite(post.id,true);app.store.setUserFavourite(post.author!,true);
  assert.equal(app.store.queryFeed({tag:'inspiration',media:'Image',favourites:'users'}).posts.length,1);
  await app.networkMode.change(true);const page=await browser.newPage(),external:string[]=[];await page.route('**/*',route=>{if(route.request().url().startsWith(origin))return route.continue();external.push(route.request().url());return route.abort();});await page.goto(origin);
  await page.locator('.source-platform').filter({has:page.getByRole('heading',{name:'Tumblr',exact:true})}).getByRole('button',{name:/^@staff/}).click();await page.getByRole('heading',{name:'@staff',exact:true}).waitFor();
  await page.getByLabel('Tag filter').selectOption('inspiration');await page.getByRole('button',{name:'Image',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1&&document.querySelectorAll('.post-media img').length===2&&[...document.querySelectorAll<HTMLImageElement>('.post-media img')].every(image=>image.naturalWidth===1));
  const items=await app.media.items(post.id);for(const item of items){const saved=await fetch(origin+item.url);assert.equal(saved.status,200);assert.equal((await saved.arrayBuffer()).byteLength,png.length);}
  assert.deepEqual(external,[]);assert.equal(downloads,4);assert.equal(app.store.favourites().posts,1);
  const before=new ReaderStore(':memory:');try{before.addSubreddit('tumblr:staff');assert.throws(()=>before.commitBatch({generation:before.generation,targetId:before.createTarget({subreddit:'tumblr:staff',upperMs:Date.now()}),observations:[],continuation:'https://other.tumblr.com/page/2'}),/selected Tumblr blog/);}finally{before.close();}
  await app.jobs.stopSource('tumblr:staff');app.store.deletePost(post.id);assert(app.store.isPostExcluded(post.id));app.store.clearSubreddit('tumblr:staff');assert.equal(app.store.stats().posts,0);
 }finally{await app.close();await browser.close();}
});

test('Offline mode pauses a Tumblr page without advancing its checkpoint and automatically resumes it with saved media retained',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'}),page=await browser.newPage();let blocked=true,atSecondPage=false,downloads=0;
 await page.route('**/*',route=>{const url=new URL(route.request().url()),id=url.pathname.match(/\/post\/([0-9]+)/)?.[1];return route.fulfill({contentType:'text/html',body:html(id?article(id,true):url.pathname==='/page/2'?article('12344'):article('12345')+'<a href="/page/2">Older</a>')});});
 const app=await createOnlineReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0}),browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:0},async open(){},async close(){},async manualSignIn(){},async navigate(url,signal){
  if(blocked&&url.endsWith('/page/2')){atSecondPage=true;await new Promise<void>((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new Error('Paused fixture navigation')),{once:true}));}
  signal?.throwIfAborted();await page.goto(url);return page;
 }}},media:{fetch:async()=>{downloads++;return new Response(png,{headers:{'Content-Type':'image/png'}});}}});
 try{
  await app.listen();const target=app.store.addSource({name:'tumblr:staff',historyMonths:0},Date.now());app.jobs.syncFeeds(['tumblr:staff'],{heads:[target],history:[]});
  const deadline=Date.now()+15000;while(!atSecondPage){if(Date.now()>deadline)throw new Error('Second Tumblr page was not reached');await delay(5);}
  await app.networkMode.change(true);assert.equal(app.store.getTarget(target)!.continuation,'https://staff.tumblr.com/page/2');assert.equal(app.store.getTarget(target)!.status,'paused');assert.equal(app.store.stats().posts,1);assert.equal(downloads,2);assert(app.networkMode.status.paused.feeds.includes('tumblr:staff'));
  blocked=false;await app.networkMode.change(false);await settle(app);assert.equal(app.store.stats().posts,2);assert.equal(downloads,4);assert.equal(app.store.getTarget(target)!.status,'done');assert.equal(app.store.feedSync('tumblr:staff').state,'gaps');assert.equal(app.store.offlineMedia('tumblr:staff').ready,2);
 }finally{await app.close();await browser.close();}
});

test('public Tumblr native photosets and video frames are read as complete ordered attachments, with NPF variants and source elements handled once',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.route('**/*',route=>{
   const url=route.request().url();let body='';
   if(url.includes('photoset_iframe'))body='<main class="photoset"><a href="https://64.media.tumblr.com/photo-full.png"><img src="https://64.media.tumblr.com/photo-preview.png"></a><a href="/post/12345/"><img src="https://64.media.tumblr.com/photo-two.png"></a></main>';
   else if(url.includes('/video/'))body='<main><a href="https://64.media.tumblr.com/poster.png"><video><source src="https://va.media.tumblr.com/movie.mp4" type="video/mp4"></video></a></main>';
   else body=`<article data-post-id="12345" data-timestamp="1700000000"><a href="https://other.tumblr.com/post/99999/">Reblog source</a><a href="/post/12345/">Permalink</a><h2>Mixed native Tumblr media</h2><p>Full caption</p><img src="https://64.media.tumblr.com/before.png"><iframe src="https://staff.tumblr.com/photoset_iframe/12345/hash/500/"></iframe><figure data-npf='{"type":"image","media":[{"url":"https://64.media.tumblr.com/npf-original.png","width":2048}]}'><img src="https://64.media.tumblr.com/npf-preview.png"></figure><video><source src="https://va.media.tumblr.com/direct.mp4" type="video/mp4"></video><iframe src="https://www.tumblr.com/video/staff/12345/500/"></iframe><img src="https://64.media.tumblr.com/after.png"></article>`;
   return route.fulfill({contentType:'text/html',body:html(body)});
  });
  await page.goto('https://staff.tumblr.com/post/12345/');const visits:string[]=[];
  const result=await readTumblrPost(page,'tumblr:staff:12345',async url=>{visits.push(url);await page.goto(url);return page;});
  assert.equal(visits.length,2);assert.deepEqual(result.attachments!.map(file=>new URL(file.url).pathname),['/before.png','/photo-full.png','/photo-two.png','/npf-original.png','/direct.mp4','/movie.mp4','/after.png']);assert(result.attachments!.every((file,index)=>file.collection?.index===index&&file.collection?.total===7));assert.equal(result.outbound,undefined);assert.match(result.body!,/Full caption/);
  await page.goto('https://staff.tumblr.com/post/12345/');await page.locator('article iframe').first().evaluate(node=>node.setAttribute('src','https://other.tumblr.com/photoset_iframe/12345/'));let fetched=false;
  await assert.rejects(readTumblrPost(page,'tumblr:staff:12345',async()=>{fetched=true;throw new Error('must not fetch a different blog');}),/hides some content/);assert.equal(fetched,false);
 }finally{await browser.close();}
});

test('switching Reddit and Tumblr profiles preserves the session request count and budget',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'}),page=await browser.newPage();
 const now=Date.now(),counts={released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:0};let mode:unknown=null,total=0;
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html('<article data-post-id="12345" data-timestamp="1700000000"><a href="/post/12345/">Permalink</a><p>Full Tumblr text.</p></article>')}));
 const app=await createOnlineReaderServer({database:':memory:',port:0,jobs:{mediaSync:null,network:new RequestQueue({intervalMs:0}),browser:{counts,async open(_budget,requested){if(mode!==requested){counts.released=0;mode=requested;}},async close(){mode=null;},async manualSignIn(){},async navigate(url){counts.released++;total++;await page.goto(url);return page;}},readListing:async()=>({account:'fixture_user',posts:[{id:'abc',subreddit:'python',permalink:'/r/python/comments/abc/',title:'Reddit text',body:'Complete',created:{epochMs:now,precisionMs:1000},source:'live',observedAt:now,media:['Text']}],ordinary:[{id:'t3_abc',createdMs:now,precisionMs:1000}],unknownTime:false,omissions:0,next:null,empty:false,signature:'abc'})}});
 try{await app.listen();app.store.addSource({name:'python',historyMonths:1});app.store.addSource({name:'tumblr:staff',historyMonths:1});app.jobs.syncFeeds(['python','tumblr:staff']);await settle(app);assert(total>=3);assert.equal(app.jobs.state.requests.sessionTotal,total);assert.equal(app.store.offlineText('tumblr:staff').ready,1);}
 finally{await app.close();await browser.close();}
});

test('picture/video source variants are single attachments and disabled next placeholders do not stall history',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{const page=await browser.newPage();await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html('<article data-post-id="12345" data-timestamp="1700000000"><a href="/post/12345/">Post</a><picture><source type="image/webp" srcset="https://64.media.tumblr.com/picture.webp 640w, https://64.media.tumblr.com/picture-full.webp 1280w"><source type="image/jpeg" srcset="https://64.media.tumblr.com/alternate.jpg 1280w"><img src="https://64.media.tumblr.com/fallback.png"></picture><a href="https://64.media.tumblr.com/poster.png"><video><source src="https://va.media.tumblr.com/movie.mp4" type="video/mp4"><source src="https://va.media.tumblr.com/movie.webm" type="video/webm"></video></a></article><a class="next" href="#">Next</a>')}));await page.goto('https://staff.tumblr.com/post/12345/');const post=await readTumblrPost(page,'tumblr:staff:12345');assert.deepEqual(post.attachments!.map(file=>new URL(file.url).pathname),['/picture-full.webp','/movie.mp4']);await page.goto('https://staff.tumblr.com/');assert.equal((await readTumblrListing(page,'tumblr:staff')).next,null);await page.locator('a.next').evaluate(node=>node.setAttribute('href','https://other.tumblr.com/page/2'));assert.equal((await readTumblrListing(page,'tumblr:staff')).next,null);await page.locator('a.next').evaluate(node=>{node.setAttribute('rel','next');});await assert.rejects(readTumblrListing(page,'tumblr:staff'),/selected Tumblr blog/);}
 finally{await browser.close();}
});

test('a Tumblr access block pauses only Tumblr; bulk sync still collects Reddit and explicit Tumblr retry respects its cooldown',async()=>{
 const {AccessError}=await import('../src/browser.ts');const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'}),page=await browser.newPage();let denied=true,tumblrVisits=0,globalPauses=0;
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html('<article data-post-id="12345" data-timestamp="1700000000"><a href="/post/12345/">Post</a><p>Complete Tumblr text.</p></article>')}));
 const app=await createOnlineReaderServer({database:':memory:',port:0,jobs:{mediaSync:null,network:new RequestQueue({intervalMs:0}),onPause:()=>globalPauses++,browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:0},async open(){},async close(){},async manualSignIn(){},async navigate(url){if(url.includes('staff.tumblr.com')){tumblrVisits++;if(denied)throw new AccessError('Tumblr denied access (403)',Date.now()+60000,'tumblr');}await page.goto(url);return page;}},readListing:async()=>({account:'fixture_user',posts:[{id:'abc',subreddit:'zztest',permalink:'/r/zztest/comments/abc/',title:'Reddit keeps collecting',body:'Complete',created:{epochMs:1700000000000,precisionMs:1000},source:'live',observedAt:Date.now(),media:['Text']}],ordinary:[],unknownTime:false,omissions:0,next:null,empty:false,signature:'abc'})}});
 try{await app.listen();app.store.addSource({name:'tumblr:staff',historyMonths:1});app.store.addSource({name:'zztest',historyMonths:1});app.jobs.syncFeeds(['tumblr:staff','zztest']);await settle(app);assert.equal(globalPauses,0);assert.equal(app.jobs.state.accessPause,null);assert(app.jobs.state.sourcePause);assert.equal(app.store.getPost('abc')!.title,'Reddit keeps collecting');assert.equal(app.store.feedSync('tumblr:staff').state,'incomplete');const before=tumblrVisits;app.jobs.syncFeeds(['tumblr:staff','zztest']);await settle(app);assert.equal(tumblrVisits,before);assert.throws(()=>app.jobs.syncFeeds(['tumblr:staff']),/Cooldown until/);denied=false;app.store.setSetting('accessPause:tumblr',{reason:'Retry allowed',notBefore:null});app.jobs.syncFeeds(['tumblr:staff']);await settle(app);assert.equal(app.jobs.state.sourcePause,null);assert.equal(app.store.offlineText('tumblr:staff').ready,1);assert.equal(globalPauses,0);}
 finally{await app.close();await browser.close();}
});

test('one unrecognised Tumblr theme stops only that feed, without marking idle blogs paused or logging the error twice',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'}),page=await browser.newPage();let globalPauses=0;
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:route.request().url().includes('broken.tumblr.com')?'<main>Unknown theme</main>':html('<article data-post-id="12345" data-timestamp="1700000000"><a href="/post/12345/">Post</a><p>Full content</p></article>')}));
 const app=await createOnlineReaderServer({database:':memory:',port:0,jobs:{mediaSync:null,network:new RequestQueue({intervalMs:0}),onPause:()=>globalPauses++,browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:0},async open(){},async close(){},async manualSignIn(){},async navigate(url){await page.goto(url);return page;}}}});
 try{const origin=await app.listen();for(const name of ['tumblr:broken','tumblr:staff','tumblr:idle'])app.store.addSource({name,historyMonths:1});const idle=app.store.getHistoryPreference('tumblr:idle');app.jobs.syncFeeds(['tumblr:broken','tumblr:staff']);await settle(app);assert.equal(app.store.feedSync('tumblr:broken').state,'incomplete');assert.equal(app.store.offlineText('tumblr:staff').ready,1);assert.equal(app.store.feedSync('tumblr:idle').state,'never');assert.equal(app.store.getTarget(idle.targetId!)!.status,'queued');assert.equal(app.jobs.state.sourcePause,null);assert.equal(globalPauses,0);const state=await(await fetch(origin+'/api/state')).json();assert.equal(state.problems.unseen,1);}
 finally{await app.close();await browser.close();}
});
