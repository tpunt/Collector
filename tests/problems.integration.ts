import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createOnlineReaderServer} from './online-fixture.ts';
import {RequestQueue} from '../src/request-gate.ts';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as delay} from 'node:timers/promises';
import {readListing} from '../src/extract.ts';

const head='<div id="header"><span class="user"><a href="/user/fixture_user/">fixture_user</a></span></div><div class="tabmenu"><span class="selected">new</span></div>';
const good='<div class="thing self" data-fullname="t3_abc" data-subreddit="python" data-permalink="/r/python/comments/abc/PRIVATE_TITLE_SLUG/"><div class="entry"><a class="title">PRIVATE_POST_TITLE</a><p class="tagline"><time datetime="2026-10-20T10:30:00Z">Time</time></p><div class="usertext-body"><div class="md">PRIVATE_POST_BODY</div></div></div></div>';
const bad='<div class="thing self" data-subreddit="python" data-permalink="/r/python/comments/def/"><div class="entry"><a class="title">Another PRIVATE_POST_TITLE</a></div></div>';
async function settled(app:Awaited<ReturnType<typeof createOnlineReaderServer>>){const end=Date.now()+15000;while(app.jobs.state.running){if(Date.now()>end)throw new Error('Problem fixture did not settle');await delay(3);}}

test('a partially changed Reddit listing pauses without advancing, shows diagnostics offline and can be retried after the parser input is fixed',async()=>{
 const root=await mkdtemp(join(tmpdir(),'collector-problem-ui-')),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'}),collector=await browser.newPage();let broken=true,visits=0;
 await collector.route('**/*',route=>route.fulfill({contentType:'text/html',body:head+'<div id="siteTable">'+good+(broken?bad:'')+'</div><div class="commentarea"></div>'}));
 const app=await createOnlineReaderServer({database:join(root,'reader.sqlite'),port:0,jobs:{network:new RequestQueue({intervalMs:0}),browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:0},async open(){},async close(){},async manualSignIn(){},async navigate(url){visits++;await collector.goto(url);return collector;}}}});
 const origin=await app.listen();
 try{
  let state=await(await fetch(origin+'/api/state')).json();assert.equal(state.problems.groups,0);assert.equal((await(await fetch(origin+'/api/feed')).json()).posts.length,0);
  const post=(path:string,data:unknown,auth=true)=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Reader-Token':state.token}:{})},body:JSON.stringify(data)});
  assert.equal((await post('sources',null)).status,400);assert.equal((await post('sources',[])).status,400);assert.equal(app.problems.status.groups,0);
  const target=app.store.addSource({name:'python',historyMonths:1},Date.now());app.jobs.syncFeeds(['python'],{heads:[target],history:[]});await settled(app);
  assert.equal(app.store.getTarget(target)!.continuation,null);assert.equal(app.store.getTarget(target)!.observedCount,0);assert.equal(app.store.stats().posts,0);assert.equal(app.store.feedSync('python').state,'incomplete');assert.match(app.store.feedSync('python').reason??'',/checkpoint kept/);
  let data=await(await fetch(origin+'/api/problems')).json();assert.equal(data.records.length,1);assert.equal(data.records[0].code,'listing-records');assert.deepEqual(data.records[0].samples[0].facts.missingFields,['datetime','id']);assert.equal(data.records[0].samples[0].facts.accepted,1);assert.equal(data.records[0].feed,'python');assert.equal(data.records[0].samples[0].url,'https://old.reddit.com/r/python/new/');
  const disk=await readFile(app.problems.path,'utf8');assert(!disk.includes('PRIVATE_POST'));assert(!disk.includes('PRIVATE_TITLE_SLUG'));
  await app.networkMode.change(true);const page=await browser.newPage(),external:string[]=[];await page.route('**/*',route=>{if(route.request().url().startsWith(origin))return route.continue();external.push(route.request().url());return route.abort();});await page.goto(origin+'/#feeds');await page.getByRole('button',{name:'View problems',exact:true}).waitFor();await page.getByText(/post\(s\) could not be parsed; collection paused/).waitFor();
  await page.getByRole('button',{name:'View problems',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Problems',exact:true});await dialog.getByText('Some posts could not be parsed. Collection paused; page checkpoint kept for retry.',{exact:true}).click();await dialog.locator('pre').filter({hasText:'datetime'}).waitFor();
  const download=await fetch(origin+'/api/problems/download'),exported=await download.json();assert.equal(exported.path,undefined);assert.equal(exported.records[0].count,1);assert.match(download.headers.get('content-disposition')!,/collector-problems.json/);
  assert.equal((await post('problems/acknowledge',{records:[{id:data.records[0].id,count:1}]},false)).status,403);assert.equal((await post('problems/acknowledge',{})).status,400);
  await dialog.getByRole('button',{name:'Mark displayed problems as seen',exact:true}).click();await page.getByRole('button',{name:'Close dialog',exact:true}).click();await page.getByRole('button',{name:'View problems',exact:true}).waitFor({state:'detached'});assert.equal(app.problems.status.unseen,0);assert.equal(app.store.feedSync('python').state,'incomplete');assert.equal(visits,1);
  broken=false;await page.close();await app.networkMode.change(false);app.jobs.syncFeeds(['python']);await settled(app);assert.equal(app.store.stats().posts,1);assert.equal(app.store.getPost('abc')!.body,'PRIVATE_POST_BODY');assert.equal(app.store.bodySync('abc')!.status,'ready');assert.equal(app.store.getTarget(target)!.status,'done');assert.equal(app.problems.status.groups,1);assert.equal(app.problems.status.unseen,0);assert.deepEqual(external,[]);
  state=await(await fetch(origin+'/api/state')).json();assert.equal(state.problems.groups,1);
 }finally{await app.close();await browser.close();await rm(root,{recursive:true,force:true});}
});

