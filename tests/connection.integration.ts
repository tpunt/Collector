import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';

test('an empty library shows its normal empty state without collection or error notices',async()=>{
 const app=createReaderServer({database:':memory:',port:0}),origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage(),mutations:string[]=[],remote:string[]=[];
  page.on('request',request=>{if(request.method()!=='GET')mutations.push(request.url());if(!request.url().startsWith(origin))remote.push(request.url());});
  await page.goto(origin+'/#feeds');await page.waitForResponse(response=>response.url()===origin+'/api/state');
  assert.equal(await page.getByRole('heading',{name:'No feeds yet',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'Sync all',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:/^All feeds/}).click();await page.locator('main').getByRole('button',{name:'Manage feeds',exact:true}).waitFor();
  assert.equal(await page.getByRole('alert').count(),0);assert.deepEqual(mutations,[]);assert.deepEqual(remote,[]);assert.equal(app.jobs.state.requests.sessionTotal,0);
 }finally{await browser.close();await app.close();}
});

test('startup connection failures clear automatically when the empty local library becomes reachable',async()=>{
 const app=createReaderServer({database:':memory:',port:0}),origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});let offline=true;
 try{
  const page=await browser.newPage();await page.route('**/api/**',route=>offline?route.abort('failed'):route.continue());await page.goto(origin+'/#feeds');await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('heading',{name:'No feeds yet',exact:true}).count(),0,'The library is not known to be empty until state has loaded');
  assert.match(await page.getByRole('alert').innerText(),/Cannot connect to Collector/);
  offline=false;await page.getByRole('heading',{name:'No feeds yet',exact:true}).waitFor();await page.getByRole('alert').waitFor({state:'hidden',timeout:6000});
  assert.equal(app.store.feedSources().length,0);assert.equal(app.jobs.state.requests.sessionTotal,0);
 }finally{await browser.close();await app.close();}
});

test('a failed filtered feed is retried even without data changes, and successful state polling does not hide its failure',async()=>{
 const app=createReaderServer({database:':memory:',port:0}),origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});let failFeed=true,failedRequests=0;
 try{
  const page=await browser.newPage();await page.route('**/api/feed?*',route=>{
   if(new URL(route.request().url()).searchParams.get('q')==='missing'&&failFeed){failedRequests++;return route.abort('failed');}return route.continue();
  });
  await page.goto(origin);await page.waitForResponse(response=>response.url()===origin+'/api/state');await page.getByRole('heading',{name:'No feeds yet',exact:true}).waitFor();
  await page.getByRole('searchbox',{name:'Search stored posts',exact:true}).fill('missing');await page.getByRole('alert').waitFor();await page.waitForResponse(response=>response.url()===origin+'/api/state');
  assert.equal(await page.getByRole('alert').count(),1,'Successful state polling must not conceal a failed feed read');
  failFeed=false;await page.getByRole('alert').waitFor({state:'hidden',timeout:6000});assert(failedRequests>=1);assert.equal(app.jobs.state.requests.sessionTotal,0);
 }finally{await browser.close();await app.close();}
});

test('a failed obsolete filter request cannot add an error after a newer view has loaded',async()=>{
 const app=createReaderServer({database:':memory:',port:0}),origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),began=new Promise<void>(resolve=>{entered=resolve;});
 try{
  const page=await browser.newPage();await page.route('**/api/feed?*',async route=>{
   if(new URL(route.request().url()).searchParams.get('q')==='obsolete'){entered();await gate;await route.abort('failed');}else await route.continue();
  });
  await page.goto(origin);await page.getByRole('heading',{name:'No feeds yet',exact:true}).waitFor();const search=page.getByRole('searchbox',{name:'Search stored posts',exact:true});
  await search.fill('obsolete');await began;await search.fill('current');await page.waitForResponse(response=>new URL(response.url()).searchParams.get('q')==='current');
  const failed=page.waitForEvent('requestfailed',request=>new URL(request.url()).searchParams.get('q')==='obsolete');release();await failed;
  await page.waitForResponse(response=>response.url()===origin+'/api/state');assert.equal(await page.getByRole('alert').count(),0);assert.equal(app.jobs.state.requests.sessionTotal,0);
 }finally{release();await browser.close();await app.close();}
});
