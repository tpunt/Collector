import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ReaderStore} from '../src/store.ts';
import {CollectionReports} from '../src/collection-report.ts';
const record=(body='Body')=>({id:'abc',subreddit:'python',permalink:'/r/python/comments/abc/',title:'Title',body,media:['Text' as const],created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,observedAt:Date.now(),exportId:'report'});
test('reports count distinct committed posts, real content changes and saved files; clearing invalidates late results',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');const reports=new CollectionReports(store);
 try{
  reports.begin('python','sync');store.importArchiveBatch(store.generation,[record()]);reports.observe('python',[null],['abc']);reports.observe('python',[store.getPost('abc')],['t3_abc']);
  assert.equal(reports.get('python')!.checkedPosts,1);assert.equal(reports.get('python')!.newPosts,1);assert.equal(reports.get('python')!.updatedPosts,0);
  reports.saved('python',1200);reports.finish('python','finished');assert.equal(reports.get('python')!.filesSaved,1);assert.equal(reports.get('python')!.bytesSaved,1200);
  reports.begin('python','sync');const before=store.getPost('abc');store.savePostBody(store.generation,'abc','Edited body');reports.observe('python',[before],['t3_abc']);reports.observe('python',[store.getPost('abc')],['t3_abc']);assert.equal(reports.get('python')!.updatedPosts,1);
  const restored=new CollectionReports(store);assert.equal(restored.get('python')!.state,'paused');
  store.clearSubreddit('python');reports.saved('python',10);reports.finish('python','finished');assert.equal(reports.get('python'),null);
  reports.begin('python','retry');store.clearContent();reports.saved('python',10);assert.equal(reports.get('python'),null);
 }finally{store.close();}
});


test('a closing archive attempt cannot finish a newer feed report',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');const reports=new CollectionReports(store);
 try{const old=reports.begin('python','archive'),current=reports.begin('python','sync');reports.finish('python','paused','Old archive stopped',old);assert.equal(reports.get('python')!.id,current);assert.equal(reports.get('python')!.state,'running');reports.finish('python','finished',null,current);assert.equal(reports.get('python')!.state,'finished');}finally{store.close();}
});

test('saving previously incomplete text is counted separately from editing a known full body',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');const reports=new CollectionReports(store);
 try{store.importArchiveBatch(store.generation,[record()]);store.setBodySync(store.generation,'abc','failed','Text was not yet fully read');const before=store.getPost('abc');reports.begin('python','sync');store.savePostBody(store.generation,'abc','Now the complete text');store.saveMediaReferences(store.generation,'abc',[{kind:'image',url:'https://i.redd.it/newly-discovered.png'}]);reports.observe('python',[before],['abc']);reports.observe('python',[store.getPost('abc')],['t3_abc']);assert.equal(reports.get('python')!.textCompleted,1);assert.equal(reports.get('python')!.updatedPosts,0);reports.finish('python','finished');reports.begin('python','sync');const full=store.getPost('abc');store.savePostBody(store.generation,'abc','Edited full text');reports.observe('python',[full],['abc']);assert.equal(reports.get('python')!.updatedPosts,1);assert.equal(reports.get('python')!.textCompleted,0);}finally{store.close();}
});

test('repairing files finishes the old sync without advertising a newer listing fetch',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');
 try{store.importArchiveBatch(store.generation,[{...record(),media:['Image'],attachments:[{kind:'image',url:'https://i.redd.it/repair.png'}]}]);const target=store.createTarget({subreddit:'python',upperMs:Date.now()}),started=Date.now()-86400000,run=store.beginFeedSync('python',[target],started);store.commitBatch({generation:store.generation,targetId:target,observations:[],continuation:null,status:'done',completion:'date-boundary'});store.finishFeedSync('python',run);assert.equal(store.feedSync('python').state,'incomplete');store.setMediaSync(store.generation,'abc','ready');store.settleMediaRetry('python');assert.equal(store.feedSync('python').state,'complete');assert.equal(store.feedSync('python').lastSuccessAt,started);assert(store.feedSync('python').lastCompletedAt!>started);}finally{store.close();}
});

test('a sync startup failure ends its report and leaves the feed available for another operation',async()=>{
 const {ReaderJobs}=await import('../src/jobs.ts');const store=new ReaderStore(':memory:');store.addSource({name:'python',historyMonths:1});const reports=new CollectionReports(store),jobs=new ReaderJobs(store,{reports,mediaSync:null});
 try{jobs.targets=()=>{throw new Error('Newer catch-up was cancelled');};assert.throws(()=>jobs.syncFeeds(['python']),/cancelled/);assert.equal(reports.get('python')!.state,'paused');assert.match(reports.get('python')!.reason!,/cancelled/);assert.equal(jobs.feedStatus('python'),'idle');jobs.retryMedia(['python']);assert.equal(reports.get('python')!.kind,'retry');assert.equal(reports.get('python')!.state,'finished');}finally{await jobs.close();store.close();}
});

test('stopping a queued feed settles its report immediately and cannot close a replacement archive report',async()=>{
 const {ReaderJobs}=await import('../src/jobs.ts');const store=new ReaderStore(':memory:');store.addSubreddit('pics');store.addSource({name:'python',historyMonths:1});store.importArchiveBatch(store.generation,[{...record(),subreddit:'pics',permalink:'/r/pics/comments/abc/',media:['Image'],attachments:[{kind:'image',url:'https://i.redd.it/held.png'}]}]);const reports=new CollectionReports(store);let started=false,release!:()=>void;const held=new Promise<void>(resolve=>release=resolve);
 const jobs=new ReaderJobs(store,{reports,mediaSync:{status:{requests:0},pendingPosts:(feed,session)=>store.pendingMedia(feed,session),preparePost:()=>({discover:false}),async syncPost(id,session){started=true;await held;store.setMediaSync(store.generation,id,'ready',null,session);},stop(){}}});
 try{jobs.syncMedia(['pics']);const end=Date.now()+10000;while(!started){if(Date.now()>end)throw new Error('Held media work did not start');await new Promise(resolve=>setTimeout(resolve,2));}jobs.syncFeeds(['python']);assert.equal(reports.get('python')!.state,'running');await jobs.stopSource('python');assert.equal(reports.get('python')!.state,'paused');const archive=reports.begin('python','archive');release();while(jobs.state.running){if(Date.now()>end)throw new Error('Worker did not finish');await new Promise(resolve=>setTimeout(resolve,2));}assert.equal(reports.get('python')!.id,archive);assert.equal(reports.get('python')!.state,'running');reports.finish('python','finished',null,archive);}finally{release?.();await jobs.close();store.close();}
});

test('archive-page fingerprint release retains cumulative counters for deep history',()=>{
 const store=new ReaderStore(':memory:');store.addSubreddit('python');const reports=new CollectionReports(store);
 try{reports.begin('python','archive');for(const id of ['abc','def']){const value={...record(),id,permalink:`/r/python/comments/${id}/`};store.importArchiveBatch(store.generation,[value]);reports.observe('python',[null],[id]);reports.releaseArchivePage('python',[id]);}assert.equal(reports.get('python')!.newPosts,2);assert.equal(reports.get('python')!.checkedPosts,2);reports.finish('python','finished');assert.equal(reports.get('python')!.newPosts,2);}finally{store.close();}
});
