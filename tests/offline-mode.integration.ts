import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';
import {RequestQueue} from '../src/request-gate.ts';
import {ReaderStore} from '../src/store.ts';
import {WebSocket as PolicySocket} from 'ws';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVQAAAAASUVORK5CYII=','base64');
const record=(id:string,subreddit='aww')=>({id,subreddit,title:'Offline '+id,body:'Saved text',permalink:`/r/${subreddit}/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,exportId:'offline-mode',observedAt:1800000000000,media:['Text' as const]});
async function until(condition:()=>boolean,message='Operation did not finish'){const end=Date.now()+15_000;while(!condition()){if(Date.now()>end)throw new Error(message);await new Promise(resolve=>setTimeout(resolve,5));}}
const counts=()=>({released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:0});

test('offline policy rejects external work at the API, allows local reading, survives restart and cannot be disabled by an online backup',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'collector-offline-'));let starts=0;
 const browser={counts:counts(),async open(){starts++;},async navigate(){starts++;throw new Error('No external request expected');},async close(){},async manualSignIn(){starts++;}};
 let app=createReaderServer({database:join(directory,'reader.sqlite'),port:0,jobs:{browser}}),origin=await app.listen();
 const post=async(path:string,data:unknown,token?:string)=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token??(await(await fetch(origin+'/api/state')).json()).token},body:JSON.stringify(data)});
 try{
  app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,[record('one')]);
  assert.equal((await post('offline',{offline:true},'wrong')).status,403);assert.equal((await post('offline',{offline:'true'})).status,400);
  assert.equal((await post('offline',{offline:true})).status,200);assert.equal(app.networkMode.status.offline,true);
  for(const [path,data]of [['sync',{}],['sources',{name:'python'}],['history',{name:'aww',months:3}],['thread',{id:'one'}],['sign-in',{}],['archive/start',{subreddit:'aww',from:'2020-01-01',to:'2021-01-01'}]]as const){const response=await post(path,data);assert.equal(response.status,400,path);assert.match((await response.json()).error,/Offline mode/,path);}
  assert.equal((await fetch(origin+'/online-player?url='+encodeURIComponent('https://www.youtube.com/watch?v=fixture'))).status,400);
  assert.equal((await post('read',{id:'one',read:true})).status,200);assert.equal((await post('favourite/post',{id:'one',context:app.store.getPost('one')!.readContext,favourite:true})).status,200);
  assert.equal((await(await fetch(origin+'/api/feed?q=Saved&scope=body')).json()).posts.length,1);assert.equal(starts,0);
  app.store.setSetting('offlineResume',{generation:app.store.generation,feeds:['aww'],tasks:[],archive:null,signIn:false});assert.equal((await post('restore/commit',{id:'expired',confirm:true})).status,400);assert.deepEqual(app.networkMode.status.paused.feeds,['aww'],'A rejected restore must retain the paused collection plan');
  const other=new ReaderStore(join(directory,'other.sqlite'));other.setSetting('offlineMode',false);await other.snapshot(join(directory,'online-backup.sqlite'));other.close();app.store.replaceFrom(join(directory,'online-backup.sqlite'));assert.equal(app.store.getSetting('offlineMode'),true);
  await app.close();app=createReaderServer({database:join(directory,'reader.sqlite'),port:0,jobs:{browser}});origin=await app.listen();assert.equal(app.networkMode.status.offline,true);assert.equal(starts,0);
  await post('offline',{offline:false});assert.equal(app.networkMode.status.offline,false);assert.equal(starts,0,'Going online with no suspended work must not start collection');
 }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});

test('offline mode pauses active and queued feeds and resumes only that work, preserving manually stopped feeds',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'collector-offline-resume-'));
 const visits:string[]=[];let hold=true,rejectPending:((error:Error)=>void)|null=null;
 const browser={counts:counts(),async open(){},async manualSignIn(){},async close(){rejectPending?.(new Error('Paused fixture'));rejectPending=null;},async navigate(url:string){visits.push(url);if(hold)return new Promise<any>((_resolve,reject)=>{rejectPending=reject;});return {}as any;}};
 const options=()=>({database:join(directory,'reader.sqlite'),port:0,jobs:{browser,network:new RequestQueue({intervalMs:0}),readListing:async(_page:any,name:string)=>({account:'fixture_user',posts:[{...record(name,name),source:'live' as const,exportId:undefined}],ordinary:[],unknownTime:false,omissions:0,next:null,empty:false,signature:name})}});let app=createReaderServer(options());
 try{
  for(const name of ['aww','python','stopped'])app.store.addSubreddit(name);
  app.jobs.syncFeeds(['stopped']);await until(()=>visits.length===1);await app.jobs.stopSource('stopped');await until(()=>!app.jobs.state.running);visits.length=0;
  app.jobs.syncFeeds(['aww','python']);await until(()=>visits.length===1);await app.networkMode.change(true);assert.deepEqual(app.networkMode.status.paused.feeds.sort(),['aww','python']);assert.equal(app.jobs.state.running,false);assert.equal(visits.length,1);
  await app.close();app=createReaderServer(options());assert.equal(app.networkMode.status.offline,true);assert.deepEqual(app.networkMode.status.paused.feeds.sort(),['aww','python']);assert.equal(visits.length,1,'Restarting offline must not resume work');
  hold=false;await app.networkMode.change(false);await until(()=>!app.jobs.state.running);assert(visits.some(url=>url.includes('/r/aww/')));assert(visits.some(url=>url.includes('/r/python/')));assert(!visits.some(url=>url.includes('/r/stopped/')));assert.equal(app.store.stats().posts,2);
 }finally{await app.close();await rm(directory,{recursive:true,force:true});}
});

test('stopping a queued feed or all work immediately before Offline mode never enrolls it for automatic resume',async()=>{
 let rejectPending:((error:Error)=>void)|null=null;const visits:string[]=[];
 const browser={counts:counts(),async open(){},async manualSignIn(){},async close(){rejectPending?.(new Error('Paused fixture'));rejectPending=null;},async navigate(url:string){visits.push(url);return new Promise<any>((_resolve,reject)=>{rejectPending=reject;});}};
 const app=createReaderServer({database:':memory:',port:0,jobs:{browser,network:new RequestQueue({intervalMs:0})}});
 try{
  for(const name of ['aww','python'])app.store.addSubreddit(name);
  app.jobs.syncFeeds(['aww','python']);await until(()=>visits.length===1);await app.jobs.stopSource('python');await app.networkMode.change(true);assert.deepEqual(app.networkMode.status.paused.feeds,['aww'],'A stopped queued feed must stay stopped');
  app.networkMode.cancel();await app.networkMode.change(false);app.jobs.syncFeeds(['aww','python']);await until(()=>visits.length===2);app.jobs.pause();assert.deepEqual(app.jobs.offlineWork(),{feeds:[],tasks:[],signIn:false},'Stop all is immediate even while its active page unwinds');await app.networkMode.change(true);assert.deepEqual(app.networkMode.status.paused.feeds,[]);
 }finally{await app.close();}
});

test('enabling Offline mode while Clear data waits for collection cannot resume and refill the cleared feed',async()=>{
 let rejectPending:((error:Error)=>void)|null=null,entered=false,release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});let visits=0;
 const browser={counts:counts(),async open(){},async manualSignIn(){},async close(){rejectPending?.(new Error('Paused fixture'));rejectPending=null;},async navigate(){visits++;return new Promise<any>((_resolve,reject)=>{rejectPending=reject;});}};
 const app=createReaderServer({database:':memory:',port:0,jobs:{browser,network:new RequestQueue({intervalMs:0})}}),origin=await app.listen(),stop=app.archive.stop.bind(app.archive);let stops=0;
 app.archive.stop=async(...args)=>{if(stops++===0){entered=true;await held;}await stop(...args);};
 try{
  app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,[record('one')]);app.jobs.syncFeeds(['aww']);await until(()=>visits===1);
  const token=(await(await fetch(origin+'/api/state')).json()).token,clearing=fetch(origin+'/api/clear-source',{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token},body:JSON.stringify({name:'aww',confirm:true})});await until(()=>entered);const offline=app.networkMode.change(true);release();const [response]=await Promise.all([clearing,offline]);assert.equal(response.status,200);assert.equal(app.store.stats().posts,0);assert.deepEqual(app.networkMode.status.paused.feeds,[]);await app.networkMode.change(false);assert.equal(app.jobs.state.running,false);assert.equal(visits,1);
 }finally{release();await app.close();}
});

test('pausing media aborts the active transfer, keeps completed files and resumes media without starting a listing sync',async()=>{
 let secondStarted=false,block=true,downloads=0,aborted=false;
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0}),browser:{counts:counts(),async open(){assert.fail('Media-only resume must not open a collection browser');},async close(){},async manualSignIn(){},async navigate(){assert.fail('No listing request expected');}}},media:{fetch:async(input,options)=>{
  downloads++;if(String(input).includes('two')&&block){secondStarted=true;return new Promise<Response>((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>{aborted=true;reject(new Error('Aborted fixture'));},{once:true}));}return new Response(png,{headers:{'Content-Type':'image/png'}});
 }}});app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,['one','two'].map((id,index)=>({...record(id),created:{epochMs:1700000001000-index*1000,precisionMs:1000},media:['Image'],attachments:[{kind:'image',url:`https://i.redd.it/${id}.png`}]})));
 try{
  app.jobs.syncMedia(['aww']);await until(()=>secondStarted);const first=(await app.media.items('one'))[0]!;assert.equal(first.state,'ready');await app.networkMode.change(true);assert(aborted);assert((await stat(first.localPath!)).isFile());assert.equal(app.store.offlineMedia('aww').ready,1);
  block=false;await app.networkMode.change(false);await until(()=>!app.jobs.state.running);assert.equal(app.store.offlineMedia('aww').ready,2);assert.equal(downloads,3);
 }finally{await app.close();}
});

