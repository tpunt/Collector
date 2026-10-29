import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {ReaderStore} from '../src/store.ts';
import {ReaderJobs} from '../src/jobs.ts';
import {MediaCache} from '../src/media.ts';
import {RequestQueue} from '../src/request-gate.ts';
import {parseTumblrSearchUrl} from '../src/sources.ts';
import {tumblrHistoryCheckpoint} from '../src/tumblr-history.ts';
import {createReaderServer} from '../src/server.ts';
import {newTumblrHistory,planTumblrWindow,captureTumblrWindow,finishTumblrWindow} from '../src/tumblr-history.ts';

const utc=(date:string)=>Date.parse(date+'T12:00:00Z'),upper=utc('2026-10-29');
interface Record {id:string;date:number;files:number}
const latest:Record={id:'900000',date:utc('2026-09-17'),files:1};
const card=(post:Record,detail=false)=>`<article${detail?'':` data-post-id="${post.id}"`}><header><a rel="author" href="/staff">staff</a></header>${detail?'':`<a rel="bookmark" href="/staff/${post.id}/saved">Permalink</a>`}<time datetime="${new Date(post.date).toISOString()}"></time><h1>Post ${post.id}</h1><p>${detail?'Complete text of':'Preview of'} ${post.id}</p>${Array.from({length:post.files},(_,index)=>`<img src="https://64.media.tumblr.com/${post.id}-${index}.png">`).join('')}</article>`;
async function until(condition:()=>boolean,message:string){const end=Date.now()+45000;while(!condition()){if(Date.now()>end)throw new Error(message);await delay(5);}}
async function fixture(records:Record[],options:{lower?:number;cap?:number}={}){
 const directory=await mkdtemp(join(tmpdir(),'collector-tumblr-history-')),browser=await chromium.launch({...browserLaunchOptions,channel:'chrome',headless:true}),page=await browser.newPage({javaScriptEnabled:false});
 const all=[latest,...records],visits:string[]=[],downloads=new Map<string,number>();let broken=false,block:string|null=null,blocked=false,fail:string|null=null;
 await page.route('**/*',async route=>{
  if(route.request().resourceType()!=='document'){await route.abort();return;}
  const url=new URL(route.request().url());let body='';
  if(url.pathname.startsWith('/search/')){
   const scope=parseTumblrSearchUrl(url.href,'staff');
   if(broken)body='<main><h1>Unrecognised replacement layout</h1></main>';
   else{
    const matching=all.filter(post=>post.date>=scope.lower-(scope.exactDay?0:86400000)&&post.date<scope.upper+(scope.exactDay?0:86400000)).sort((a,b)=>b.date-a.date).slice(0,options.cap??15);
    body=`<input aria-label="Search" value="${scope.query}"><main><div data-timeline-id="searchTimeline-post-${scope.query}-recent">${matching.map(post=>card(post)).join('')}</div></main>`;
   }
  }else if(url.pathname==='/staff')body='<main>'+card(latest)+'</main>';
  else{
   const id=/^\/staff\/([0-9]+)/.exec(url.pathname)?.[1],post=all.find(post=>post.id===id);assert(post,'Unexpected fixture navigation: '+url.pathname);
   body=`<link rel="canonical" href="https://www.tumblr.com/staff/${post.id}/saved"><main>${card(post,true)}</main>`;
  }
  await route.fulfill({contentType:'text/html',body});
 });
 let store:ReaderStore,cache:MediaCache,jobs:ReaderJobs;
 async function open(){
  store=new ReaderStore(join(directory,'reader.sqlite'));const network=new RequestQueue({intervalMs:0});let opened=false;
  const counts={released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:0};
  const driver={counts,async open(){if(!opened){opened=true;counts.released=0;}},async close(){opened=false;},async manualSignIn(){},async navigate(url:string){visits.push(url);counts.released++;await page.goto(url);return page;}};
  cache=new MediaCache(store,{directory:join(directory,'media'),queue:network,onAccess:error=>jobs.accessFailure(error),fetch:async(input,init)=>{
   const url=String(input);downloads.set(url,(downloads.get(url)??0)+1);
   if(url===fail)return new Response('Fixture media failure',{status:500});
   if(url===block){blocked=true;await new Promise<void>((_resolve,reject)=>{if(init?.signal?.aborted)reject(new Error('Aborted fixture'));else init?.signal?.addEventListener('abort',()=>reject(new Error('Aborted fixture')),{once:true});});}
   return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});
  }});
  await cache.initialize();jobs=new ReaderJobs(store,{network,browser:driver,mediaSync:cache});
 }
 await open();const target=store!.addSource({name:'tumblr:staff',historyMonths:0,lowerMs:options.lower},upper);
 return{directory,target,visits,downloads,get store(){return store;},get jobs(){return jobs;},get cache(){return cache;},get blocked(){return blocked;},breakLayout(value:boolean){broken=value;},blockFile(url:string|null){block=url;},failFile(url:string|null){fail=url;},
  async restart(){await jobs.close();await cache.close();store.close();block=null;await open();},
  async close(){await jobs.close();await cache.close();store.close();await browser.close();await rm(directory,{recursive:true,force:true});}};
}

