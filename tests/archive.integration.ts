import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';
import {RequestQueue} from '../src/request-gate.ts';
const rows=[{id:'abc',subreddit:'python',title:'Archived photo fixture',created_utc:1577836800,url:'https://i.redd.it/archive-fixture.png',is_self:false},{id:'def',subreddit:'python',title:'Archived text fixture',created_utc:1577836801,is_self:true,selftext:'Saved archive text'}];
const json=(data:unknown[])=>new Response(JSON.stringify({data}),{headers:{'Content-Type':'application/json'}});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVQAAAAASUVORK5CYII=','base64');
async function settle(app:ReturnType<typeof createReaderServer>){const deadline=Date.now()+5000;while(app.archive.running||app.jobs.state.running){if(Date.now()>deadline)throw new Error('Archive pipeline did not finish');await delay(2);}}

test('archive HTTP workflow enforces authentication, imports a date range and automatically saves local media through the shared gate',async()=>{
 let archiveCalls=0,mediaCalls=0,browserOpens=0;const starts:number[]=[];
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:25,fromCompletion:true}),browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){browserOpens++;throw new Error('Direct archived images should not open Reddit');},async close(){},async manualSignIn(){},async navigate(){throw new Error('No Reddit navigation expected');}}},archive:{fetch:async url=>{starts.push(Date.now());archiveCalls++;assert.equal(new URL(String(url)).hostname,'arctic-shift.photon-reddit.com');return json(archiveCalls===1?rows:[]);}},media:{fetch:async()=>{starts.push(Date.now());mediaCalls++;return new Response(png,{headers:{'Content-Type':'image/png'}});}}});
 const origin=await app.listen();
 try{
  const {token}=await(await fetch(origin+'/api/state')).json();const post=(path:string,data:unknown,auth=true)=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Reader-Token':token}:{})},body:JSON.stringify(data)});
  assert.equal((await post('archive/start',{subreddit:'python',from:'2020-01-01',to:'2020-01-01'},false)).status,403);
  assert.equal((await post('archive/start',{subreddit:'python',from:'2020-02-30',to:'2020-03-01'})).status,400);assert.equal(archiveCalls,0);
  const response=await post('archive/start',{subreddit:'r/Python',from:'2020-01-01',to:'2020-01-01'});assert.equal(response.status,200);const {id}=await response.json();await settle(app);
  const state=await(await fetch(origin+'/api/state')).json();assert.equal(state.archives[0].state,'done');assert.equal(state.archives[0].id,id);assert.equal(state.archives[0].offline.ready,1);assert.equal(state.feeds[0].sync.lastSuccessAt,null);assert.equal(state.stats.posts,2);assert.equal(state.job.requests.sessionTotal,3);assert.equal(archiveCalls,2);assert.equal(mediaCalls,1);assert.equal(browserOpens,0);assert(starts.slice(1).every((time,i)=>time-starts[i]!>=20));
  const media=await(await fetch(origin+'/api/media/t3_abc')).json();assert.equal(media.items[0].state,'ready');assert.deepEqual(Buffer.from(await(await fetch(origin+media.items[0].url)).arrayBuffer()),png);assert(media.items[0].localPath);assert.equal(archiveCalls,2);assert.equal(mediaCalls,1);assert.equal((await post('archive/resume',{id})).status,400);
  assert.equal((await post('clear-source',{name:'python',confirm:true})).status,200);assert.equal(app.store.archiveFetches().length,0);assert.equal((await fetch(origin+media.items[0].url)).status,404);
 }finally{await app.close();}
});