test('an archive resumes its saved job after Offline mode, while a cancelled offline resume stays cancelled',async()=>{
 let started=false,aborted=false,block=true,requests=0;
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},archive:{fetch:async(_input,options)=>{requests++;if(block){started=true;return new Promise<Response>((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>{aborted=true;reject(new Error('Aborted fixture'));},{once:true}));}return Response.json({data:[]});}}});
 try{
  const id=app.archive.start({subreddit:'aww',from:'2020-01-01',to:'2021-01-01'});await until(()=>started);await app.networkMode.change(true);assert(aborted);assert.equal(app.store.archiveFetch(id)!.state,'paused');assert.equal(app.networkMode.status.paused.archive,true);assert.deepEqual(app.networkMode.status.paused.feeds,['aww']);
  block=false;await app.networkMode.change(false);await until(()=>!app.archive.running);assert.equal(app.store.archiveFetch(id)!.state,'done');assert.equal(requests,2);
  started=false;block=true;const next=app.archive.start({subreddit:'aww',from:'2021-01-01',to:'2022-01-01'});await until(()=>started);await app.networkMode.change(true);app.networkMode.cancel({source:'aww'});block=false;await app.networkMode.change(false);assert.equal(app.store.archiveFetch(next)!.state,'paused');assert.equal(requests,3);
 }finally{await app.close();}
});

