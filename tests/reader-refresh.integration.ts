import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';
const record=(id:string,time:number)=>({id,subreddit:'python',title:'Window '+id,body:'Full saved text',permalink:`/r/python/comments/${id}/`,created:{epochMs:time,precisionMs:1000},source:'archive' as const,exportId:'window',observedAt:1800000000000,media:['Text' as const]});

test('background updates retain loaded pages and viewport position; newly stored older history stays reachable',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,Array.from({length:125},(_,index)=>record('item'+index,1700000000000-index*1000)));
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}});await page.addInitScript(()=>Object.defineProperty(document,'visibilityState',{get:()=> 'hidden'}));await page.goto(origin);await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===50);
  await page.getByRole('button',{name:'Load more',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===100);await page.getByRole('button',{name:'Load more',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===125);
  const card=page.locator('[data-post-id="t3_item65"]');await card.scrollIntoViewIfNeeded();const before=(await card.boundingBox())!.y;
  app.store.importArchiveBatch(app.store.generation,[record('newhead',1700000010000)]);await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===126);assert(Math.abs((await card.boundingBox())!.y-before)<3,'The visible card must keep its viewport position');assert.equal(await page.getByRole('button',{name:'Window newhead',exact:true}).count(),1);
  app.store.importArchiveBatch(app.store.generation,[record('ancient',1600000000000)]);await page.getByRole('button',{name:'Load more',exact:true}).waitFor();assert.equal(await page.locator('.post-card').count(),126);await page.getByRole('button',{name:'Load more',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===127);assert.equal(await page.getByRole('button',{name:'Window ancient',exact:true}).count(),1);assert.equal(app.jobs.state.requests.sessionTotal,0);
 }finally{await browser.close();await app.close();}
});

test('a delayed background feed response cannot undo a confirmed read or unread choice',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,[record('choice',1700000000000)]);const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});let release!:()=>void,entered!:()=>void,hold=false;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
 try{
  const page=await browser.newPage();await page.addInitScript(()=>Object.defineProperty(document,'visibilityState',{get:()=> 'hidden'}));await page.route('**/api/feed?*',async route=>{if(!hold){await route.continue();return;}hold=false;const response=await route.fetch();entered();await gate;await route.fulfill({response});});await page.goto(origin);await page.getByRole('button',{name:'Mark read: Window choice',exact:true}).waitFor();
  hold=true;app.store.importArchiveBatch(app.store.generation,[record('another',1700000001000)]);await began;await page.getByRole('button',{name:'Mark read: Window choice',exact:true}).click();await page.getByRole('button',{name:'Mark unread: Window choice',exact:true}).waitFor();release();await page.getByRole('button',{name:'Window another',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Mark unread: Window choice',exact:true}).count(),1);assert.notEqual(app.store.getPost('choice')!.readAt,null);
 }finally{release();await browser.close();await app.close();}
});
