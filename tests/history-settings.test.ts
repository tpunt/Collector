import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { HISTORY_OPTIONS,historyLowerBound,historyMonths } from '../src/history-window.ts';
import { ReaderStore } from '../src/store.ts';
import { ReaderJobs } from '../src/jobs.ts';
import type { Listing } from '../src/extract.ts';
import { advanceBoundary } from '../src/history.ts';

const now=Date.parse('2026-10-22T12:00:00Z');
async function settled(jobs:ReaderJobs){const deadline=Date.now()+2000;while(jobs.state.running){if(Date.now()>deadline)throw new Error('Fixture history did not settle');await new Promise(resolve=>setTimeout(resolve,2));}}
function page(date:string,prefix:string,next:string|null,n=5):Listing{
 const posts=Array.from({length:n},(_,index)=>({id:`t3_${prefix}${index}`,subreddit:'python',title:'History fixture '+prefix+index,permalink:`/r/python/comments/${prefix}${index}/`,created:{epochMs:Date.parse(date)-index*1000,precisionMs:1000},source:'live' as const,observedAt:now,media:['Text' as const]}));
 return{account:'fixture_user',posts,ordinary:posts.map(post=>({id:post.id,createdMs:post.created.epochMs,precisionMs:1000})),unknownTime:false,omissions:0,next,empty:n===0,signature:posts.map(post=>post.id).join(',')};
}
const url=(id:string)=>`https://old.reddit.com/r/python/new/?after=t3_${id}`;

test('replayed large pages cannot complete a date boundary or a listing end',()=>{
 const store=new ReaderStore(':memory:');
 try{
  store.addSubreddit('python');const id=store.createTarget({subreddit:'python',lowerMs:now-86400000,upperMs:now});
  let target=store.getTarget(id)!;const listing=page('2026-01-01T00:00:00Z','repeat',url('repeat24'),25);
  const first=advanceBoundary(target,listing);assert.equal(first.done,false);assert.equal(first.boundary.batches,1);
  target={...target,boundary:first.boundary};
  const repeat=advanceBoundary(target,{...listing,next:null});assert.equal(repeat.done,false);assert.equal(repeat.boundary.batches,1);assert.equal(repeat.boundary.repeats,1);
  const nonconsecutive=advanceBoundary({...target,boundary:{...target.boundary,lastSignature:'another-page'}},listing,true);
  assert.equal(nonconsecutive.done,false);assert.equal(nonconsecutive.boundary.batches,1);
  const stalled=advanceBoundary({...target,boundary:repeat.boundary},listing,true);assert.equal(stalled.stalled,true);assert.equal(stalled.done,false);
  const distinct=advanceBoundary(target,page('2025-12-01T00:00:00Z','distinct',url('distinct4')));assert.equal(distinct.done,true);assert.equal(distinct.completion,'date-boundary');
 }finally{store.close();}
});

