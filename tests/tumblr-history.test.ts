import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReaderStore} from '../src/store.ts';
import {TUMBLR_DAY,tumblrSearchUrl,parseTumblrSearchUrl,tumblrResourceAllowed,validateListingUrl} from '../src/sources.ts';
import {newTumblrHistory,planTumblrWindow,captureTumblrWindow,finishTumblrWindow,tumblrHistoryCheckpoint,tumblrHistorySummary} from '../src/tumblr-history.ts';
const utc=(value:string)=>Date.parse(value+'T00:00:00Z');
function target(lower:number|null,upper:number){const store=new ReaderStore(':memory:');store.addSubreddit('tumblr:staff');const id=store.createTarget({subreddit:'tumblr:staff',lowerMs:lower??undefined,upperMs:upper});return{store,target:store.getTarget(id)!};}

test('dated search URLs overlap UTC boundaries and reject cross-blog queries, impossible dates, APIs and hidden search frames',()=>{
 const lower=utc('2025-01-01'),upper=utc('2025-02-01'),url=tumblrSearchUrl('tumblr:staff',lower,upper),scope=parseTumblrSearchUrl(url,'staff');
 assert.equal(scope.query,'from:staff since:2024-12-31 before:2025-02-02');assert.equal(scope.lower,lower);assert.equal(scope.upper,upper);assert.equal(validateListingUrl(url,'tumblr:staff').href,url);
 assert.equal(tumblrResourceAllowed(url,'Document','staff'),false);assert(tumblrResourceAllowed(url,'Document','staff',url));assert.equal(tumblrResourceAllowed(url,'XHR','staff',url),false);
 for(const bad of [url.replace('staff','other'),url.replace('2025-02-02','2025-02-30'),url+'?offset=10',url+'#x',url.replace('www.tumblr.com','api.tumblr.com'),url.replace('from%3A','evil%3A')])assert.throws(()=>parseTumblrSearchUrl(bad,'staff'));
});

test('all-time discovery reaches the epoch in bounded annual windows without claiming empty skeletons prove missing posts',()=>{
 const f=target(null,utc('2026-10-29')),state=newTumblrHistory(f.target);let count=0;
 try{
  while(planTumblrWindow(state)){captureTumblrWindow(state,[],false,true);finishTumblrWindow(state);count++;assert(count<100);}
  assert.equal(count,57);assert.equal(state.cursor,0);assert.equal(state.oldestChecked,0);assert.equal(state.unverified,57);assert(JSON.stringify(state).length<1000);
  const summary=tumblrHistorySummary({...f.target,boundary:{...f.target.boundary,source:state}})!;assert.equal(summary.finished,true);assert.equal(summary.remainingWindows,0);assert.equal(summary.unverifiedWindows,57);
 }finally{f.store.close();}
});

test('saturated windows split down to every day without holes and preserve explicit daily result-limit gaps',()=>{
 const f=target(utc('2025-01-01'),utc('2025-02-01')-1),state=newTumblrHistory(f.target),days:number[]=[];let deepest=0;
 try{
  for(let range=planTumblrWindow(state);range;range=planTumblrWindow(state)){
   if(range.upper-range.lower===TUMBLR_DAY)days.push(range.lower);
   captureTumblrWindow(state,[],true,false);finishTumblrWindow(state);deepest=Math.max(deepest,state.pending.length);
  }
  assert.equal(days.length,33);assert.equal(new Set(days).size,33);assert.equal(Math.min(...days),utc('2024-12-31'));assert.equal(Math.max(...days),utc('2025-02-01'));assert.equal(state.capped,33);assert.equal(state.checked,33);assert.equal(state.unverified,33);assert(deepest<10);
 }finally{f.store.close();}
});

