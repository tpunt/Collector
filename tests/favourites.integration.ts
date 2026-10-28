import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';
import {archivePost} from '../src/archive.ts';
import {readListing,readThread} from '../src/extract.ts';
const row=(id:string,author:string,subreddit='python',time=1700000000)=>archivePost({id,author,subreddit,title:'Favourite '+id,selftext:'Full saved '+id,created_utc:time,is_self:true},subreddit,'favourites-ui',1800000000000);

test('favourite posts and users work offline across feeds, filters, reload, drawer actions and later imports',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');app.store.addSubreddit('aww');
 app.store.importArchiveBatch(app.store.generation,[row('alice','Alice_Example'),row('second','Alice_Example','aww',1700000001),row('bob','Bob_Example','aww',1700000002)]);
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}}),external:string[]=[],errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.route('**/*',route=>{if(route.request().url().startsWith(origin))return route.continue();external.push(route.request().url());return route.abort();});await page.addInitScript(()=>Object.defineProperty(document,'visibilityState',{get:()=> 'hidden'}));
  await page.goto(origin);const card=(id:string)=>page.locator(`[data-post-id="t3_${id}"]`),nav=page.getByRole('navigation',{name:'Main navigation'}),home=()=>page.getByRole('link',{name:'Collector',exact:true}).click();await card('alice').waitFor();
  await card('alice').getByRole('button',{name:'Favourite post: Favourite alice',exact:true}).click();await card('alice').getByRole('button',{name:'Unfavourite post: Favourite alice',exact:true}).waitFor();
  await nav.getByRole('button',{name:/^Favourite posts/}).click();await page.getByRole('heading',{name:'Favourite posts',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1);assert.equal(await card('alice').count(),1);
  await page.getByLabel('Search stored posts',{exact:true}).fill('nonexistent');await page.getByRole('button',{name:'Search',exact:true}).click();await page.getByRole('heading',{name:'No matching favourite posts',exact:true}).waitFor();await page.getByLabel('Search stored posts',{exact:true}).fill('');await page.getByRole('button',{name:'Search',exact:true}).click();await card('alice').waitFor();
  await card('alice').getByRole('button',{name:'Favourite user: u/Alice_Example',exact:true}).click();await card('alice').getByRole('button',{name:'Unfavourite user: u/Alice_Example',exact:true}).waitFor();
  await nav.getByRole('button',{name:/^Favourite users/}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);assert.equal(await card('bob').count(),0);
  await page.locator('.source-nav').getByRole('button',{name:/^r\/aww\b/}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1);assert.equal(await card('second').count(),1);await page.locator('.source-nav').getByRole('button',{name:/^All feeds/}).click();await card('alice').waitFor();
  await home();await card('bob').getByRole('button',{name:'Favourite user: u/Bob_Example',exact:true}).click();await card('bob').getByRole('button',{name:'Unfavourite user: u/Bob_Example',exact:true}).waitFor();await nav.getByRole('button',{name:/^Favourite users/}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===3);
  const users=page.getByRole('region',{name:'Favourited users',exact:true});await users.getByRole('button',{name:'u/Alice_Example',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);
  app.store.importArchiveBatch(app.store.generation,[row('new','Alice_Example','python',1700000003)]);await card('new').waitFor();assert.equal(await page.locator('.post-card').count(),3);
  await card('second').getByRole('button',{name:'Favourite second',exact:true}).click();const drawer=page.getByRole('dialog',{name:'Thread details',exact:true});await drawer.getByRole('button',{name:'Favourite post: Favourite second',exact:true}).click();await drawer.getByRole('button',{name:'Unfavourite post: Favourite second',exact:true}).waitFor();await page.getByRole('button',{name:'Close thread',exact:true}).click();
  await page.reload();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===4);assert.equal(app.store.favourites().posts,2);assert.equal(app.store.favouriteUsers().length,2);
  await users.getByRole('button',{name:'Unfavourite user: u/Bob_Example',exact:true}).click();await card('bob').waitFor({state:'detached'});assert(app.store.getPost('bob'));
  app.store.removeSubreddit('python');await nav.getByRole('button',{name:/^Favourite posts/}).click();await card('alice').waitFor();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);await card('alice').getByRole('button',{name:'r/python',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1);assert.equal(await page.locator('.source-nav').getByRole('button',{name:'r/python (stored)',exact:true}).getAttribute('aria-pressed'),'true');
  await card('alice').getByRole('button',{name:'Unfavourite post: Favourite alice',exact:true}).click();await page.getByRole('heading',{name:'No matching favourite posts',exact:true}).waitFor();assert(app.store.getPost('alice'));
  await nav.getByRole('button',{name:/^Favourite users/}).click();await card('new').waitFor();await page.screenshot({path:'/private/tmp/collector-favourites-desktop.png',fullPage:true});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'/private/tmp/collector-favourites-mobile.png',fullPage:true});
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.equal(app.jobs.state.requests.sessionTotal,0);assert.equal(app.media.status.requests,0);
 }finally{await browser.close();await app.close();}
});

