import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';
import {ReaderStore} from '../src/store.ts';
import {RequestQueue} from '../src/request-gate.ts';
const record={id:'saved',subreddit:'aww',title:'Saved offline text',body:'Previously collected content',permalink:'/r/aww/comments/saved/',created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,exportId:'startup-fixture',observedAt:1800000000000,media:['Text' as const]};

for(const previous of [undefined,false,true])test(`server starts offline with previous permission ${previous}, blocks all collection, and keeps saved content`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'collector-start-offline-')),database=join(directory,'reader.sqlite');let starts=0;
 const stored=new ReaderStore(database);stored.addSource({name:'aww',historyMonths:1},Date.now());stored.importArchiveBatch(stored.generation,[record]);
 if(previous!==undefined)stored.setSetting('offlineMode',previous);
 stored.setSetting('offlineResume',{generation:stored.generation,feeds:['aww'],tasks:[],archive:null,signIn:false});stored.close();
 const network=new RequestQueue({intervalMs:0}),app=createReaderServer({database,port:0,jobs:{network,browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:0},async open(){starts++;},async close(){},async manualSignIn(){starts++;},async navigate(){starts++;return {}as any;}},readListing:async()=>({account:'fixture_user',posts:[],ordinary:[],unknownTime:false,omissions:0,next:null,empty:true,signature:'empty'})},media:{fetch:async()=>{starts++;throw new Error('No media request expected');}},archive:{fetch:async()=>{starts++;return Response.json({data:[]});}}});
 try{
  assert.equal(network.offline,true,'The gate must be active before listen');assert.equal(app.store.getSetting('offlineMode'),true);assert.equal(app.networkMode.status.offline,true);assert.equal(app.jobs.state.running,false);
  assert.deepEqual(app.networkMode.status.paused.feeds,previous===true?['aww']:[],'Only a genuine saved Offline resume plan is retained');
  const origin=await app.listen(),state=await(await fetch(origin+'/api/state')).json();assert.equal(state.network.offline,true);assert.equal(state.stats.posts,1);
  const post=(path:string,data:unknown)=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':state.token},body:JSON.stringify(data)});
  for(const [path,data] of [['sync',{}],['sources',{name:'python'}],['history',{name:'aww',months:3}],['thread',{id:'saved'}],['sign-in',{}],['archive/start',{subreddit:'aww',from:'2020-01-01',to:'2021-01-01'}]]as const){const response=await post(path,data);assert.equal(response.status,400);assert.match((await response.json()).error,/Offline mode/);}
  assert.equal((await fetch(origin+'/online-player?url='+encodeURIComponent('https://www.youtube.com/watch?v=fixture'))).status,400);
  const feed=await(await fetch(origin+'/api/feed')).json();assert.equal(feed.posts[0].body,record.body);assert.equal((await post('read',{id:'saved',read:true})).status,200);assert.equal(starts,0);assert.equal(app.problems.status.groups,0);
  app.networkMode.cancel();assert.equal((await post('offline',{offline:false})).status,200);assert.equal(network.offline,false);assert.equal(starts,0,'Permission alone does not invent work to run');assert.equal((await post('sync',{})).status,200);
  const end=Date.now()+5000;while(app.jobs.state.running){if(Date.now()>end)throw new Error('Startup fixture did not settle');await new Promise(resolve=>setTimeout(resolve,5));}assert(starts>0);
 }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});

test('online consent survives a page reload but never a server restart; cached player posts start offline again',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'collector-start-player-')),database=join(directory,'reader.sqlite');let requests=0;
 const options=()=>({database,port:0,jobs:{network:new RequestQueue({intervalMs:0})}});let app=createReaderServer(options());
 app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,[{...record,id:'online',title:'Online video fixture',permalink:'/r/aww/comments/online/',media:['Video'],outbound:'https://www.youtube.com/watch?v=fixture'}]);app.store.setMediaSync(app.store.generation,'online','unavailable','Online provider');
 const firstOrigin=await app.listen(),port=Number(new URL(firstOrigin).port),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const context=await browser.newContext();await context.route('**/*',route=>{if(route.request().url().startsWith(firstOrigin))return route.continue();requests++;return route.fulfill({contentType:'text/html',body:'<p>Local provider fixture</p>'});});
  const page=await context.newPage();await page.goto(firstOrigin);await page.getByRole('switch',{name:'Offline mode',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector('[role="switch"]')?.getAttribute('aria-checked')==='true');assert.equal(requests,0);assert.equal(await page.locator('iframe').count(),0);
  await page.getByRole('switch',{name:'Offline mode',exact:true}).click();await page.waitForFunction(()=>document.querySelector('iframe'));assert.equal(app.networkMode.status.offline,false);await page.frameLocator('iframe').frameLocator('iframe').getByText('Local provider fixture',{exact:true}).waitFor();assert(requests>0);
  await page.reload();await page.waitForFunction(()=>document.querySelector('[role="switch"]')?.getAttribute('aria-checked')==='false');assert.equal(app.networkMode.status.offline,false,'Reloading a tab does not restart its server');await page.frameLocator('iframe').frameLocator('iframe').getByText('Local provider fixture',{exact:true}).waitFor();
  await app.close();await page.waitForFunction(()=>!document.querySelector('iframe'));const before=requests;app=createReaderServer(options());assert.equal(await app.listen(port),firstOrigin);assert.equal(app.networkMode.status.offline,true);
  await page.reload();await page.waitForFunction(()=>document.querySelector('[role="switch"]')?.getAttribute('aria-checked')==='true');await page.getByText('Offline mode is on. External requests are paused.',{exact:true}).waitFor();await page.getByRole('button',{name:'Online video fixture',exact:true}).waitFor();await page.waitForTimeout(150);assert.equal(requests,before,'A formerly online library must not load providers after restarting');assert.equal(await page.locator('iframe').count(),0);
  await page.getByRole('switch',{name:'Offline mode',exact:true}).click();await page.waitForFunction(()=>document.querySelector('iframe'));assert.equal(app.networkMode.status.offline,false);
 }finally{await app.close();await browser.close();await rm(directory,{recursive:true,force:true});}
});