test('one automatic Tumblr run discovers beyond the finite listing, splits dense searches, reaches old history and saves every file beyond 120 total requests',async()=>{
 const records=[...Array.from({length:20},(_,i)=>({id:String(800000+i),date:utc('2025-01-'+String(1+Math.floor(i/2)).padStart(2,'0')),files:2})),{id:'700000',date:utc('1971-01-07'),files:1}],h=await fixture(records);
 try{
  h.jobs.syncFeeds(['tumblr:staff'],{heads:[h.target],history:[]});await until(()=>!h.jobs.state.running,'Automatic dated history did not settle: '+h.jobs.state.message);
  assert.equal(h.store.stats().posts,22);assert.equal(h.store.offlineText('tumblr:staff').ready,22);assert.equal(h.store.offlineMedia('tumblr:staff').ready,22);assert.equal([...h.downloads.values()].reduce((a,b)=>a+b,0),42);
  const target=h.store.getTarget(h.target)!,state=tumblrHistoryCheckpoint(target)!;assert.equal(target.status,'done');assert.equal(state.oldestChecked,0);assert(state.queries>57);assert(state.unverified>0);assert.equal(h.store.getPost('tumblr:staff:700000')!.createdMs,utc('1971-01-07'));
  assert.equal(h.store.feedSync('tumblr:staff').state,'gaps');assert.match(h.store.feedSync('tumblr:staff').reason!,/indexing/);assert(h.jobs.state.requests.sessionTotal+h.cache.status.requests>120);
  assert(!h.visits.some(url=>/\/api\/|api\.tumblr/.test(url)));assert.equal(h.store.feedSources()[0]!.historyDiscovery!.remainingWindows,0);
  const requests=h.cache.status.requests;const rescan=h.store.rescanHistory('tumblr:staff',upper);h.jobs.syncFeeds(['tumblr:staff'],{heads:[],history:[rescan]});await until(()=>!h.jobs.state.running,'Rescan did not settle');assert.equal(h.store.stats().posts,22);assert.equal(h.cache.status.requests,requests);
 }finally{await h.close();}
});

test('stopping mid-gallery and restarting preserves the exact saving window and resumes remaining files without refetching its search or cached media',async()=>{
 const record={id:'810000',date:utc('2025-01-07'),files:2},h=await fixture([record],{lower:Date.parse('2025-01-01T00:00:00Z')});
 try{
  h.blockFile('https://64.media.tumblr.com/810000-1.png');h.jobs.syncFeeds(['tumblr:staff'],{heads:[h.target],history:[]});await until(()=>h.blocked,'Blocked file was not reached');
  const current=tumblrHistoryCheckpoint(h.store.getTarget(h.target)!)!;assert(current.active?.ids.includes('tumblr:staff:810000'));assert.notEqual(current.active!.outcome,'query');const range=current.active!.range!;
  await h.jobs.stopSource('tumblr:staff');await until(()=>!h.jobs.state.running,'Stopped job did not settle');const before=h.visits.filter(url=>{try{const q=parseTumblrSearchUrl(url);return q.lower===range.lower&&q.upper===range.upper;}catch{return false;}}).length;
  assert.equal(h.downloads.get('https://64.media.tumblr.com/810000-0.png'),1);assert.equal(h.store.getTarget(h.target)!.status,'paused');await h.restart();
  assert.deepEqual(tumblrHistoryCheckpoint(h.store.getTarget(h.target)!)!.active!.range,range);h.jobs.syncFeeds(['tumblr:staff']);await until(()=>!h.jobs.state.running,'Resume did not settle: '+h.jobs.state.message);
  assert.equal(h.store.getTarget(h.target)!.status,'done');assert.equal(h.store.offlineMedia('tumblr:staff').ready,2);assert.equal(h.downloads.get('https://64.media.tumblr.com/810000-0.png'),1);
  const after=h.visits.filter(url=>{try{const q=parseTumblrSearchUrl(url);return q.lower===range.lower&&q.upper===range.upper;}catch{return false;}}).length;assert.equal(after,before);
 }finally{await h.close();}
});

test('unrecognised search layout pauses at the same query and retries it; capped days remain explicit gaps while older windows continue',async()=>{
 const records=[...Array.from({length:20},(_,i)=>({id:String(820000+i),date:utc('2025-01-10')+i*1000,files:0})),{id:'820099',date:utc('2025-01-02'),files:0}],h=await fixture(records,{lower:Date.parse('2025-01-01T00:00:00Z')});
 try{
  h.breakLayout(true);h.jobs.syncFeeds(['tumblr:staff'],{heads:[h.target],history:[]});await until(()=>!h.jobs.state.running,'Broken layout did not pause');
  const failed=h.store.getTarget(h.target)!;assert.equal(failed.status,'paused');assert.equal(tumblrHistoryCheckpoint(failed)!.active!.outcome,'query');const query=failed.continuation!;assert.match(failed.reason!,/layout\/query/);
  h.breakLayout(false);h.jobs.syncFeeds(['tumblr:staff']);await until(()=>!h.jobs.state.running,'Corrected layout did not resume');
  assert.equal(h.store.getTarget(h.target)!.status,'done');assert(h.visits.filter(url=>url===query).length>=2);const final=tumblrHistoryCheckpoint(h.store.getTarget(h.target)!)!;assert(final.capped>0);assert(h.store.getPost('tumblr:staff:820099'));assert.match(h.store.feedSync('tumblr:staff').reason!,/daily result limits/);
 }finally{await h.close();}
});

