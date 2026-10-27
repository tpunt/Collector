import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';

test('the app searches titles, bodies or both and keeps filters usable at mobile width',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,[['aaa','Needle title','Other body'],['bbb','Other title','Needle body']].map(([id,title,body])=>({id:id!,subreddit:'python',title:title!,body,permalink:`/r/python/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'search-ui',observedAt:1800000000000,media:['Text']})));
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.goto(origin);await page.getByLabel('Search stored posts',{exact:true}).fill('needle');await page.waitForTimeout(350);assert.equal(await page.locator('.post-card').count(),2);
  await page.getByLabel('Search scope',{exact:true}).selectOption('title');await page.waitForTimeout(350);assert.equal(await page.locator('.post-card').count(),1);assert.equal(await page.locator('.post-title').textContent(),'Needle title');
  await page.getByLabel('Search scope',{exact:true}).selectOption('body');await page.waitForTimeout(350);assert.equal(await page.locator('.post-title').textContent(),'Other title');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert((await page.getByLabel('Search scope',{exact:true}).boundingBox())!.width>100);
 }finally{await browser.close();await app.close();}
});
