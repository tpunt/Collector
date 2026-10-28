import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';
import {RequestQueue} from '../src/request-gate.ts';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVQAAAAASUVORK5CYII=','base64');
const record=(id:string)=>({id,subreddit:'aww',permalink:`/r/aww/comments/${id}/`,title:'Image '+id,created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,observedAt:Date.now(),exportId:'report',media:['Image' as const],attachments:[{kind:'image' as const,url:`https://i.redd.it/${id}.png`}]});
async function settle(app:ReturnType<typeof createReaderServer>){const end=Date.now()+15000;while(app.jobs.state.running){if(Date.now()>end)throw new Error('Retry did not settle');await delay(5);}}
test('targeted retry is explicit, skips unavailable/saved media and leaves history and body work unchanged; report is usable offline',async()=>{
 let downloads=0,visits=0,fail=true;
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0}),browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:0},async open(){visits++;throw new Error('Retry must not collect listings or post text');},async navigate(){throw new Error('No navigation');},async close(){},async manualSignIn(){}}},media:{fetch:async()=>{downloads++;return fail?new Response('failed',{status:500}):new Response(png,{headers:{'Content-Type':'image/png'}});}}});
 app.store.addSource({name:'aww',historyMonths:1});app.store.importArchiveBatch(app.store.generation,[record('abc'),record('def')]);app.store.setMediaSync(app.store.generation,'def','unavailable','Media unavailable (HTTP 404)');
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const state=await(await fetch(origin+'/api/state')).json(),post=(path:string,data:unknown,auth=true)=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Reader-Token':state.token}:{})},body:JSON.stringify(data)});
  const target=app.store.listTargets()[0]!;const run=app.store.beginFeedSync('aww',[target.id]);app.store.commitBatch({generation:app.store.generation,targetId:target.id,observations:[],continuation:null,status:'done',completion:'listing-end'});app.store.finishFeedSync('aww',run);
  const checkpoints=app.store.listTargets();assert.equal((await post('media/retry',{names:['aww']})).status,400);assert.equal(downloads,0);
  assert.equal((await post('media/retry',{names:['aww']},false)).status,403);await post('offline',{offline:false});
  assert.equal((await post('media/retry',{names:['aww']})).status,200);await settle(app);assert.equal(app.store.mediaSync('abc')!.status,'failed');
  let reports=(await(await fetch(origin+'/api/state')).json()).feeds[0].report;assert.equal(reports.kind,'retry');assert.equal(reports.state,'paused');assert.equal(reports.filesSaved,0);
  fail=false;await post('media/retry',{names:['aww']});await settle(app);assert.equal(downloads,2);assert.equal(visits,0);assert.deepEqual(app.store.listTargets(),checkpoints);assert.equal(app.store.mediaSync('def')!.status,'unavailable');assert.equal(app.store.feedSync('aww').state,'gaps');assert(!app.store.feedSync('aww').reason?.includes('still need saving'));
  reports=(await(await fetch(origin+'/api/state')).json()).feeds[0].report;assert.equal(reports.state,'finished');assert.equal(reports.filesSaved,1);assert.equal(reports.newPosts,0);assert.equal(reports.bytesSaved,png.length);
  await post('media/retry',{names:['aww']});await settle(app);assert.equal(downloads,2);await post('offline',{offline:true});
  const page=await browser.newPage();await page.goto(origin+'/#feeds');await page.getByRole('button',{name:'Collection report for r/aww',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Collection report · r/aww',exact:true});await dialog.getByText('Unavailable / online only',{exact:true}).waitFor();assert(await dialog.getByRole('button',{name:'Retry incomplete downloads',exact:true}).isDisabled());
  await dialog.getByRole('button',{name:'Image def',exact:true}).click();await page.getByRole('dialog',{name:'Thread details',exact:true}).waitFor();assert.equal(downloads,2);assert.equal(visits,0);
 }finally{await browser.close();await app.close();}
});

test('each explicit retry has a fresh attempt id while another feed keeps the worker alive',async()=>{
 let attempts=0,otherStarted=false,releaseOther!:()=>void;
 const held=new Promise<void>(resolve=>{releaseOther=resolve;});
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async input=>{if(String(input).includes('other')){otherStarted=true;await held;return new Response(png,{headers:{'Content-Type':'image/png'}});}attempts++;return attempts===1?new Response('temporary',{status:500}):new Response(png,{headers:{'Content-Type':'image/png'}});}}});
 try{
  app.store.addSource({name:'aww',historyMonths:1});app.store.addSource({name:'pics',historyMonths:1});app.store.importArchiveBatch(app.store.generation,[record('abc'),{...record('other'),subreddit:'pics',permalink:'/r/pics/comments/other/'}]);await app.listen();await app.networkMode.change(false);
  app.jobs.retryMedia(['aww']);app.jobs.syncMedia(['pics'],{resume:true});const end=Date.now()+15000;while(!otherStarted){if(Date.now()>end)throw new Error('Other feed did not hold the worker');await delay(5);}
  assert.equal(attempts,1);assert.equal(app.store.mediaSync('abc')!.status,'failed');assert.equal(app.jobs.feedStatus('aww'),'idle');
  app.jobs.retryMedia(['aww']);releaseOther();await settle(app);assert.equal(attempts,2);assert.equal(app.store.mediaSync('abc')!.status,'ready');
 }finally{releaseOther?.();await app.close();}
});