test('a failed attachment pauses the saved history phase; explicit Resume retries the file before advancing the checkpoint',async()=>{
 const record={id:'830000',date:utc('2025-01-07'),files:2},h=await fixture([record],{lower:Date.parse('2025-01-01T00:00:00Z')});
 try{
  h.failFile('https://64.media.tumblr.com/830000-1.png');h.jobs.syncFeeds(['tumblr:staff'],{heads:[h.target],history:[]});await until(()=>!h.jobs.state.running,'Failed attachment did not settle');
  const failed=h.store.getTarget(h.target)!,state=tumblrHistoryCheckpoint(failed)!;assert.equal(failed.status,'paused');assert.match(failed.reason!,/media failed to save/);assert(state.active?.ids.includes('tumblr:staff:830000'));assert.notEqual(state.active!.outcome,'query');assert.equal(h.downloads.get('https://64.media.tumblr.com/830000-0.png'),1);
  h.failFile(null);h.jobs.syncFeeds(['tumblr:staff']);await until(()=>!h.jobs.state.running,'Attachment retry did not settle');assert.equal(h.store.getTarget(h.target)!.status,'done');assert.equal(h.store.mediaSync('tumblr:staff:830000')!.status,'ready');assert.equal(h.downloads.get('https://64.media.tumblr.com/830000-0.png'),1);assert.equal(h.downloads.get('https://64.media.tumblr.com/830000-1.png'),2);
 }finally{await h.close();}
});

test('history rescan requires authentication and online permission, preserves saved posts and exclusions, and queues a stoppable fresh goal',async()=>{
 let reached=false;
 const app=createReaderServer({database:':memory:',port:0,jobs:{mediaSync:null,network:new RequestQueue({intervalMs:0}),browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:0},async open(){},async close(){},async manualSignIn(){},async navigate(_url,signal){reached=true;await new Promise<void>((_resolve,reject)=>signal!.addEventListener('abort',()=>reject(new Error('Stopped fixture')),{once:true}));throw new Error('Unreachable');}}}});
 try{
  const origin=await app.listen(),id=app.store.addSource({name:'tumblr:staff',historyMonths:1}),target=app.store.getTarget(id)!,state=newTumblrHistory(target);
  while(planTumblrWindow(state)){captureTumblrWindow(state,[],false,true);finishTumblrWindow(state);}
  const posts=['840000','840001'].map(id=>({id:'tumblr:staff:'+id,subreddit:'tumblr:staff',permalink:'https://www.tumblr.com/staff/'+id,title:'Retained '+id,body:'Complete local content',media:['Text' as const],created:{epochMs:Date.now()-86400000,precisionMs:1000},source:'live' as const,observedAt:Date.now()}));
  app.store.commitBatch({generation:app.store.generation,targetId:id,observations:posts,continuation:null,boundary:{...target.boundary,source:state},status:'done',completion:'listing-end'});app.store.deletePost(posts[1]!.id);app.store.addSubreddit('python');
  const token=(await(await fetch(origin+'/api/state')).json()).token;
  const request=(name:string,authenticated=true)=>fetch(origin+'/api/history/rescan',{method:'POST',headers:{'Content-Type':'application/json',...(authenticated?{'X-Reader-Token':token}:{})},body:JSON.stringify({name})});
  assert.equal((await request('tumblr:staff',false)).status,403);assert.equal((await request('tumblr:staff')).status,400);assert.equal(app.store.getHistoryPreference('tumblr:staff').targetId,id);
  await app.networkMode.change(false);assert.equal((await request('python')).status,400);assert.equal((await request('tumblr:absent')).status,400);
  const response=await request('tumblr:staff');assert.equal(response.status,200);const fresh=(await response.json()).targetId;assert.notEqual(fresh,id);await until(()=>reached,'Rescan did not start');assert.equal((await request('tumblr:staff')).status,400);
  assert.equal(app.store.getPost(posts[0]!.id)!.body,'Complete local content');assert(app.store.isPostExcluded(posts[1]!.id));assert.equal(app.store.getHistoryPreference('tumblr:staff').targetId,fresh);
  await app.jobs.stopSource('tumblr:staff');await until(()=>!app.jobs.state.running,'Rescan did not stop');assert.equal(app.store.getTarget(fresh)!.status,'paused');
  app.store.clearSubreddit('tumblr:staff');assert.equal(app.store.getHistoryPreference('tumblr:staff').targetId,null);assert(app.store.isPostExcluded(posts[1]!.id));
 }finally{await app.close();}
});
