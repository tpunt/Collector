import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';

test('viewport reads respect overlays and hidden tabs; overrides and unread results remain stable; tall cards need full coverage',async()=>{
  const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');
  app.store.importArchiveBatch(app.store.generation,['short','tall'].map((id,i)=>({id,subreddit:'python',title:id+' read fixture',body:'Offline body',permalink:`/r/python/comments/${id}/`,created:{epochMs:1700000000001-i,precisionMs:1000},source:'archive',exportId:'read-ui',observedAt:1800000000000,media:['Text']})));
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
    const tall=page.locator('[data-post-id="t3_tall"]');await tall.evaluate(el=>window.scrollTo(0,el.getBoundingClientRect().top+scrollY));await page.waitForTimeout(1300);assert.equal(app.store.getPost('tall')!.readAt,null);
    await page.evaluate(()=>window.scrollBy(0,650));await page.waitForTimeout(1300);assert.equal(app.store.getPost('tall')!.readAt,null);
    await page.evaluate(()=>window.scrollBy(0,650));await page.getByRole('button',{name:'Mark unread: tall read fixture',exact:true}).waitFor();assert.notEqual(app.store.getPost('tall')!.readAt,null);
    await page.reload();await page.getByLabel('Read status',{exact:true}).selectOption('read');await page.waitForTimeout(350);assert.equal(await page.locator('.post-card').count(),2);
  }finally{await browser.close();await app.close();}
});