test('an unrecognised whole listing and invalid pagination expose structural facts without mistaking the page for empty',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.setContent(head+'<main>A changed layout with PRIVATE_POST_BODY</main>');await assert.rejects(readListing(page,'python'),error=>{assert.equal((error as any).code,'listing-layout');assert.equal((error as any).facts.rows,0);assert.equal((error as any).facts.emptyMarker,false);return true;});
  await page.setContent(head+'<div id="siteTable">'+good+'<span class="next-button"><a href="https://evil.test/token=SECRET">Next</a></span></div>');await assert.rejects(readListing(page,'python'),/Pagination/);
 }finally{await browser.close();}
});

test('archive response failures and invalid records are logged once with service/feed context while normal Stop stays quiet',async()=>{
 let mode:'error'|'bad'|'pending'='error';const app=await createOnlineReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},archive:{fetch:async(_input,options)=>{
  if(mode==='error')return new Response('PRIVATE_RESPONSE',{status:500});
  if(mode==='pending')return new Promise<Response>((_resolve,reject)=>options!.signal!.addEventListener('abort',()=>reject(new Error('Stopped fixture')),{once:true}));
  const url=new URL(String(_input)),after=Date.parse(url.searchParams.get('after')!);return new Response(JSON.stringify({data:after<Date.parse('2020-01-01T00:00:01Z')?[{id:'abc',subreddit:'python',created_utc:1577836801,title:{private:'PRIVATE_ARCHIVE_BODY'}}]:[]}),{headers:{'Content-Type':'application/json'}});
 }}});
 const wait=async()=>{const end=Date.now()+5000;while(app.archive.running){if(Date.now()>end)throw new Error('Archive problem fixture did not settle');await delay(3);}};
 try{
  await app.listen();app.archive.start({subreddit:'python',from:'2020-01-01',to:'2020-01-01'});await wait();let data=app.problems.list();assert.equal(data.records[0]!.code,'archive-response');assert.equal(data.records[0]!.samples[0]!.error.httpStatus,500);assert.equal(data.records[0]!.samples[0]!.url,'https://arctic-shift.photon-reddit.com/api/posts/search');
  mode='bad';app.archive.start({subreddit:'python',from:'2020-01-01',to:'2020-01-01'});await wait();data=app.problems.list();assert(data.records.some(row=>row.code==='archive-records'));assert(!JSON.stringify(data).includes('PRIVATE_'));const occurrences=data.records.reduce((sum,row)=>sum+row.count,0);
  mode='pending';app.archive.start({subreddit:'python',from:'2020-01-01',to:'2020-01-01'});await delay(10);await app.archive.stop();assert.equal(app.problems.list().records.reduce((sum,row)=>sum+row.count,0),occurrences);
 }finally{await app.close();}
});