test('Offline mode pauses an opening sign-in window and reopens it only when its automatic resume remains enabled',async()=>{
 let starts=0,block=true,rejectPending:((error:Error)=>void)|null=null;
 const browser={counts:counts(),async open(){},async navigate(){throw new Error('No listing expected');},async close(){rejectPending?.(new Error('Sign-in paused'));rejectPending=null;},async manualSignIn(){starts++;if(block)await new Promise<void>((_resolve,reject)=>{rejectPending=reject;});}};
 const app=createReaderServer({database:':memory:',port:0,jobs:{browser,network:new RequestQueue({intervalMs:0})}});
 try{
  const signingIn=app.jobs.signIn().catch(()=>{});await until(()=>starts===1);await app.networkMode.change(true);await signingIn;assert.equal(app.jobs.state.manual,false);assert.equal(app.networkMode.status.paused.signIn,true);
  block=false;await app.networkMode.change(false);await until(()=>starts===2);assert.equal(app.jobs.state.manual,true);
  await app.networkMode.change(true);app.networkMode.cancel();await app.networkMode.change(false);assert.equal(starts,2);assert.equal(app.jobs.state.manual,false);
 }finally{await app.close();}
});

test('going online never overrides an access cooldown encountered while collection was pausing',async()=>{
 let starts=0,rejectPending:((error:Error)=>void)|null=null;
 const browser={counts:counts(),async open(){starts++;},async manualSignIn(){starts++;},async navigate(){return new Promise<any>((_resolve,reject)=>{rejectPending=reject;});},async close(){rejectPending?.(new Error('Paused fixture'));rejectPending=null;}};
 const app=createReaderServer({database:':memory:',port:0,jobs:{browser,network:new RequestQueue({intervalMs:0})}});
 try{
  app.store.addSubreddit('aww');app.jobs.syncFeeds(['aww']);await until(()=>Boolean(rejectPending));await app.networkMode.change(true);const pause={reason:'Reddit returned 429',notBefore:Date.now()+60_000};app.store.setSetting('accessPause',pause);
  const status=await app.networkMode.change(false);assert.equal(status.offline,false);assert.match(status.message,/explicit Resume/);assert.equal(starts,1);assert.equal(app.jobs.state.running,false);assert.deepEqual(app.store.getSetting('accessPause'),pause);
 }finally{await app.close();}
});