test('rendered listing and thread authors are bound to the displayed profile link, not nested/hidden authors',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.setContent(`<div id="header"><span class="user"><a href="/user/fixture_user">fixture_user</a></span></div><ul class="tabmenu"><li class="selected">New</li></ul><div id="siteTable"><div class="thing link self" data-fullname="t3_abc" data-subreddit="python" data-permalink="/r/python/comments/abc/"><div class="entry"><a class="title" href="/r/python/comments/abc/">Author fixture</a><p class="tagline"><a class="author" href="/user/Alice_Example">Alice_Example</a> <time datetime="2023-11-14T22:13:20Z">Date</time></p><div class="usertext-body"><div class="md">Saved body <a class="author" href="/user/Injected">Injected</a></div></div></div></div></div><div class="commentarea"></div>`);
  assert.equal((await readListing(page,'python')).posts[0]!.author?.id,'alice_example');assert.equal((await readThread(page,'abc')).snapshot.author?.id,'alice_example');
  await page.locator('.tagline .author').evaluate(node=>node.setAttribute('href','https://example.com/user/Alice_Example'));assert.equal((await readListing(page,'python')).posts[0]!.author,undefined);
  await page.locator('.tagline .author').evaluate(node=>{node.textContent='[deleted]';node.removeAttribute('href');});assert.equal((await readThread(page,'abc')).snapshot.author,null);
  await page.locator('.tagline .author').evaluate(node=>node.setAttribute('hidden',''));assert.equal((await readListing(page,'python')).posts[0]!.author,undefined);
  await page.locator('.tagline').evaluate(node=>{node.innerHTML='submitted by <em>[deleted]</em> <time datetime="2023-11-14T22:13:20Z">Date</time>';});assert.equal((await readListing(page,'python')).posts[0]!.author,null);assert.equal((await readThread(page,'abc')).snapshot.author,null);
 }finally{await browser.close();}
});

test('favourites mutations require authentication and valid identities and reject stale post contexts',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,[row('abc','Alice_Example')]);const origin=await app.listen();
 try{
  const {token}=await(await fetch(origin+'/api/state')).json(),context=app.store.getPost('abc')!.readContext;
  const post=(path:string,data:unknown,auth=true)=>fetch(origin+'/api/favourite/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Reader-Token':token}:{})},body:JSON.stringify(data)});
  assert.equal((await post('post',{id:'abc',context,favourite:true},false)).status,403);assert.equal((await post('post',{id:'abc',context,favourite:'yes'})).status,400);assert.equal((await post('user',{author:{platform:'reddit',id:'abc'},favourite:true})).status,400);
  assert.equal((await fetch(origin+'/api/feed?favourites=invalid')).status,400);assert.equal((await post('post',{id:'abc',context,favourite:true})).status,200);
  app.store.clearSubreddit('python');app.store.importArchiveBatch(app.store.generation,[row('abc','Alice_Example')]);assert.equal((await post('post',{id:'abc',context,favourite:true})).status,400);assert.equal(app.store.getPost('abc')!.favourite,false);
 }finally{await app.close();}
});

test('a removed favourite-user filter cannot silently reactivate if that user is favourited again elsewhere',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');const alice=row('alice','Alice_Example'),bob=row('bob','Bob_Example');app.store.importArchiveBatch(app.store.generation,[alice,bob]);app.store.setUserFavourite(alice.author,true);app.store.setUserFavourite(bob.author,true);
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.addInitScript(()=>Object.defineProperty(document,'visibilityState',{get:()=> 'hidden'}));await page.goto(origin+'/#users');const users=page.getByRole('region',{name:'Favourited users',exact:true});await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);
  await users.getByRole('button',{name:'u/Alice_Example',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1);assert.equal(await page.getByRole('button',{name:'Favourite alice',exact:true}).count(),1);
  app.store.setUserFavourite(alice.author,false);await users.getByRole('button',{name:'u/Alice_Example',exact:true}).waitFor({state:'detached'});await page.getByRole('button',{name:'Favourite bob',exact:true}).waitFor();
  app.store.setUserFavourite(alice.author,true);await users.getByRole('button',{name:'u/Alice_Example',exact:true}).waitFor();await page.waitForTimeout(400);
  assert.match(await users.getByRole('button',{name:'All favourite users',exact:true}).getAttribute('class')??'',/selected/,'Restored favourites must keep the displayed All favourite users selection');
  // The newly eligible older post is beyond the retained viewport window.
  await page.getByRole('button',{name:'Load more',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);
 }finally{await browser.close();await app.close();}
});

test('Back and the Collector home link leave a stored-only subreddit filter when returning to the normal feed',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,[row('old','Alice_Example'),row('active','Bob_Example','aww')]);app.store.setPostFavourite('old',true);app.store.setPostFavourite('active',true);app.store.removeSubreddit('python');
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.goto(origin+'/#posts');await page.getByRole('button',{name:'Favourite active',exact:true}).waitFor();
  const filterRetained=async()=>{await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:/^Favourite posts /}).click();await page.getByRole('button',{name:'Favourite old',exact:true}).waitFor();await page.locator('.post-card').filter({hasText:'Favourite old'}).getByRole('button',{name:'r/python',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1);assert.equal(await page.locator('.source-nav').getByRole('button',{name:'r/python (stored)',exact:true}).getAttribute('aria-pressed'),'true');};
  await filterRetained();await page.goBack();await page.waitForTimeout(400);assert.equal(await page.locator('.source-nav').getByRole('button',{name:/^All feeds/}).getAttribute('aria-pressed'),'true');await page.getByRole('button',{name:'Favourite active',exact:true}).waitFor();
  await filterRetained();await page.getByRole('link',{name:'Collector',exact:true}).click();await page.getByRole('heading',{name:'All feeds',exact:true}).waitFor();await page.getByRole('button',{name:'Favourite active',exact:true}).waitFor();assert.equal(await page.locator('.post-card').count(),1);
 }finally{await browser.close();await app.close();}
});