test('a captured saving phase survives serialization and rejects corrupt or cross-source resume data',()=>{
 const f=target(utc('2025-01-01'),utc('2025-02-01')-1),state=newTumblrHistory(f.target);
 try{
  const range=planTumblrWindow(state)!;captureTumblrWindow(state,['tumblr:staff:12345'],false,false);
  const saved={...f.target,boundary:{...f.target.boundary,source:JSON.parse(JSON.stringify(state))}};
  const resumed=tumblrHistoryCheckpoint(saved)!;assert.deepEqual(planTumblrWindow(resumed),range);assert.deepEqual(resumed.active?.ids,['tumblr:staff:12345']);assert.equal(resumed.checked,0);
  assert.throws(()=>tumblrHistoryCheckpoint({...saved,boundary:{...saved.boundary,source:{...state,scopeUpper:state.scopeUpper+1}}}),/invalid/);
  assert.throws(()=>tumblrHistoryCheckpoint({...saved,boundary:{...saved.boundary,source:{...state,active:{...state.active,ids:['tumblr:other:12345']}}}}),/invalid/);
  for(const active of [false,0,'',undefined])assert.throws(()=>tumblrHistoryCheckpoint({...saved,boundary:{...saved.boundary,source:{...state,active}}}),/invalid; use Rescan/);
 }finally{f.store.close();}
});

test('known search matches link to a target without overwriting saved provenance and roll back cross-feed links',()=>{
 const f=target(utc('2025-01-01'),utc('2025-02-01'));
 try{
  const post={id:'tumblr:staff:12345',subreddit:'tumblr:staff',title:'Saved archive text',permalink:'https://www.tumblr.com/staff/12345',created:{epochMs:utc('2025-01-07'),precisionMs:1000},source:'archive' as const,exportId:'fixture',observedAt:0,body:'Original stored text',media:['Text' as const]};
  f.store.importArchiveBatch(f.store.generation,[post]);f.store.commitBatch({generation:f.store.generation,targetId:f.target.id,observations:[],seenPostIds:[post.id,post.id],continuation:null});
  assert.equal(f.store.getTarget(f.target.id)!.observedCount,1);assert.equal(f.store.getPost(post.id)!.source,'archive');assert.equal(f.store.getPost(post.id)!.body,post.body);
  assert.throws(()=>f.store.commitBatch({generation:f.store.generation,targetId:f.target.id,observations:[],seenPostIds:['tumblr:other:12345'],continuation:null}),/does not belong/);assert.equal(f.store.getTarget(f.target.id)!.observedCount,1);
 }finally{f.store.close();}
});

test('expanding history starts the wider dated scope without carrying a cursor for the old scope or pruning content',()=>{
 const store=new ReaderStore(':memory:'),upper=utc('2026-10-29');
 try{
  const id=store.addSource({name:'tumblr:staff',historyMonths:1},upper),original=store.getTarget(id)!,state=newTumblrHistory(original),range=planTumblrWindow(state)!;
  store.commitBatch({generation:store.generation,targetId:id,observations:[],continuation:tumblrSearchUrl('staff',range.lower,range.upper),boundary:{...original.boundary,source:state}});
  const expanded=store.setHistoryLimit('tumblr:staff',3,upper);assert(expanded.expanded);assert.equal(store.getTarget(expanded.targetId!)!.continuation,null);assert(store.getTarget(expanded.targetId!)!.lowerMs!<original.lowerMs!);assert.equal(store.getTarget(id)!.status,'cancelled');
 }finally{store.close();}
});

test('completed Tumblr catch-ups advance the freshness anchor without extending repeated refreshes back to subscription time',()=>{
 const store=new ReaderStore(':memory:'),start=utc('2025-01-01'),next=utc('2025-02-01'),later=utc('2025-02-02');
 const finish=(id:string)=>{const target=store.getTarget(id)!,state=newTumblrHistory(target);while(planTumblrWindow(state)){captureTumblrWindow(state,[],false,true);finishTumblrWindow(state);}store.commitBatch({generation:store.generation,targetId:id,observations:[],continuation:null,boundary:{...target.boundary,source:state},status:'done',completion:'listing-end',fromHead:true});};
 try{
  const initial=store.addSource({name:'tumblr:staff',historyMonths:0},start);finish(initial);
  const first=store.planSync(['tumblr:staff'],next).heads[0]!;assert.equal(store.getTarget(first)!.lowerMs,start);finish(first);assert.equal(store.getTarget(initial)!.anchorMs,next);
  const second=store.planSync(['tumblr:staff'],later).heads[0]!;assert.equal(store.getTarget(second)!.lowerMs,next);assert.equal(store.getTarget(initial)!.upperMs,start);assert.equal(tumblrHistoryCheckpoint(store.getTarget(initial)!)!.scopeUpper,start);
  // A paused search never moves this anchor or its saved original date scope.
  const target=store.getTarget(second)!,state=newTumblrHistory(target);planTumblrWindow(state);store.commitBatch({generation:store.generation,targetId:second,observations:[],continuation:tumblrSearchUrl('staff',state.active!.range!.lower,state.active!.range!.upper),boundary:{...target.boundary,source:state},fromHead:true});assert.equal(store.getTarget(initial)!.anchorMs,next);
 }finally{store.close();}
});

