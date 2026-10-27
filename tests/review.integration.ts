import '../src/browser-path.ts';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {setTimeout as delay} from 'node:timers/promises';
import {createReaderServer} from '../src/server.ts';
import {RequestQueue} from '../src/request-gate.ts';
async function waitUntil(condition:()=>boolean){const deadline=Date.now()+3000;while(!condition()){if(Date.now()>deadline)throw new Error('Local fixture did not settle');await delay(2);}}
async function client(app:ReturnType<typeof createReaderServer>){const origin=await app.listen(),{token}=await(await fetch(origin+'/api/state')).json();return{origin,post:(path:string,data:unknown={})=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token},body:JSON.stringify(data)})};}

test('Sync resumes after a budget pause but cannot bypass a service cooldown',async()=>{
 let visits=0;const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0}),mediaSync:null,browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(){visits++;return{}as any;}},readListing:async()=>({account:'fixture_user',posts:[],ordinary:[],unknownTime:false,omissions:0,next:null,empty:true,signature:'empty'})}});app.store.addSource({name:'python',historyMonths:1,lowerMs:Date.now()-86400000});
 const {post}=await client(app);
 try{
  app.store.pauseSource('python','Request budget reached');app.store.setSetting('accessPause',{reason:'Request budget reached',notBefore:Date.now()+60_000});
  assert.equal((await post('sync',{names:['python']})).status,400);assert.equal(visits,0);
  app.store.setSetting('accessPause',{reason:'Request budget reached',notBefore:null});
  assert.equal((await post('sync',{names:['python']})).status,200);await waitUntil(()=>!app.jobs.state.running);assert.equal(visits,1);assert.equal(app.store.feedSources()[0]?.historyTarget?.status,'done');assert.equal(app.jobs.state.accessPause,null);
 }finally{await app.close();}
});

test('removing a feed stops only its file import and does not accept later records',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');app.store.addSubreddit('aww');const {post}=await client(app);
 const input=new Readable({read(){}}),run=app.importer.run(input,{subreddit:'python',filename:'pending.jsonl',size:1_000_000,modified:1});
 try{
  assert.equal((await post('remove',{name:'aww',confirm:true})).status,200);assert.equal(app.importer.progress?.state,'running');
  assert.equal((await post('remove',{name:'python',confirm:true})).status,200);assert.equal(app.importer.progress?.state,'paused');assert.equal((await run).state,'paused');assert.equal(app.store.stats().posts,0);assert(input.destroyed);
 }finally{await app.importer.close();await app.close();}
});

test('Clear waits for the file importer and removes its progress instead of leaving stale import state',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');const {post,origin}=await client(app);
 const run=app.importer.run(new Readable({read(){}}),{subreddit:'python',filename:'pending.jsonl',size:100,modified:1});
 try{assert.equal((await post('clear')).status,200);assert.equal((await run).state,'paused');const state=await(await fetch(origin+'/api/state')).json();assert.equal(state.import,null);assert.deepEqual(state.imports,[]);assert.deepEqual(state.sources,['python']);assert.equal(state.stats.posts,0);}finally{await app.close();}
});

test('collection cannot restart while Clear is still removing media; reads remain available',async()=>{
 let release!:()=>void,started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});let archiveCalls=0;
 const app=createReaderServer({database:':memory:',port:0,archive:{fetch:async()=>{archiveCalls++;return new Response('{"data":[]}',{headers:{'Content-Type':'application/json'}});}}});app.store.addSubreddit('python');const {post,origin}=await client(app),original=app.media.clear.bind(app.media);app.media.clear=async()=>{started();await gate;await original();};
 let clearing:Promise<Response>|undefined;
 try{
  clearing=post('clear');await began;
  assert.equal((await fetch(origin+'/api/state')).status,200);
  const during=await post('archive/start',{subreddit:'python',from:'2020-01-01',to:'2020-01-01'});assert.equal(during.status,400);assert.equal(archiveCalls,0);
  release();assert.equal((await clearing).status,200);assert.equal(app.store.archiveFetches().length,0);
 }finally{release();await clearing;await app.close();}
});

test('thread reader shows the newest saved post body alongside an older discussion snapshot',async()=>{
 const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,[{id:'edit',subreddit:'python',title:'Edited post fixture',body:'Original body',permalink:'/r/python/comments/edit/',created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'edited',observedAt:1800000000000,media:['Text']}]);
 app.store.saveSnapshot(app.store.generation,{id:'old-discussion',postId:'t3_edit',source:'live',observedAt:1800000000001,capturedAt:1800000000001,sort:'best',body:'Previous discussion body',availability:'available',comments:[{id:'t1_saved',postId:'t3_edit',parentId:'t3_edit',ancestry:'known',body:'An older saved comment',availability:'available',createdMs:1700000000001}],omitted:0,sample:'Saved fixture discussion'});
 app.store.savePostBody(app.store.generation,'edit','Latest full post text',1800000000002);
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{const page=await browser.newPage();await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());await page.goto(origin);await page.getByRole('button',{name:'Edited post fixture',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Thread details',exact:true});assert.equal(await dialog.locator('.prose').innerText(),'Latest full post text');assert.equal(await dialog.getByText('An older saved comment',{exact:true}).count(),1);assert.equal(app.jobs.state.requests.sessionTotal,0);}finally{await browser.close();await app.close();}
});
