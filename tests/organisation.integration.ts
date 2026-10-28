import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createOnlineReaderServer} from './online-fixture.ts';
import {RequestQueue} from '../src/request-gate.ts';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVQAAAAASUVORK5CYII=','base64');
const record=(id:string)=>({id,subreddit:'aww',title:'Organise '+id,body:'Saved caption',permalink:`/r/aww/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,exportId:'organise',observedAt:1800000000000,media:['Image' as const],attachments:[{kind:'image' as const,url:'https://i.redd.it/organise.png'}]});
test('tags combine with image/media filters; keyboard reading, bulk read and favourite-safe cleanup work entirely locally',async()=>{
 const app=await createOnlineReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async()=>new Response(png,{headers:{'Content-Type':'image/png'}})}});
 app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,[record('aaa'),record('bbb'),record('ccc')]);
 for(const id of ['aaa','bbb','ccc'])await app.media.syncPost(id,'fixture',10,new AbortController().signal);
 await app.networkMode.change(true);const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage({viewport:{width:1200,height:900}}),external:string[]=[];
  await page.route('**/*',route=>{if(route.request().url().startsWith(origin))return route.continue();external.push(route.request().url());return route.abort();});
  await page.addInitScript(()=>{Object.defineProperty(document,'visibilityState',{get:()=> 'hidden'});Object.defineProperty(document,'fullscreenEnabled',{get:()=>false});});
  await page.goto(origin);await page.locator('.post-card').first().waitFor();
  await page.getByRole('button',{name:'Edit tags: Organise aaa',exact:true}).click();await page.getByLabel('Tag',{exact:true}).fill('Inspiration');await page.getByRole('button',{name:'Save tags',exact:true}).click();
  await page.getByRole('dialog',{name:'Edit post tags'}).waitFor({state:'detached'});assert.deepEqual(app.store.getPost('aaa')!.tags,['inspiration']);
  await page.getByLabel('Tag filter').selectOption('inspiration');await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1);
  for(const kind of ['Image','Media']){await page.getByRole('button',{name:kind,exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1&&Boolean((document.querySelector('.post-media img')as HTMLImageElement)?.naturalWidth));}
  await page.getByRole('button',{name:'View image full screen: Organise aaa',exact:true}).click();await page.getByRole('dialog',{name:'Full screen: Organise aaa'}).waitFor();
  await page.evaluate(()=>document.body.focus());await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'Full screen: Organise aaa'}).waitFor({state:'hidden'});
  await page.getByRole('button',{name:'Mark matching posts read',exact:true}).click();await page.getByRole('button',{name:'Mark all matching posts read',exact:true}).click();await page.getByRole('dialog',{name:'Mark matching posts read?'}).waitFor({state:'detached'});assert.notEqual(app.store.getPost('aaa')!.readAt,null);assert.equal(app.store.getPost('bbb')!.readAt,null);
  await page.getByLabel('Tag filter').selectOption('');await page.getByRole('button',{name:'All posts',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===3);
  await page.locator('h1').click();await page.keyboard.press('j');assert.equal(await page.locator('.keyboard-active').getAttribute('data-post-id'),'t3_ccc');await page.keyboard.press('j');assert.equal(await page.locator('.keyboard-active').getAttribute('data-post-id'),'t3_bbb');await page.keyboard.press('k');assert.equal(await page.locator('.keyboard-active').getAttribute('data-post-id'),'t3_ccc');
  await page.keyboard.press('o');await page.getByRole('dialog',{name:'Thread details'}).waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'Thread details'}).waitFor({state:'hidden'});
  await page.locator('h1').click();await page.keyboard.press('j');await page.keyboard.press('r');await page.waitForFunction(()=>document.querySelector('[data-post-id="t3_bbb"]')?.getAttribute('data-read')==='true');
  await page.getByLabel('Search stored posts',{exact:true}).fill('jjkk');await page.waitForTimeout(250);assert.equal(await page.locator('.keyboard-active').count(),0);await page.getByLabel('Search stored posts',{exact:true}).fill('');await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===3);
  await page.getByRole('button',{name:'Favourite post: Organise aaa',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Manage storage',exact:true}).click();await page.locator('.storage-table').waitFor();
  const protect=page.getByLabel('Exclude favourite posts',{exact:true});assert(await protect.isChecked());await page.getByLabel('Read posts only',{exact:true}).uncheck();await page.getByRole('button',{name:'Preview deletion',exact:true}).click();await page.getByRole('button',{name:'Delete 2 posts',exact:true}).waitFor();
  await protect.uncheck();await page.getByRole('group',{name:'Confirm selective deletion'}).waitFor({state:'detached'});await page.getByRole('button',{name:'Preview deletion',exact:true}).click();await page.getByRole('button',{name:'Delete 3 posts',exact:true}).waitFor();await page.getByRole('button',{name:'Keep posts',exact:true}).click();
  assert.equal(app.store.stats().posts,3);assert.deepEqual(external,[]);
 }finally{await browser.close();await app.close();}
});

test('tag and bulk read routes require authentication, matching contexts and a confirmed, current library selection',async()=>{
 const app=await createOnlineReaderServer({database:':memory:',port:0});app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,[record('aaa')]);const origin=await app.listen();
 try{
  const state=await(await fetch(origin+'/api/state')).json(),context=app.store.getPost('aaa')!.readContext;
  const post=(path:string,data:unknown,auth=true)=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Reader-Token':state.token}:{})},body:JSON.stringify(data)});
  assert.equal((await post('tags',{id:'aaa',context,tags:['photo']},false)).status,403);assert.equal((await post('tags',{id:'aaa',context:'stale',tags:['photo']})).status,400);
  assert.equal((await post('tags',{id:'aaa',context,tags:['photo']})).status,200);
  const input={query:'tag=photo&media=Image',confirm:true,generation:app.store.generation,revision:app.store.contentRevision};
  assert.equal((await post('read/bulk',input,false)).status,403);assert.equal((await post('read/bulk',{...input,confirm:false})).status,400);assert.equal((await post('read/bulk',{...input,revision:-1})).status,400);
  assert.equal((await post('read/bulk',input)).status,200);assert.notEqual(app.store.getPost('aaa')!.readAt,null);
 }finally{await app.close();}
});