test('Offline mode pauses and resumes only the targeted retry, with no listing scan',async()=>{
 let attempts=0,started=false;
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async(_input,init)=>{attempts++;if(attempts===1){started=true;return new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('Paused fixture transfer')),{once:true}));}return new Response(png,{headers:{'Content-Type':'image/png'}});}}});
 try{
  app.store.addSource({name:'aww',historyMonths:1});app.store.importArchiveBatch(app.store.generation,[record('abc')]);const origin=await app.listen(),targets=app.store.listTargets();await app.networkMode.change(false);app.jobs.retryMedia(['aww']);
  const end=Date.now()+15000;while(!started){if(Date.now()>end)throw new Error('Transfer did not start');await delay(5);}
  await app.networkMode.change(true);let report=(await(await fetch(origin+'/api/state')).json()).feeds[0].report;assert.equal(report.state,'paused');assert.match(report.reason,/Offline mode/);assert.equal(app.store.mediaSync('abc')!.status,'pending');
  await app.networkMode.change(false);await settle(app);assert.equal(attempts,2);assert.equal(app.store.mediaSync('abc')!.status,'ready');assert.deepEqual(app.store.listTargets().map(({status,reason,...checkpoint})=>checkpoint),targets.map(({status,reason,...checkpoint})=>checkpoint));report=(await(await fetch(origin+'/api/state')).json()).feeds[0].report;assert.equal(report.kind,'retry');assert.equal(report.state,'finished');assert.equal(report.filesSaved,1);
 }finally{await app.close();}
});

test('a rejected retry displays its cooldown reason inside the collection report dialog',async()=>{
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})}});app.store.addSource({name:'aww',historyMonths:1});app.store.importArchiveBatch(app.store.generation,[record('abc')]);const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{await app.networkMode.change(false);const page=await browser.newPage();await page.goto(origin+'/#feeds');await page.getByRole('button',{name:'Collection report for r/aww',exact:true}).click();app.store.setSetting('accessPause',{reason:'Fixture service cooldown',notBefore:Date.now()+60000});const dialog=page.getByRole('dialog',{name:'Collection report · r/aww',exact:true});await dialog.getByRole('button',{name:'Retry incomplete downloads',exact:true}).click();await dialog.getByRole('alert').filter({hasText:'Cooldown lasts until'}).waitFor();assert.equal(app.media.status.requests,0);}
 finally{await browser.close();await app.close();}
});

test('a missing cached file returns a clean404 and becomes pending rather than advertising an offline copy',async()=>{
 const {rm}=await import('node:fs/promises');const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async()=>new Response(png,{headers:{'Content-Type':'image/png'}})}});app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,[record('abc')]);
 try{const origin=await app.listen();await app.networkMode.change(false);await app.media.syncPost('abc','fixture',5,new AbortController().signal);const item=(await app.media.items('abc'))[0]!;await rm(item.localPath!);const response=await fetch(origin+item.url);assert.equal(response.status,404);assert.equal(app.store.mediaSync('abc')!.status,'pending');assert.equal((await app.media.items('abc'))[0]!.state,'idle');}
 finally{await app.close();}
});

test('Tumblr CDN throttling is isolated, while throttling on a shared Reddit CDN still pauses every source',async()=>{
 for(const tumblrHost of [true,false]){
  const calls:string[]=[];const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async input=>{const url=String(input);calls.push(url);return url.includes('limited')?new Response('limited',{status:429,headers:{'Retry-After':'60'}}):new Response(png,{headers:{'Content-Type':'image/png'}});}}});
  try{app.store.addSubreddit('tumblr:staff');app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,[{...record('abc'),id:'tumblr:staff:12345',subreddit:'tumblr:staff',permalink:'https://staff.tumblr.com/post/12345/',attachments:[{kind:'image',url:tumblrHost?'https://64.media.tumblr.com/limited.png':'https://i.redd.it/limited.png',collection:{id:'tumblr:staff:12345',index:0,total:1}}]},record('def')]);await app.listen();await app.networkMode.change(false);app.jobs.retryMedia(['tumblr:staff','aww']);await settle(app);assert.equal(calls.length,tumblrHost?2:1);assert.equal(Boolean(app.jobs.state.accessPause),!tumblrHost);assert.equal(Boolean(app.jobs.state.sourcePause),tumblrHost);if(tumblrHost)assert.equal(app.store.mediaSync('def')!.status,'ready');}
  finally{await app.close();}
 }
});

test('the media cache itself enforces a saved Tumblr pause even when called outside the job worker',async()=>{
 let requests=0;const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async()=>{requests++;return new Response(png,{headers:{'Content-Type':'image/png'}});}}});app.store.addSubreddit('tumblr:staff');app.store.importArchiveBatch(app.store.generation,[{...record('abc'),id:'tumblr:staff:12345',subreddit:'tumblr:staff',permalink:'https://staff.tumblr.com/post/12345/',attachments:[{kind:'image',url:'https://64.media.tumblr.com/paused.png',collection:{id:'tumblr:staff:12345',index:0,total:1}}]}]);
 try{await app.listen();await app.networkMode.change(false);app.store.setSetting('accessPause:tumblr',{reason:'Service cooldown',notBefore:Date.now()+60000});await app.media.enqueue('tumblr:staff:12345',true);const end=Date.now()+5000;while(app.media.status.pending){if(Date.now()>end)throw new Error('Paused media did not settle');await delay(5);}assert.equal(requests,0);assert.equal((await app.media.items('tumblr:staff:12345'))[0]!.state,'error');}
 finally{await app.close();}
});
