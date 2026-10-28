import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';

test('sidebar search debounces typing, applies scope automatically and stays usable at mobile width',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,[['aaa','Needle title','Other body'],['bbb','Other title','Needle body']].map(([id,title,body])=>({id:id!,subreddit:'python',title:title!,body,permalink:`/r/python/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'search-ui',observedAt:1800000000000,media:['Text']})));
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage(),queries:URLSearchParams[]=[];page.on('request',request=>{const url=new URL(request.url());if(url.pathname==='/api/feed')queries.push(url.searchParams);});await page.goto(origin);const sidebar=page.locator('.sidebar'),input=sidebar.getByLabel('Search stored posts',{exact:true}),scope=sidebar.getByLabel('Search scope',{exact:true});await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);
  await page.clock.install();await input.fill('absent');await page.clock.runFor(100);await input.fill('needle');await page.clock.runFor(100);assert(!queries.some(query=>query.has('q')),'Keystrokes within the debounce window must not request intermediate results');const searched=page.waitForResponse(response=>new URL(response.url()).searchParams.get('q')==='needle');await page.clock.runFor(250);await searched;await page.clock.resume();assert(!queries.some(query=>query.get('q')==='absent'));assert.equal(await sidebar.getByRole('button',{name:'Search',exact:true}).count(),0);
  assert.equal(await page.locator('main').getByRole('searchbox').count(),0);assert.equal(await page.getByRole('combobox',{name:'Filter by subreddit',exact:true}).count(),0);
  await scope.selectOption('title');await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1);assert.equal(await page.locator('.post-title').textContent(),'Needle title');
  await scope.selectOption('body');await page.getByRole('button',{name:'Other title',exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert((await page.getByLabel('Search scope',{exact:true}).boundingBox())!.width>100);await page.screenshot({path:'/private/tmp/collector-sidebar-mobile.png',fullPage:true});
  await sidebar.getByRole('button',{name:'Manage feeds',exact:true}).click();await page.getByRole('heading',{name:'Feeds',exact:true}).waitFor();await input.fill('absent');await page.getByRole('heading',{name:'No matching posts',exact:true}).waitFor();await input.fill('needle');await page.getByRole('button',{name:'Other title',exact:true}).waitFor();await input.fill('');await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);
  assert.equal(app.jobs.state.requests.sessionTotal,0);
 }finally{await browser.close();await app.close();}
});

test('sidebar subreddit and read-status changes immediately filter the current favourites and combined feed',async()=>{
 const app=createReaderServer({database:':memory:',port:0});for(const name of ['python','aww'])app.store.addSubreddit(name);
 app.store.importArchiveBatch(app.store.generation,[['one','python'],['two','python'],['three','aww'],['four','aww']].map(([id,subreddit])=>({id:id!,subreddit:subreddit!,title:'Sidebar '+id,body:'Saved text',permalink:`/r/${subreddit}/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'sidebar',observedAt:1800000000000,media:['Text']})));
 for(const id of ['one','two','three'])app.store.setPostFavourite(id,true);for(const id of ['one','four'])app.store.setRead(id,true);
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.addInitScript(()=>Object.defineProperty(document,'visibilityState',{get:()=> 'hidden'}));await page.goto(origin+'/#favourites');const sidebar=page.locator('.sidebar'),sources=sidebar.getByRole('group',{name:'Feed filter',exact:true}),read=sidebar.getByLabel('Read status',{exact:true});
  await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===3);assert.deepEqual(await read.locator('option').allTextContents(),['Show read+unread','Show unread','Show read']);
  await sources.getByRole('button',{name:/^r\/python /}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);assert.equal(await page.getByRole('heading',{name:'Favourite posts',exact:true}).count(),1);
  await read.selectOption({label:'Show read'});await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1);assert.equal(await page.locator('.post-title').innerText(),'Sidebar one');
  await read.selectOption({label:'Show unread'});await page.getByRole('button',{name:'Sidebar two',exact:true}).waitFor();assert.equal(await page.locator('.post-card').count(),1);
  await sources.getByRole('button',{name:/^All feeds /}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);assert.equal(await page.getByRole('button',{name:'Sidebar four',exact:true}).count(),0);assert.equal(await page.getByRole('heading',{name:'Favourite posts',exact:true}).count(),1);
  await read.selectOption({label:'Show read+unread'});await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===3);await sidebar.getByRole('link',{name:'Collector',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===4);
  await sources.getByRole('button',{name:/^r\/aww /}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);assert.equal(await sources.getByRole('button',{name:/^r\/aww /}).getAttribute('aria-pressed'),'true');
  await read.selectOption({label:'Show read'});await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1);assert.equal(await page.locator('.post-title').innerText(),'Sidebar four');await sources.getByRole('button',{name:/^All feeds /}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);assert.equal(app.jobs.state.requests.sessionTotal,0);
 }finally{await browser.close();await app.close();}
});