test('network policy sockets require the local origin and launch token, and Offline mode waits for player acknowledgement',async()=>{
 const app=createReaderServer({database:':memory:',port:0}),origin=await app.listen();let client:PolicySocket|undefined;
 try{
  const token=(await(await fetch(origin+'/api/state')).json()).token,url=new URL('/api/network/events?client=fixture',origin);url.protocol='ws:';
  const rejected=(address:string,requestOrigin:string,host?:string)=>new Promise<number|undefined>((resolve,reject)=>{
   const socket=new PolicySocket(address,{origin:requestOrigin,...(host?{headers:{Host:host}}:{})});socket.on('error',()=>{});socket.once('open',()=>{socket.terminate();reject(new Error('Untrusted socket was accepted'));});socket.once('unexpected-response',(_request,response)=>{response.resume();socket.terminate();resolve(response.statusCode);});
  });
  assert.equal(await rejected(url.href,origin),403);url.searchParams.set('token',token);assert.equal(await rejected(url.href,'https://example.com'),403);assert.equal(await rejected(url.href,origin,'attacker.example'),403);
  const messages:any[]=[];client=new PolicySocket(url,{origin});client.on('message',data=>messages.push(JSON.parse(String(data))));await until(()=>messages.length===1);assert.equal(messages[0].offline,false);
  const switching=app.networkMode.change(true);await until(()=>messages.some(status=>status.offline));assert.equal(app.networkMode.status.changing,true,'Do not confirm Offline mode before the client removes its players');await switching;assert.equal(app.networkMode.status.changing,false);assert.equal(app.networkMode.status.pendingReaders,1,'An unresponsive client is not counted as paused');client.send(JSON.stringify({revision:messages.at(-1).revision}));await until(()=>app.networkMode.status.pendingReaders===0);assert.equal(app.networkMode.status.offline,true);
 }finally{client?.terminate();await app.close();}
});

test('failed setting writes roll back the mode and resume plan together without leaving the switch changing',async()=>{
 const app=createReaderServer({database:':memory:',port:0}),setSetting=app.store.setSetting.bind(app.store);let fail=true;
 try{
  app.store.setSetting=(key,value)=>{setSetting(key,value);if(key==='offlineMode'&&value===true&&fail){fail=false;throw new Error('Fixture setting failure');}};
  await assert.rejects(app.networkMode.change(true),/Fixture setting failure/);assert.equal(app.networkMode.status.changing,false);assert.equal(app.networkMode.status.offline,false);assert.equal(app.store.getSetting('offlineResume'),null);assert.equal(app.store.getSetting('offlineMode'),null);await app.networkMode.change(true);assert.equal(app.networkMode.status.offline,true);
 }finally{await app.close();}
});

test('a rejected Offline request clears its optimistic pause across tabs',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('aww');const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const context=await browser.newContext(),first=await context.newPage(),second=await context.newPage();await first.goto(origin);await second.goto(origin);await first.getByRole('button',{name:'Sync all',exact:true}).waitFor();await until(()=>app.networkMode.status.offline===false);await first.route('**/api/offline',route=>route.fulfill({status:400,contentType:'application/json',body:'{"error":"Fixture rejected request"}'}));await first.getByRole('switch',{name:'Offline mode',exact:true}).click();await first.getByRole('alert').waitFor();await first.waitForFunction(()=>![...document.querySelectorAll('button')].find(button=>button.textContent==='Sync all')?.disabled);await second.waitForFunction(()=>![...document.querySelectorAll('button')].find(button=>button.textContent==='Sync all')?.disabled);assert.equal(app.networkMode.status.offline,false);
 }finally{await browser.close();await app.close();}
});

