import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { ReaderStore } from '../src/store.ts';
import { ReaderJobs } from '../src/jobs.ts';
import type { Listing } from '../src/extract.ts';

function listing(name:string):Listing {
  const id=name==='python'?'t3_abc':'t3_def';
  return {account:'fixture_user',posts:[{id,subreddit:name,title:'Fixture '+name,permalink:`/r/${name}/comments/${id.slice(3)}/`,created:{epochMs:1600000000000,precisionMs:1000},source:'live',observedAt:Date.now(),media:name==='python'?['Text']:['Image']}],ordinary:[],unknownTime:false,omissions:0,next:null,empty:false,signature:id};
}
class FakeBrowser {
  counts={intercepted:0,released:0,aborted:0,suppressed:0,intervalMs:5000};
  openState=false;closed=0;visits:string[]=[];blocked:string|null=null;release:(()=>void)|null=null;
  reject:((error:Error)=>void)|null=null;
  async open(){if(!this.openState){this.openState=true;this.counts={...this.counts,intercepted:0,released:0};}}
  async close(){if(this.openState){this.closed++;this.openState=false;this.reject?.(new Error('Browser closed'));this.reject=null;}}
  async manualSignIn(){}
  async navigate(url:string,signal?:AbortSignal){
    signal?.throwIfAborted();this.visits.push(url);this.counts.released++;this.counts.intercepted++;
    if(url.includes(this.blocked??'never-match-fixture'))await new Promise<void>((resolve,reject)=>{this.release=resolve;this.reject=reject;});
    return {url:()=>url} as Page;
  }
}
async function until(condition:()=>boolean){const deadline=Date.now()+2000;while(!condition()){if(Date.now()>deadline)throw new Error('Local scheduler did not settle');await new Promise(resolve=>setTimeout(resolve,2));}}
function setup(t:{after:(fn:()=>void|Promise<void>)=>void}){
  const store=new ReaderStore(':memory:');const now=Date.now();
  const python=store.addSource({name:'python',lowerMs:now-86400000},now);
  const aww=store.addSource({name:'aww',lowerMs:now-86400000},now);
  const browser=new FakeBrowser();const jobs=new ReaderJobs(store,{browser,readListing:async(_page,name)=>listing(name)});
  t.after(async()=>{await jobs.close();store.close();});return{store,jobs,browser,python,aww};
}

test('stopping an active feed aborts its request and allows another queued feed to finish',async t=>{
  const {store,jobs,browser,python,aww}=setup(t);browser.blocked='/r/aww/';jobs.targets([aww,python],{heads:true});
  await until(()=>browser.visits.length===1);assert.equal(jobs.feedStatus('aww'),'syncing');assert.equal(jobs.feedStatus('python'),'queued');
  await jobs.stopSource('aww');await until(()=>!jobs.state.running);
  assert.equal(store.getTarget(aww)?.status,'paused');assert.equal(store.getTarget(python)?.status,'done');
  assert.equal(store.feedSources().find(feed=>feed.name==='aww')?.sync.lastSuccessAt,null);
  assert(store.getPost('abc'));assert.equal(store.feedSources().find(feed=>feed.name==='python')?.sync.lastSuccessAt,null);
  assert.equal(jobs.state.accessPause,null);assert.equal(jobs.state.requests.sessionTotal,2);
});
test('stopping a queued feed never interrupts the unrelated active browser operation',async t=>{
  const {store,jobs,browser,python,aww}=setup(t);browser.blocked='/r/python/';jobs.targets([python,aww],{heads:true});
  await until(()=>browser.visits.length===1);await jobs.stopSource('aww');assert.equal(browser.closed,0);assert.equal(jobs.feedStatus('python'),'syncing');
  browser.release!();await until(()=>!jobs.state.running);
  assert.equal(browser.visits.length,1);assert.equal(store.getTarget(aww)?.status,'paused');assert.equal(store.getTarget(python)?.status,'done');
});
test('stop preserves saved posts and the Next checkpoint without marking sync complete',async t=>{
  const {store,browser,python}=setup(t);const jobs=new ReaderJobs(store,{browser,readListing:async(_page,name)=>({...listing(name),next:'https://old.reddit.com/r/python/new/?after=t3_abc'})});
  t.after(()=>jobs.close());browser.blocked='?after=';jobs.targets([python],{heads:true});await until(()=>browser.visits.length===2);
  const successful=store.feedSources().find(feed=>feed.name==='python')?.sync.lastSuccessAt;assert.equal(successful,null);assert(store.getPost('abc'));
  await jobs.stopSource('python');await until(()=>!jobs.state.running);
  assert.equal(store.getTarget(python)?.continuation,'https://old.reddit.com/r/python/new/?after=t3_abc');assert.equal(store.getTarget(python)?.status,'paused');assert.equal(store.feedSources().find(feed=>feed.name==='python')?.sync.lastSuccessAt,successful);
});
test('offline completion is independent, persisted and never advanced by a partial or rejected page',()=>{
  const directory=mkdtempSync(join(tmpdir(),'reader-feed-times-')),path=join(directory,'reader.sqlite');let store=new ReaderStore(path);
  try{
    const now=1800000000000,python=store.addSource({name:'python'},now);store.addSource({name:'aww'},now);
    const run=store.beginFeedSync('python',[python],now+1);
    assert.throws(()=>store.commitBatch({generation:store.generation,targetId:python,observations:[...listing('python').posts,...listing('aww').posts],continuation:null,fromHead:true}),/another subreddit/);
    assert.equal(store.feedSync('python').lastSuccessAt,null);assert.equal(store.stats().posts,0);
    store.commitBatch({generation:store.generation,targetId:python,observations:listing('python').posts,continuation:null,fromHead:true,status:'done',completion:'date-boundary'});
    assert.equal(store.feedSync('python').lastSuccessAt,null);store.finishFeedSync('python',run,now+2);
    const plan=store.planSync(['python'],now+3);store.beginFeedSync('python',[...plan.heads,...plan.history,python],now+3);store.pauseSource('python','Stopped by user');
    store.close();store=new ReaderStore(path);
    assert.equal(store.feedSync('python').lastSuccessAt,now+2);assert.equal(store.feedSync('aww').lastSuccessAt,null);
    store.removeSubreddit('python');assert.deepEqual(store.followedSources(),['aww']);assert.equal(store.queryFeed().posts.length,0);assert(store.getPost('abc'));
  }finally{store.close();rmSync(directory,{recursive:true,force:true});}
});
