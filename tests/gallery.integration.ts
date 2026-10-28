import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {discoverMedia} from '../src/media-discovery.ts';
import {galleryFixture} from './fixtures/gallery.ts';
import {completeCollection} from '../src/media-reference.ts';
import {createOnlineReaderServer} from './online-fixture.ts';
import {RequestQueue} from '../src/request-gate.ts';
import {archivePost} from '../src/archive.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('native gallery controls expose every ordered original, including more than twenty slides and duplicate files',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.route('https://**/*',route=>route.abort());
  for(const count of [2,25]){
   await page.setContent(galleryFixture(count));
   const refs=await discoverMedia(page,'abc',()=>[],new AbortController().signal);
   assert.equal(refs.length,count);assert(completeCollection('reddit:t3_abc',refs));assert.deepEqual(refs.map(r=>r.url),Array.from({length:count},(_,i)=>`https://i.redd.it/gallery${i}.jpg`));
   assert(refs.every(r=>!r.url.includes('width=960')));
   assert.deepEqual(refs.map(r=>r.caption),Array.from({length:count},(_,i)=>`Caption ${i+1}`));
  }
  await page.setContent(galleryFixture(2,{duplicate:true}));const duplicate=await discoverMedia(page,'abc',()=>[],new AbortController().signal);assert.equal(duplicate.length,2);assert.equal(duplicate[0]?.url,duplicate[1]?.url);assert(completeCollection('reddit:t3_abc',duplicate));
  await page.setContent(galleryFixture(2,{badSlide:1}));await assert.rejects(discoverMedia(page,'abc',()=>[],new AbortController().signal),/Gallery slide did not expose a supported file/);
 }finally{await browser.close();}
});

test('an archived gallery saves every file and caption without Reddit, and all files remain viewable after restart with external traffic blocked',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-offline-gallery-ui-')),database=join(directory,'reader.sqlite'),mediaDirectory=join(directory,'media');let downloads=0;
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVQAAAAASUVORK5CYII=','base64');
 let app=await createOnlineReaderServer({database,port:0,jobs:{network:new RequestQueue({intervalMs:0}),browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){assert.fail('A complete archive gallery needs no Reddit page');},async close(){},async manualSignIn(){},async navigate(){assert.fail('A complete archive gallery needs no Reddit page');}}},media:{directory:mediaDirectory,fetch:async()=>{downloads++;return new Response(png,{headers:{'Content-Type':'image/png'}});}}});
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,[archivePost({id:'abc',subreddit:'aww',title:'Offline gallery fixture',created_utc:1700000000,is_gallery:true,url:'https://www.reddit.com/gallery/abc',gallery_data:{items:[{media_id:'one',caption:'First caption'},{media_id:'two',caption:'Second caption'}]},media_metadata:{one:{status:'valid',e:'Image',s:{u:'https://i.redd.it/one.png'}},two:{status:'valid',e:'Image',s:{u:'https://i.redd.it/two.png'}}}},'aww','offline-gallery',Date.now())]);
  await app.jobs.archiveMedia(['t3_abc'],new AbortController().signal);assert.equal(downloads,2);await app.close();
  app=await createOnlineReaderServer({database,port:0,media:{directory:mediaDirectory,fetch:async()=>assert.fail('Reading cached gallery files must not use a website')}});
  const origin=await app.listen(),page=await browser.newPage(),external:string[]=[];
  await page.route('**/*',route=>{if(!route.request().url().startsWith(origin)){external.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto(origin);const card=page.locator('.post-card');await card.getByText('2/2 files saved offline · Scroll horizontally to view all',{exact:true}).waitFor();assert.equal(await card.getByText('Not downloaded',{exact:true}).count(),0);assert.equal(await card.locator('img').count(),2);
  await page.waitForFunction(()=>(document.querySelector('.media-items img')as HTMLImageElement)?.naturalWidth===1);await card.locator('.media-items').evaluate(el=>{el.scrollLeft=el.scrollWidth;});
  await page.waitForFunction(()=>[...document.querySelectorAll('.media-items img')].every(img=>(img as HTMLImageElement).naturalWidth===1));await card.getByText('Second caption',{exact:true}).waitFor();assert.equal(await card.getByText('First caption',{exact:true}).count(),1);assert.equal((await card.getByRole('button',{name:'Copy local path',exact:true}).getAttribute('title'))?.split('\n').length,2);assert.deepEqual(external,[]);assert.equal(app.store.mediaSync('abc')?.status,'ready');assert.equal(app.jobs.state.requests.sessionTotal,0);
  await page.reload();await card.getByText('2/2 files saved offline · Scroll horizontally to view all',{exact:true}).waitFor();assert.equal(downloads,2);assert.deepEqual(external,[]);
 }finally{await browser.close();await app.close();await rm(directory,{recursive:true,force:true});}
});

test('a stalled gallery stays retryable and an interrupted traversal cannot return a partial collection',async t=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.route('https://**/*',route=>route.abort());await page.setContent(galleryFixture(2,{stuck:true}));
  const now=Date.now;let ticks=0;const clock=t.mock.method(Date,'now',()=>now()+(ticks++*5000));
  try{await assert.rejects(discoverMedia(page,'abc',()=>[],new AbortController().signal),/Gallery slide did not finish loading/);}finally{clock.mock.restore();}
  await page.setContent(galleryFixture(2));const controller=new AbortController();controller.abort();await assert.rejects(discoverMedia(page,'abc',()=>[],controller.signal),{name:'AbortError'});
 }finally{await browser.close();}
});