test('an unresponsive player leaves Offline mode unconfirmed and the user can cancel the request',async()=>{
 const app=createReaderServer({database:':memory:',port:0}),origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});let client:PolicySocket|undefined;
 try{
  const token=(await(await fetch(origin+'/api/state')).json()).token,url=new URL('/api/network/events?client=held-reader&token='+token,origin);url.protocol='ws:';client=new PolicySocket(url,{origin});await new Promise<void>((resolve,reject)=>{client!.once('message',()=>resolve());client!.once('error',reject);});
  const page=await browser.newPage();await page.goto(origin);await page.getByRole('switch',{name:'Offline mode',exact:true}).click();const cancel=page.getByRole('button',{name:'Cancel Offline request',exact:true});await cancel.waitFor();assert.equal(app.networkMode.status.pendingReaders,1);assert.equal(await page.getByRole('switch',{name:'Offline mode',exact:true}).getAttribute('aria-checked'),'false');await page.getByText(/Collection is paused. Waiting for 1 open/).waitFor();await cancel.click();await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(button=>button.textContent==='Cancel Offline request'));assert.equal(app.networkMode.status.offline,false);assert.equal(app.networkMode.status.pendingReaders,0);
 }finally{client?.terminate();await browser.close();await app.close();}
});

test('switching offline removes provider frames in every open reader and standalone player; saved media and local actions keep working',async()=>{
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async()=>new Response(png,{headers:{'Content-Type':'image/png'}})}});app.store.addSubreddit('aww');
 app.store.importArchiveBatch(app.store.generation,[{...record('image'),media:['Image'],attachments:[{kind:'image',url:'https://i.redd.it/image.png'}]},
  {...record('online'),title:'Online player',media:['Video'],outbound:'https://www.youtube.com/watch?v=fixture',attachments:[]}]);app.store.setMediaSync(app.store.generation,'online','unavailable','Online provider');await app.media.syncPost('image','fixture',4,new AbortController().signal);
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const context=await browser.newContext(),external:string[]=[];let players=0;await context.route('**/*',route=>{const url=route.request().url();if(url.startsWith(origin))return route.continue();external.push(url);if(url.includes('/embed/')){players++;return route.fulfill({contentType:'text/html',body:'<p>Provider fixture</p><script>setInterval(()=>fetch("https://provider.example/heartbeat",{mode:"no-cors"}).catch(()=>{}),40)</script>'});}return route.fulfill({contentType:'text/plain',body:'fixture'});});
  const first=await context.newPage(),second=await context.newPage(),standalones=await Promise.all(Array.from({length:8},()=>context.newPage()));await first.goto(origin);await second.goto(origin);await Promise.all(standalones.map(page=>page.goto(origin+'/online-player?url='+encodeURIComponent('https://www.youtube.com/watch?v=fixture'))));
  await until(()=>players===10&&external.some(url=>url.endsWith('/heartbeat')));await first.getByRole('switch',{name:'Offline mode',exact:true}).click();await first.waitForFunction(()=>document.querySelector('[role="switch"]')?.getAttribute('aria-checked')==='true');await second.waitForFunction(()=>document.querySelector('[role="switch"]')?.getAttribute('aria-checked')==='true');
  assert.equal(await first.locator('iframe').count(),0);assert.equal(await second.locator('iframe').count(),0);for(const page of standalones)assert.equal(await page.locator('iframe').count(),0);const count=external.length;await first.waitForTimeout(180);assert.equal(external.length,count,'Provider background traffic must stop before Offline mode is confirmed');
  await first.getByRole('button',{name:'Read thread: Online player',exact:true}).click();const drawer=first.getByRole('dialog',{name:'Thread details'});assert.equal(await drawer.getByRole('link',{name:/Open original/}).count(),0);assert(await drawer.getByRole('button',{name:'Read discussion in browser',exact:true}).isDisabled());await drawer.getByRole('button',{name:'Close thread',exact:true}).click();
  await first.getByLabel('Search stored posts',{exact:true}).fill('Offline image');await first.getByRole('button',{name:'Offline image',exact:true}).waitFor();await first.waitForFunction(()=>document.querySelector<HTMLImageElement>('img')?.naturalWidth===1);assert.equal(external.length,count);await first.reload();await first.waitForFunction(()=>document.querySelector('[role="switch"]')?.getAttribute('aria-checked')==='true');assert.equal(await first.locator('iframe').count(),0);assert.equal(external.length,count);
  await first.getByRole('switch',{name:'Offline mode',exact:true}).click();await until(()=>players===20);assert.equal(app.networkMode.status.offline,false);assert.equal(app.media.status.requests,1,'Reading or toggling mode must not download saved media again');assert.equal(app.jobs.state.requests.sessionTotal,0);
 }finally{await browser.close();await app.close();}
});