test('unknown blocked posts have a scoped, local exclusion recovery without fabricated post data; Clear retains the exclusion',()=>{
 const store=new ReaderStore(':memory:');
 try{
  store.addSource({name:'tumblr:staff',historyMonths:1});store.noteBlockedPost('tumblr:staff','tumblr:other:990000');assert.equal(store.blockedPost('tumblr:staff'),null);
  store.noteBlockedPost('tumblr:staff','tumblr:staff:990000');assert.equal(store.blockedPost('tumblr:staff')?.id,'tumblr:staff:990000');assert.throws(()=>store.excludeBlockedPost('tumblr:staff','tumblr:staff:990001'),/changed/);assert.equal(store.stats().posts,0);
  store.excludeBlockedPost('tumblr:staff','tumblr:staff:990000');assert.equal(store.blockedPost('tumblr:staff'),null);assert(store.isPostExcluded('tumblr:staff:990000'));assert.equal(store.getPost('tumblr:staff:990000'),null);store.clearSubreddit('tumblr:staff');assert(store.isPostExcluded('tumblr:staff:990000'));
  store.noteBlockedPost('tumblr:staff','tumblr:staff:990001');store.clearSubreddit('tumblr:staff');assert.equal(store.blockedPost('tumblr:staff'),null);
 }finally{store.close();}
});

test('unavailable evidence is deduplicated per target and run, source scoped, and cleared with its feed',()=>{
 const f=target(utc('2025-01-01'),utc('2025-02-01'));
 try{
  const id='tumblr:staff:995000';f.store.noteSourceUnavailable('tumblr:staff',id,'run-one');assert(f.store.sourceUnavailableThisRun('tumblr:staff',id,'run-one'));assert.equal(f.store.sourceUnavailableThisRun('tumblr:staff',id,'run-two'),false);
  for(let i=0;i<3;i++)f.store.commitBatch({generation:f.store.generation,targetId:f.target.id,observations:[],continuation:null,unavailablePostIds:[id,id]});assert.equal(f.store.getTarget(f.target.id)!.omissionCount,1);assert.equal(f.store.getPost(id),null);
  assert.throws(()=>f.store.commitBatch({generation:f.store.generation,targetId:f.target.id,observations:[],continuation:null,unavailablePostIds:['tumblr:other:995000']}),/another feed/);assert.equal(f.store.getTarget(f.target.id)!.omissionCount,1);
  f.store.beginFeedSync('tumblr:staff',[f.target.id]);assert.equal(f.store.sourceUnavailableThisRun('tumblr:staff',id,'run-one'),false);f.store.clearSubreddit('tumblr:staff');assert.equal(f.store.getSetting('targetMissing:'+f.target.id+':'+id),null);
 }finally{f.store.close();}
});

test('a missing dateless ID observed in overlapping catch-up and history targets counts once in the feed report',()=>{
 const f=target(utc('2025-01-01'),utc('2025-02-01')),other=f.store.createTarget({subreddit:'tumblr:staff',lowerMs:utc('2024-01-01'),upperMs:utc('2025-02-01')});
 try{
  const run=f.store.beginFeedSync('tumblr:staff',[f.target.id,other]);for(const targetId of [f.target.id,other])f.store.commitBatch({generation:f.store.generation,targetId,observations:[],continuation:null,unavailablePostIds:['tumblr:staff:995000'],status:'done',completion:'listing-end'});
  f.store.finishFeedSync('tumblr:staff',run);assert.match(f.store.feedSync('tumblr:staff').reason!,/1 post extraction\(s\) omitted/);assert.doesNotMatch(f.store.feedSync('tumblr:staff').reason!,/2 post extraction/);
 }finally{f.store.close();}
});