test('Stop, Resume, scoped Clear and global Clear cancel archive requests and preserve unrelated feeds',async()=>{
 let calls=0,aborts=0;
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},archive:{fetch:async(_url,options)=>{calls++;return new Promise((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>{aborts++;reject(new Error('Fixture aborted'));},{once:true}));}}});app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,[{id:'keep',subreddit:'aww',title:'Unrelated saved post',permalink:'/r/aww/comments/keep/',created:{epochMs:1577836800000,precisionMs:1000},source:'archive',exportId:'keep',observedAt:Date.now(),media:['Text']}]);const origin=await app.listen();
 try{
  const {token}=await(await fetch(origin+'/api/state')).json(),post=(path:string,data:unknown)=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token},body:JSON.stringify(data)});
  const {id}=await(await post('archive/start',{subreddit:'python',from:'2020-01-01',to:'2020-01-01'})).json();while(calls<1)await delay(1);assert.equal((await post('archive/start',{subreddit:'aww',to:'2020-01-01'})).status,400);assert.equal((await post('archive/stop',{id:'wrong'})).status,400);
  assert.equal((await post('archive/stop',{id})).status,200);assert.equal(app.store.archiveFetch(id)?.state,'paused');assert.equal(aborts,1);assert.equal((await post('archive/resume',{id})).status,200);while(calls<2)await delay(1);
  assert.equal((await post('clear-source',{name:'python',confirm:true})).status,200);assert.equal(aborts,2);assert.equal(app.store.archiveFetch(id),null);assert(app.store.getPost('keep'));assert.equal((await post('archive/resume',{id})).status,400);
  await post('archive/start',{subreddit:'python',to:'2020-01-01'});while(calls<3)await delay(1);assert.equal((await post('clear',{})).status,200);assert.equal(aborts,3);assert.equal(app.store.archiveFetches().length,0);assert.equal(app.store.stats().posts,0);
 }finally{await app.close();}
});

test('archive UI accepts subreddit and dates, stops/resumes, restores progress on reload and displays offline media',async()=>{
 let calls=0;
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},archive:{fetch:async(_url,options)=>{calls++;if(calls===1)return new Promise((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>reject(new Error('Stopped fixture')),{once:true}));return json(calls===2?rows:[]);}},media:{fetch:async()=>new Response(png,{headers:{'Content-Type':'image/png'}})}});
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.goto(origin);await page.getByRole('button',{name:'Import an archive',exact:true}).click();const dialog=()=>page.getByRole('dialog',{name:'Import archive',exact:true});
  await dialog().getByRole('button',{name:'Fetch from archive',exact:true}).waitFor();assert.equal(await dialog().getByLabel('Archive file',{exact:true}).count(),0);await dialog().getByRole('button',{name:'Use all available history',exact:true}).click();assert.equal(await dialog().getByLabel('From (optional)',{exact:true}).inputValue(),'');
  await dialog().getByLabel('Subreddit',{exact:true}).fill('r/Python');await dialog().getByLabel('From (optional)',{exact:true}).fill('2020-01-01');await dialog().getByLabel('To',{exact:true}).fill('2020-01-01');await dialog().getByRole('button',{name:'Fetch archive',exact:true}).click();await dialog().getByRole('button',{name:'Stop archive',exact:true}).waitFor();await dialog().getByRole('button',{name:'Stop archive',exact:true}).click();await dialog().getByText('Paused',{exact:true}).waitFor();assert.equal(app.store.followedSources()[0],'python');
  await page.reload();await page.getByRole('button',{name:'Import an archive',exact:true}).click();await dialog().getByText('Paused',{exact:true}).waitFor();await dialog().getByRole('button',{name:'Resume archive',exact:true}).click();await dialog().getByText('Finished',{exact:true}).waitFor();await dialog().getByText('Media 1/1 offline',{exact:true}).waitFor();assert.equal(calls,3);assert.equal(app.store.stats().posts,2);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await dialog().getByRole('button',{name:'Close dialog',exact:true}).click();await page.waitForFunction(()=>{const image=document.querySelector('.post-media img') as HTMLImageElement|null;return image?.naturalWidth===1;});assert.equal(await page.getByRole('button',{name:'Copy local path',exact:true}).count(),1);assert.equal(await page.getByRole('checkbox').count(),0);assert.equal(calls,3);
 }finally{await browser.close();await app.close();}
});
