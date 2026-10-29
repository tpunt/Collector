import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';

test('viewport reads respect overlays and hidden tabs; overrides and unread results remain stable; tall cards need full coverage',async()=>{
  const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');
  app.store.importArchiveBatch(app.store.generation,['short','tall'].map((id,i)=>({id,subreddit:'python',title:id+' read fixture',body:'Offline body',permalink:`/r/python/comments/${id}/`,created:{epochMs:1700000000001-i,precisionMs:1000},source:'archive',exportId:'read-ui',observedAt:1800000000000,media:['Text']})));
  await app.networkMode.change(true);
  const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
  try{
    const page=await browser.newPage({viewport:{width:1200,height:800},bypassCSP:true});await page.addInitScript(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}));
    await page.goto(origin);await page.locator('.post-card').first().waitFor();await page.addStyleTag({content:'[data-post-id="t3_tall"]{min-height:1800px}'});
    await page.waitForTimeout(1300);assert.equal(app.store.getPost('short')!.readAt,null);
    await page.getByRole('button',{name:'Settings',exact:true}).click();await page.evaluate(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}));
    await page.waitForTimeout(1300);assert.equal(app.store.getPost('short')!.readAt,null);await page.getByRole('button',{name:'Close dialog'}).click();
    await page.getByRole('button',{name:'Mark unread: short read fixture',exact:true}).waitFor();assert.notEqual(app.store.getPost('short')!.readAt,null);
    await page.getByRole('button',{name:'Mark unread: short read fixture',exact:true}).click();await page.waitForTimeout(1300);assert.equal(app.store.getPost('short')!.readAt,null);
    await page.getByLabel('Read status',{exact:true}).selectOption('unread');await page.waitForTimeout(350);
    await page.getByRole('button',{name:'Mark read: short read fixture',exact:true}).click();await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-post-id="t3_short"]').count(),1,'Marking read must not remove a visible unread result');
    await page.getByRole('button',{name:'Refresh view',exact:true}).click();await page.locator('[data-post-id="t3_short"]').waitFor({state:'detached'});
    const tall=page.locator('[data-post-id="t3_tall"]');await tall.evaluate(el=>window.scrollTo(0,el.getBoundingClientRect().top+scrollY-(document.querySelector('.offline-banner')?.getBoundingClientRect().height??0)));await page.waitForTimeout(1300);assert.equal(app.store.getPost('tall')!.readAt,null);
    await page.evaluate(()=>window.scrollBy(0,650));await page.waitForTimeout(1300);assert.equal(app.store.getPost('tall')!.readAt,null);
    await page.evaluate(()=>window.scrollBy(0,650));await page.getByRole('button',{name:'Mark unread: tall read fixture',exact:true}).waitFor();assert.notEqual(app.store.getPost('tall')!.readAt,null);
    await page.reload();await page.getByLabel('Read status',{exact:true}).selectOption('read');await page.waitForTimeout(350);assert.equal(await page.locator('.post-card').count(),2);
  }finally{await browser.close();await app.close();}
});

test('broken images and clipped lazy gallery slides do not block automatic reads',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,['broken','gallery'].map((id,index)=>({id,subreddit:'python',title:id+' image fixture',body:'Stored text',permalink:`/r/python/comments/${id}/`,created:{epochMs:1700000000000-index,precisionMs:1000},source:'archive',exportId:'image-read',observedAt:1800000000000,media:['Text']})));
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900},bypassCSP:true});await page.addInitScript(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}));
  await page.route('**/broken-image.png',route=>route.fulfill({contentType:'image/png',body:'Not an image'}));await page.route('**/never-load.png',()=>new Promise(()=>{}));
  await page.goto(origin);await page.locator('.post-card').nth(1).waitFor();
  await page.evaluate(()=>{
   const broken=document.createElement('img');broken.src='/broken-image.png';broken.width=60;broken.height=60;document.querySelector('[data-post-id="t3_broken"] .post-content')!.append(broken);
   const gallery=document.createElement('div');gallery.style.cssText='width:200px;height:60px;overflow:hidden;display:flex';const spacer=document.createElement('div');spacer.style.cssText='min-width:300px;height:60px';gallery.append(spacer);
   const pending=document.createElement('img');pending.loading='lazy';pending.src='/never-load.png';pending.style.cssText='min-width:100px;height:60px';gallery.append(pending);document.querySelector('[data-post-id="t3_gallery"] .post-content')!.append(gallery);
  });
  await page.waitForFunction(()=>{const image=document.querySelector<HTMLImageElement>('img[src="/broken-image.png"]');return image?.complete&&image.naturalWidth===0;});
  await page.evaluate(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}));
  await page.getByRole('button',{name:'Mark unread: broken image fixture',exact:true}).waitFor();await page.getByRole('button',{name:'Mark unread: gallery image fixture',exact:true}).waitFor();assert.notEqual(app.store.getPost('broken')!.readAt,null);assert.notEqual(app.store.getPost('gallery')!.readAt,null);
 }finally{await browser.close();await app.close();}
});

test('a delayed automatic read response cannot overwrite a later manual unread choice',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,[{id:'race',subreddit:'python',title:'Read response fixture',body:'Saved text',permalink:'/r/python/comments/race/',created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'read-response',observedAt:1800000000000,media:['Text']}]);
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});let first=true;
 try{
  const page=await browser.newPage();await page.route('**/api/read',async route=>{if(!first){await route.continue();return;}first=false;const response=await route.fetch();entered();await gate;await route.fulfill({response});});await page.goto(origin);await began;
  await page.getByRole('button',{name:'Mark read: Read response fixture',exact:true}).click();await page.getByRole('button',{name:'Mark unread: Read response fixture',exact:true}).click();await page.getByRole('button',{name:'Mark read: Read response fixture',exact:true}).waitFor();assert.equal(app.store.getPost('race')!.readAt,null);
  release();await page.waitForTimeout(300);assert.equal(await page.getByRole('button',{name:'Mark read: Read response fixture',exact:true}).count(),1);assert.equal(app.store.getPost('race')!.readAt,null);
 }finally{release();await browser.close();await app.close();}
});

test('read and unread changes propagate between open readers through ordinary local polling',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,[{id:'shared',subreddit:'python',title:'Shared read fixture',body:'Local text',permalink:'/r/python/comments/shared/',created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'shared-read',observedAt:1,media:['Text']}]);
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const context=await browser.newContext();await context.addInitScript(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}));const first=await context.newPage(),second=await context.newPage();await Promise.all([first.goto(origin),second.goto(origin)]);
  await first.getByRole('button',{name:'Mark read: Shared read fixture',exact:true}).waitFor();await second.getByRole('button',{name:'Mark read: Shared read fixture',exact:true}).waitFor();
  await first.getByRole('button',{name:'Mark read: Shared read fixture',exact:true}).click();await second.getByRole('button',{name:'Mark unread: Shared read fixture',exact:true}).waitFor();
  await second.getByRole('button',{name:'Mark unread: Shared read fixture',exact:true}).click();await first.getByRole('button',{name:'Mark read: Shared read fixture',exact:true}).waitFor();assert.equal(app.store.getPost('shared')!.readAt,null);assert(app.networkMode.status.offline);assert.equal(app.problems.status.groups,0);assert.equal(app.jobs.state.requests.sessionTotal,0);
 }finally{await browser.close();await app.close();}
});
