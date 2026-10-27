import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ReaderStore} from '../src/store.ts';
import {ReaderJobs} from '../src/jobs.ts';
import type {PostObservation} from '../src/domain.ts';
import type {ThreadSnapshot} from '../src/extract.ts';

const post=(body?:string):PostObservation=>({id:'abc',subreddit:'python',title:'Full offline post',permalink:'/r/python/comments/abc/',created:{epochMs:Date.now()-45*86400000,precisionMs:1000},source:'live',observedAt:Date.now(),media:['Text'],body});
const snapshot=(body:string|null):ThreadSnapshot=>({id:crypto.randomUUID(),postId:'t3_abc',source:'live',capturedAt:Date.now(),observedAt:Date.now()+1,sort:'best',body,availability:'available',comments:[],omitted:10,sample:'Discussion intentionally not saved by automatic body work'});
const browser=()=>({counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(url:string){return{url:()=>url}as any;}});
async function settled(jobs:ReaderJobs){const deadline=Date.now()+3000;while(jobs.state.running){if(Date.now()>deadline)throw new Error('Body sync did not settle');await new Promise(r=>setTimeout(r,2));}}

test('sync saves full text, refetches an observed update and leaves discussion collection on demand',async()=>{
 const store=new ReaderStore(':memory:');store.addSource({name:'python'});let reads=0,value='Full text '.repeat(10000)+'TAIL_SENTINEL';
 const jobs=new ReaderJobs(store,{browser:browser(),readAccount:async()=> 'fixture_user',readListing:async()=>({account:'fixture_user',posts:[{...post('Listing preview'),bodyNeedsFetch:true}],ordinary:[],unknownTime:false,omissions:0,next:null,empty:false,signature:'body-page'}),readThread:async()=>{reads++;assert.equal(store.bodySync('abc')?.status,'fetching');assert.equal(store.feedSync('python').lastSuccessAt,null);return{snapshot:snapshot(value),topLink:null};}});
 try{
  jobs.syncFeeds(['python']);await settled(jobs);assert.equal(reads,1);assert.equal(store.getPost('abc')?.body,value);assert.equal(store.bodySync('abc')?.status,'ready');assert.equal(store.latestSnapshot('abc'),null);assert.equal(store.queryFeed({text:'TAIL_SENTINEL'}).posts.length,1);
  value='Changed full post';jobs.syncFeeds(['python']);await settled(jobs);assert.equal(reads,2);assert.equal(store.getPost('abc')?.body,value);assert.equal(store.pendingBodies('python').length,0);assert.equal(store.latestSnapshot('abc'),null);
 }finally{await jobs.close();store.close();}
});

test('failed body reads remain incomplete without automatic retries; a later explicit sync accepts a genuinely empty body',async()=>{
 const store=new ReaderStore(':memory:');store.addSource({name:'python'});let reads=0;
 const jobs=new ReaderJobs(store,{browser:browser(),readAccount:async()=> 'fixture_user',readListing:async()=>({account:'fixture_user',posts:[post()],ordinary:[],unknownTime:false,omissions:0,next:null,empty:false,signature:'missing-body'}),readThread:async()=>{reads++;if(reads===1)throw new Error('Temporary text read failure');return{snapshot:snapshot(''),topLink:null};}});
 try{
  jobs.syncFeeds(['python']);await settled(jobs);assert.equal(store.feedSync('python').state,'incomplete');assert.equal(store.bodySync('abc')?.status,'failed');assert.equal(reads,1);
  jobs.syncFeeds(['python']);await settled(jobs);assert.equal(reads,2);assert.equal(store.getPost('abc')?.body,'');assert.equal(store.bodySync('abc')?.status,'ready');assert.notEqual(store.feedSync('python').state,'incomplete');
 }finally{await jobs.close();store.close();}
});

test('an interrupted text update survives database restart even when an older body is already stored',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'reader-body-restart-')),path=join(directory,'reader.sqlite');let store=new ReaderStore(path),jobs:ReaderJobs|undefined;
 try{
  const target=store.addSource({name:'python'});store.commitBatch({generation:store.generation,targetId:target,observations:[{...post('Old saved body'),bodyNeedsFetch:true}],continuation:null,status:'done',completion:'date-boundary'});
  store.setBodySync(store.generation,'abc','fetching');store.close();store=new ReaderStore(path);assert.equal(store.bodySync('abc')?.status,'pending');assert.equal(store.getPost('abc')?.body,'Old saved body');
  let reads=0;jobs=new ReaderJobs(store,{browser:browser(),readAccount:async()=> 'fixture_user',readListing:async()=>({account:'fixture_user',posts:[],ordinary:[],unknownTime:false,omissions:0,next:null,empty:true,signature:'empty-head'}),readThread:async()=>{reads++;return{snapshot:snapshot('Updated saved body'),topLink:null};}});
  assert.equal(reads,0);jobs.syncFeeds(['python']);await settled(jobs);assert.equal(reads,1);assert.equal(store.getPost('abc')?.body,'Updated saved body');assert.equal(store.bodySync('abc')?.status,'ready');
 }finally{await jobs?.close();store.close();await rm(directory,{recursive:true,force:true});}
});
