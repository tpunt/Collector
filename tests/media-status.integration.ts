import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';
import {RequestQueue} from '../src/request-gate.ts';
import type {PostObservation} from '../src/domain.ts';

test('offline pills distinguish pending, retryable, unsupported, partial and unknown media without hiding posts or loading providers',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVQAAAAASUVORK5CYII=','base64');
 let downloads=0,release!:()=>void;
 const held=new Promise<void>(resolve=>{release=resolve;});
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async()=>{downloads++;return new Response(png,{headers:{'Content-Type':'image/png'}});}}});
 const goal=app.store.addSource({name:'aww'}),cached='https://i.redd.it/cached.png';
 const names=['Saved media','Pending media','Retryable media','External video','Partial media','Unknown status','Text only'];
 const records:PostObservation[]=names.map((title,index)=>({id:'t3_'+['a','b','c','d','e','u','t'][index],subreddit:'aww',title,body:'Stored post body',permalink:`/r/aww/comments/${['a','b','c','d','e','u','t'][index]}/`,created:{epochMs:1700000000000-index,precisionMs:1000},source:'archive',exportId:'media-status',observedAt:1800000000000,media:[index===3?'Video':index===6?'Text':'Image'],attachments:index===3||index===6?[]:[{kind:'image',url:index===0||index===4?cached:`https://i.redd.it/${index}.png`},...(index===4?[{kind:'image' as const,url:'https://i.redd.it/missing.png'}]:[])],outbound:index===3?'https://www.youtube.com/watch?v=fixture':undefined}));
 app.store.importArchiveBatch(app.store.generation,records);
 await app.media.initialize();await app.media.syncPost('a','fixture',10,new AbortController().signal);
 app.store.setMediaSync(app.store.generation,'c','failed','Temporary HTTP 503');
 app.store.setMediaSync(app.store.generation,'d','unavailable','Offline download is not supported for this embedded provider');
 app.store.setMediaSync(app.store.generation,'e','failed','Second file needs retry');
 app.store.beginFeedSync('aww',[goal]);app.store.pauseSource('aww','Stopped by user');
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage({viewport:{width:1280,height:900}}),external:string[]=[];
  await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}return route.continue();});
  await page.route('**/api/media/t3_a',async route=>{await held;await route.continue();});
  await page.route('**/api/media/t3_u',route=>route.fulfill({status:503,contentType:'application/json',body:'{"error":"Fixture local status failure"}'}));
  await page.goto(origin);
  const card=(title:string)=>page.locator('.post-card').filter({has:page.getByRole('button',{name:title,exact:true})});
  await card('Saved media').getByText('Checking local media…',{exact:true}).waitFor();
  assert.equal(await card('Saved media').getByText('Not downloaded',{exact:true}).count(),0);
  release();await card('Saved media').locator('img').waitFor();assert.equal(await card('Saved media').getByText('Not downloaded',{exact:true}).count(),0);
  for(const title of ['Pending media','Retryable media','External video']){await card(title).scrollIntoViewIfNeeded();await card(title).getByText('Not downloaded',{exact:true}).waitFor();}
  assert.match(await card('Pending media').innerText(),/Awaiting sync/);assert.match(await card('Retryable media').innerText(),/Sync this feed again to retry/);
  assert.equal(await card('External video').getByRole('link',{name:'Open original ↗',exact:true}).getAttribute('href'),'https://www.youtube.com/watch?v=fixture');
  await card('Partial media').scrollIntoViewIfNeeded();await card('Partial media').getByText('Partially downloaded',{exact:true}).waitFor();await card('Partial media').getByRole('button',{name:'Copy local path',exact:true}).waitFor();
  await card('Unknown status').scrollIntoViewIfNeeded();await card('Unknown status').getByText('Status unknown',{exact:true}).waitFor();assert.equal(await card('Unknown status').getByText('Not downloaded',{exact:true}).count(),0);
  assert.equal(await card('Text only').getByText('Not downloaded',{exact:true}).count(),0);assert.equal(await page.locator('iframe').count(),0);assert.deepEqual(external,[]);assert.equal(downloads,1);
  await card('External video').getByRole('button',{name:'External video',exact:true}).click();const drawer=page.getByRole('dialog',{name:'Thread reader'});await drawer.getByText('Not downloaded',{exact:true}).waitFor();assert.equal(await drawer.getByRole('link',{name:'Open original ↗',exact:true}).count(),1);await page.getByRole('button',{name:'Close thread',exact:true}).click();
  await page.getByRole('button',{name:/^Feeds/}).click();const feed=page.locator('[data-feed="aww"]');await feed.getByRole('button',{name:'Resume r/aww',exact:true}).waitFor();
  await feed.getByText('Incomplete',{exact:true}).waitFor();await feed.getByText('Resume continues unfinished history and retries pending or failed downloads.',{exact:true}).waitFor();assert.match(await feed.innerText(),/2 awaiting sync/);assert.match(await feed.innerText(),/2 retryable/);assert.match(await feed.innerText(),/1 unavailable/);
  assert.equal(app.store.feedSync('aww').state,'incomplete');assert.equal(downloads,1);assert.deepEqual(external,[]);
 }finally{release();await browser.close();await app.close();}
});