test('all requested history presets use calendar bounds, including month ends and leap years',()=>{
 assert.deepEqual(HISTORY_OPTIONS.map(option=>option.months),[1,3,6,12,24,36,60,0]);
 assert.equal(historyLowerBound(1,now),Date.parse('2026-09-22T12:00:00Z'));assert.equal(historyLowerBound(3,now),Date.parse('2026-07-22T12:00:00Z'));
 assert.equal(historyLowerBound(1,Date.parse('2024-03-31T12:30:00Z')),Date.parse('2024-02-29T12:30:00Z'));
 assert.equal(historyLowerBound(12,Date.parse('2024-02-29T00:00:00Z')),Date.parse('2023-02-28T00:00:00Z'));
 assert.equal(historyLowerBound(60,now),Date.parse('2021-10-22T12:00:00Z'));assert.equal(historyLowerBound(0,now),null);assert.throws(()=>historyMonths(2));assert.throws(()=>historyMonths('3'));
});
test('backfill crosses a month, resumes for three months, then reaches actual all-time fixture exhaustion despite known IDs',async()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');
 store.importArchiveBatch(store.generation,[{...page('2026-10-21T12:00:00Z','a',null,1).posts[0]!,source:'archive',exportId:'known'},
 {...page('2010-01-01T00:00:00Z','ancient',null,1).posts[0]!,source:'archive',exportId:'old-sparse'}]);
 const pages=new Map([
  ['https://old.reddit.com/r/python/new/',page('2026-10-21T12:00:00Z','a',url('a4'))],
  [url('a4'),page('2026-09-25T12:00:00Z','b',url('b4'))],
  [url('b4'),page('2026-09-20T12:00:00Z','c',url('c4'))],
  [url('c4'),page('2026-09-15T12:00:00Z','d',url('d4'))],
  [url('d4'),page('2026-08-15T12:00:00Z','e',url('e4'))],
  [url('e4'),page('2026-07-20T12:00:00Z','f',url('f4'))],
  [url('f4'),page('2026-07-19T12:00:00Z','g',url('g4'))],
  [url('g4'),page('2026-06-01T12:00:00Z','h',url('h4'))],
  [url('h4'),page('2026-05-01T12:00:00Z','i',null)],
 ]);
 const visits:string[]=[];const browser={counts:{intercepted:0,released:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(value:string){visits.push(value);return{url:()=>value}as Page;}};
 const jobs=new ReaderJobs(store,{browser,readListing:async tab=>{const result=pages.get(tab.url());assert(result,'Unexpected invented continuation');return result;}});
 try{
  assert.equal(store.getHistoryPreference('python').months,1);const first=store.ensureHistoryTarget('python',now);jobs.targets([first],{});await settled(jobs);
  assert.equal(visits.length,4);assert.equal(store.getTarget(first)?.completion,'date-boundary');assert.equal(store.getTarget(first)?.continuation,url('d4'));
  const expanded=store.setHistoryLimit('python',3,now);assert.equal(expanded.expanded,true);assert.equal(store.getTarget(expanded.targetId!)?.continuation,url('d4'));
  jobs.targets([expanded.targetId!],{});await settled(jobs);assert.equal(visits[4],url('d4'));assert.equal(visits.length,7);assert.equal(store.getTarget(expanded.targetId!)?.completion,'date-boundary');
  const all=store.setHistoryLimit('python',0,now);jobs.targets([all.targetId!],{});await settled(jobs);
  assert.equal(visits.length,9);assert.equal(store.getTarget(all.targetId!)?.completion,'listing-end');assert.equal(store.getTarget(all.targetId!)?.status,'done');assert.equal(store.getTarget(all.targetId!)?.lastPage,url('h4'));
  const before=store.stats().posts,range=store.feedSources()[0]!;
  assert.equal(range.oldestMs,Date.parse('2010-01-01T00:00:00Z'));assert.equal(range.archiveCount,1);assert.equal(range.liveCount,45);
  const smaller=store.setHistoryLimit('python',1,now);assert.equal(smaller.expanded,false);assert.equal(store.stats().posts,before);assert.equal(visits.length,9);assert.equal(store.feedSources()[0]?.historyMonths,1);
  const last=visits.length;const plan=store.planSync(['python'],now+3600000);assert.equal(plan.history.length,1,'A listing end cannot prove the contracted date range was scanned');assert.equal(visits.length,last);
 }finally{await jobs.close();store.close();}
});
test('history preference and checkpoint persist without automatically starting; contraction preserves imported and live posts',()=>{
 const dir=mkdtempSync(join(tmpdir(),'reader-history-settings-'));const path=join(dir,'reader.sqlite');let store=new ReaderStore(path);
 try{
  const target=store.addSource({name:'python',lowerMs:historyLowerBound(1,now)!,historyMonths:1},now);
  store.commitBatch({generation:store.generation,targetId:target,observations:page('2026-09-01T00:00:00Z','p',null).posts,continuation:url('p4'),pageUrl:'https://old.reddit.com/r/python/new/'});
  const bigger=store.setHistoryLimit('python',60,now+86400000);assert.equal(store.getTarget(bigger.targetId!)?.continuation,url('p4'));
  store.close();store=new ReaderStore(path);assert.equal(store.feedSources()[0]?.historyMonths,60);assert.equal(store.feedSources()[0]?.historyTarget?.status,'paused');assert(store.feedSources()[0]?.historyTarget?.dependsOn);assert.equal(store.getTarget(store.feedSources()[0]!.historyTarget!.dependsOn!)?.status,'paused');
  const count=store.stats().posts;store.setHistoryLimit('python',1,now);assert.equal(store.stats().posts,count);assert.equal(store.feedSources()[0]?.historyTarget?.status,'paused');
  store.clearContent();assert.equal(store.feedSources()[0]?.historyMonths,1);assert.equal(store.feedSources()[0]?.historyTarget,null);assert.equal(store.feedSources()[0]?.oldestMs,null);
 }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('expansion after a long absence fetches the newer gap before reusing an old history checkpoint',async()=>{
 const store=new ReaderStore(':memory:');const earlier=Date.parse('2024-10-22T12:00:00Z');
 const old=store.addSource({name:'python',lowerMs:historyLowerBound(1,earlier)!,historyMonths:1},earlier);
 store.commitBatch({generation:store.generation,targetId:old,observations:page('2024-09-01T00:00:00Z','old',null).posts,continuation:url('old4'),pageUrl:'https://old.reddit.com/r/python/new/',fromHead:true,status:'done',completion:'date-boundary'});
 const result=store.setHistoryLimit('python',3,now);assert(result.headTargetId);assert.equal(store.getTarget(result.headTargetId!)?.lowerMs,historyLowerBound(3,now));
 const visits:string[]=[];const jobs=new ReaderJobs(store,{browser:{counts:{intercepted:0,released:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(value){visits.push(value);return{url:()=>value}as Page;}},readListing:async tab=>tab.url().includes('?')?page('2026-07-20T00:00:00Z','gapb',url('gapb4')):page('2026-07-21T00:00:00Z','gapa',url('gapa4'))});
 try{
  jobs.targets([result.headTargetId!],{heads:true});jobs.targets([result.targetId!],{});await settled(jobs);
  assert.deepEqual(visits,['https://old.reddit.com/r/python/new/',url('gapa4')]);assert.equal(store.getTarget(result.targetId!)?.completion,'date-boundary');assert.equal(store.getTarget(result.targetId!)?.anchorMs,now);assert(store.getPost('old0'));
 }finally{await jobs.close();store.close();}
});

test('a disconnected rolling window starts a fresh scan without losing older collected history',()=>{
 const store=new ReaderStore(':memory:');try{
  const oldTime=Date.parse('2024-10-22T12:00:00Z');const id=store.addSource({name:'python',lowerMs:historyLowerBound(1,oldTime)!,historyMonths:1},oldTime);
  store.commitBatch({generation:store.generation,targetId:id,observations:page('2024-09-01T00:00:00Z','past',null).posts,continuation:url('past4'),pageUrl:'https://old.reddit.com/r/python/new/',fromHead:true,status:'done',completion:'date-boundary'});
  const plan=store.planSync(['python'],now);const current=store.getTarget(plan.heads[0]!)!;
  assert.equal(current.continuation,null);assert.equal(current.lowerMs,historyLowerBound(1,now));assert.equal(current.anchorMs,now);assert.equal(store.stats().posts,5);assert.equal(store.getTarget(id)?.continuation,url('past4'));
 }finally{store.close();}
});
