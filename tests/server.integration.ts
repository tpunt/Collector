import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReaderServer } from '../src/server.ts';
import { ArchiveImporter } from '../src/archive.ts';
import { Readable } from 'node:stream';
test('loopback server rejects cross-origin writes and requires a per-launch token; Clear leaves no stale feed',async()=>{
  const app=createReaderServer({database:':memory:',port:0});const origin=await app.listen();
  try{
    assert.equal((await fetch(origin+'/api/clear',{method:'POST'})).status,403);
    assert.equal((await fetch(origin+'/api/state',{headers:{Origin:'https://evil.test'}})).status,403);
    const state=await(await fetch(origin+'/api/state')).json() as {token:string;sources:string[]};assert.deepEqual(state.sources,[]);assert.equal('summary' in state,false);
    app.store.addSubreddit('python');const data=Buffer.from(JSON.stringify({id:'abc',subreddit:'python',title:'Fixture',created_utc:1600000000,is_self:true,selftext:'Body'}));await new ArchiveImporter(app.store).run(Readable.from([data]),{subreddit:'python',filename:'fixture.jsonl',size:data.length,modified:1});
    assert.equal((await(await fetch(origin+'/api/feed?media=Text')).json() as any).posts.length,1);
    assert.equal((await fetch(origin+'/api/clear',{method:'POST',headers:{'X-Reader-Token':state.token}})).status,200);
    assert.equal((await(await fetch(origin+'/api/feed')).json() as any).posts.length,0);
    for(const path of ['summary','refresh','continue','cancel'])assert.equal((await fetch(origin+'/api/'+path,{method:'POST',headers:{'X-Reader-Token':state.token},body:'{}'})).status,404);
  }finally{await app.close();}
});

test('feed removal requires explicit confirmation and refresh is scoped to subscribed selected feeds',async()=>{
  const visited:string[]=[];
  const app=createReaderServer({database:':memory:',port:0,jobs:{browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(url){visited.push(url);return {} as any;}},readListing:async(_page,name)=>({account:'fixture_user',posts:[],ordinary:[],unknownTime:false,omissions:0,next:null,empty:true,signature:name})}});
  const now=Date.now();app.store.addSource({name:'python',lowerMs:now-1000},now);app.store.addSource({name:'aww',lowerMs:now-1000},now);
  const origin=await app.listen();
  try{
    const {token}=await(await fetch(origin+'/api/state')).json() as {token:string};
    const post=(path:string,data:unknown)=>fetch(origin+'/api/'+path,{method:'POST',headers:{'X-Reader-Token':token,'Content-Type':'application/json'},body:JSON.stringify(data)});
    assert.equal((await post('remove',{name:'aww'})).status,400);assert(app.store.followedSources().includes('aww'));
    assert.equal((await post('sync',{names:['python']})).status,200);
    const deadline=Date.now()+1000;while(app.jobs.state.running){if(Date.now()>deadline)throw new Error('Fixture did not settle');await new Promise(resolve=>setTimeout(resolve,2));}
    assert(visited.length>0);assert(visited.every(url=>url.includes('/r/python/')));assert.equal(app.store.feedSources().find(feed=>feed.name==='aww')?.sync.lastSuccessAt,null);
    assert.equal((await post('sync',{names:['unsubscribed']})).status,400);
    assert.equal((await post('remove',{name:'aww',confirm:true})).status,200);assert.deepEqual(app.store.followedSources(),['python']);
  }finally{await app.close();}
});

test('scoped Clear requires confirmation, deletes exclusive and superseded media, and keeps shared media and other feeds',async()=>{
 const {RequestQueue}=await import('../src/request-gate.ts'),{stat}=await import('node:fs/promises');
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}})}});
 const record=(name:string,id:string,url:string)=>({id,subreddit:name,title:'Clear fixture '+id,permalink:`/r/${name}/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,exportId:'clear-api',observedAt:1800000000000,media:['Image' as const],attachments:[{kind:'image' as const,url}]});
 app.store.addSource({name:'aww',historyMonths:3});app.store.addSubreddit('python');
 app.store.importArchiveBatch(app.store.generation,[record('aww','abc','https://i.redd.it/exclusive.png'),record('aww','def','https://i.redd.it/shared.png'),record('python','ghi','https://i.redd.it/shared.png')]);
 const origin=await app.listen();
 try{
  await app.media.syncPost('abc','fixture',10,new AbortController().signal);await app.media.syncPost('def','fixture',10,new AbortController().signal);
  const exclusive=(await app.media.items('abc'))[0]!.localPath!,shared=(await app.media.items('ghi'))[0]!.localPath!;
  app.store.importArchiveBatch(app.store.generation,[{...record('aww','abc','https://i.redd.it/replaced.png'),observedAt:1800000000001}]);
  const {token}=await(await fetch(origin+'/api/state')).json()as any;const clear=(data:unknown,auth=true)=>fetch(origin+'/api/clear-source',{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Reader-Token':token}:{})},body:JSON.stringify(data)});
  assert.equal((await clear({name:'aww',confirm:true},false)).status,403);assert.equal((await clear({name:'aww'})).status,400);assert.equal((await clear({name:'aww',confirm:'yes'})).status,400);assert.equal((await clear({name:'missing',confirm:true})).status,400);assert.equal(app.store.stats().posts,3);
  assert.equal((await clear({name:'aww',confirm:true})).status,200);assert.equal(app.store.stats().posts,1);assert.deepEqual(app.store.followedSources(),['aww','python']);assert.equal(app.store.getHistoryPreference('aww').months,3);assert.equal(app.store.getHistoryPreference('aww').targetId,null);assert.equal(app.store.getPost('abc'),null);assert.equal(app.store.getPost('def'),null);assert(app.store.getPost('ghi'));
  await assert.rejects(stat(exclusive),{code:'ENOENT'});assert.equal((await stat(shared)).size,3);assert.equal((await app.media.items('ghi'))[0]?.state,'ready');assert.equal(app.media.status.bytes,3);
  const item=(await app.media.items('ghi'))[0]!;assert.equal((await fetch(origin+item.url)).status,200);
 }finally{await app.close();}
});

test('scoped Clear aborts the selected sync without restoring late posts or discarding another queued feed',async()=>{
 let release!:(listing:any)=>void,started=false;const visits:string[]=[];
 const listing=(name:string)=>{const id=name==='aww'?'abc':'def';return{account:'fixture_user',posts:[{id,subreddit:name,title:name+' queued fixture',permalink:`/r/${name}/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'live',observedAt:Date.now(),body:'Complete fixture body',media:['Text']}],ordinary:[],unknownTime:false,omissions:0,next:null,empty:false,signature:id};};
 const app=createReaderServer({database:':memory:',port:0,jobs:{mediaSync:null,browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(url){visits.push(url);return{}as any;}},readListing:async(_page,name)=>{if(name==='aww'){started=true;return new Promise(resolve=>{release=resolve;});}return listing(name)as any;}}});app.store.addSubreddit('aww');app.store.addSubreddit('python');const origin=await app.listen();
 try{
  const {token}=await(await fetch(origin+'/api/state')).json()as any;const post=(path:string,data:unknown)=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token},body:JSON.stringify(data)});
  await post('sync',{});const deadline=Date.now()+3000;while(!started){if(Date.now()>deadline)throw new Error('Fixture did not start');await new Promise(resolve=>setTimeout(resolve,2));}
  assert.equal((await post('clear-source',{name:'aww',confirm:true})).status,200);assert.equal(app.store.getPost('abc'),null);release(listing('aww'));
  while(app.jobs.state.running){if(Date.now()>deadline)throw new Error('Queued feed did not finish');await new Promise(resolve=>setTimeout(resolve,2));}
  assert.equal(app.store.getPost('abc'),null);assert(app.store.getPost('def'));assert.equal(visits.length,2);assert.equal(app.store.feedSources().find(feed=>feed.name==='aww')?.postCount,0);
 }finally{release?.(listing('aww'));await app.close();}
});

test('post deletion requires confirmation and never restores the post through refresh, archive import or Clear',async()=>{
 const {RequestQueue}=await import('../src/request-gate.ts'),{stat}=await import('node:fs/promises');let downloads=0,visits=0;
 const records=['abc','def'].map(id=>({id,subreddit:'python',title:id==='abc'?'Spam fixture':'Keep fixture',body:'Complete fixture body',permalink:`/r/python/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'live' as const,observedAt:Date.now(),media:[id==='abc'?'Image' as const:'Text' as const],attachments:id==='abc'?[{kind:'image' as const,url:'https://i.redd.it/spam-fixture.png'}]:[]}));
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0}),browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(){visits++;return{}as any;}},readListing:async()=>({account:'fixture_user',posts:records,ordinary:[],unknownTime:false,omissions:0,next:null,empty:false,signature:'fixture-abc-def'})},media:{fetch:async()=>{downloads++;return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});}}});
 app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,records.map(row=>({...row,source:'archive',exportId:'delete-api'})));const origin=await app.listen();
 try{
  const {token}=await(await fetch(origin+'/api/state')).json()as any,post=(path:string,data:unknown,auth=true)=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{'X-Reader-Token':token}:{})},body:JSON.stringify(data)});
  await app.media.syncPost('abc','fixture',10,new AbortController().signal);const file=(await app.media.items('abc'))[0]!;
  assert.equal((await post('delete-post',{id:'abc',confirm:true},false)).status,403);assert.equal((await post('delete-post',{id:'abc'})).status,400);assert.equal((await post('delete-post',{id:'zzz',confirm:true})).status,400);assert.equal(app.store.stats().posts,2);
  assert.equal((await post('delete-post',{id:'abc',confirm:true})).status,200);assert.equal(app.store.stats().posts,1);await assert.rejects(stat(file.localPath!),{code:'ENOENT'});assert.equal((await fetch(origin+file.url)).status,404);assert.equal((await(await fetch(origin+'/api/post/abc')).json()as any).post,null);assert.equal((await post('thread',{id:'abc'})).status,400);
  const refresh=async()=>{assert.equal((await post('sync',{})).status,200);const deadline=Date.now()+2000;while(app.jobs.state.running){if(Date.now()>deadline)throw new Error('Fixture refresh did not finish');await new Promise(resolve=>setTimeout(resolve,2));}};
  await refresh();assert.equal(app.store.getPost('abc'),null);assert(app.store.getPost('def'));assert.equal(downloads,1);
  const data=Buffer.from(JSON.stringify({id:'abc',subreddit:'python',title:'Archived spam',created_utc:1700000000,is_self:true,selftext:'Spam'}));const imported=await fetch(origin+`/api/import?subreddit=python&filename=spam.jsonl&size=${data.length}&modified=1`,{method:'POST',headers:{'X-Reader-Token':token},body:data});assert.equal(imported.status,200);assert.equal((await imported.json()as any).filtered,1);assert.equal(app.store.getPost('abc'),null);
  await post('clear-source',{name:'python',confirm:true});await refresh();assert.equal(app.store.getPost('abc'),null);assert(app.store.getPost('def'));assert.equal((await post('delete-post',{id:'abc',confirm:true})).status,200);assert.equal(visits,2);
 }finally{await app.close();}
});

test('deleting an actively read post rejects its late discussion without stopping another queued post',async()=>{
 let release!:(value:any)=>void,started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
 const discussion=(id:string)=>({topLink:null,snapshot:{id:'snapshot-'+id,postId:id,source:'live' as const,capturedAt:null,observedAt:Date.now(),sort:'best',body:'Saved discussion',availability:'available' as const,comments:[],omitted:0,sample:'Fixture'}});
 const app=createReaderServer({database:':memory:',port:0,jobs:{mediaSync:null,browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(){return{}as any;}},readAccount:async()=> 'fixture_user',readThread:async(_page,id)=>{if(id==='t3_abc'){started();return new Promise(resolve=>{release=resolve;});}return discussion(id);}}});app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,['abc','def'].map(id=>({id,subreddit:'python',title:id+' thread fixture',permalink:`/r/python/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'delete-thread',observedAt:Date.now(),body:'Complete fixture body',media:['Text']})));const origin=await app.listen();
 try{
  const {token}=await(await fetch(origin+'/api/state')).json()as any,post=(path:string,data:unknown)=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token},body:JSON.stringify(data)});
  await post('thread',{id:'abc'});await began;await post('thread',{id:'def'});assert.equal((await post('delete-post',{id:'abc',confirm:true})).status,200);release(discussion('t3_abc'));
  const deadline=Date.now()+2000;while(app.jobs.state.running){if(Date.now()>deadline)throw new Error('Other discussion did not finish');await new Promise(resolve=>setTimeout(resolve,2));}
  assert.equal(app.store.getPost('abc'),null);assert.equal(app.store.latestSnapshot('abc'),null);assert(app.store.latestSnapshot('def'));assert.equal(app.jobs.state.accessPause,null);
 }finally{release?.(discussion('t3_abc'));await app.close();}
});

test('expanding a per-feed limit automatically fetches; contraction never fetches or prunes',async()=>{
 const visited:string[]=[];const app=createReaderServer({database:':memory:',port:0,jobs:{browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(url){visited.push(url);return{url:()=>url}as any;}},readListing:async()=>({account:'fixture_user',posts:[{id:'t3_abc',subreddit:'python',title:'History post',permalink:'/r/python/comments/abc/',created:{epochMs:1700000000000,precisionMs:1000},source:'live',observedAt:Date.now(),body:'Complete fixture body',media:['Text']}],ordinary:[],unknownTime:false,omissions:0,next:null,empty:false,signature:'t3_abc'})}});
 app.store.addSubreddit('python');const origin=await app.listen();
 try{
  const {token}=await(await fetch(origin+'/api/state')).json()as{token:string};const update=(months:number,fetchHistory=false)=>fetch(origin+'/api/history',{method:'POST',headers:{'X-Reader-Token':token,'Content-Type':'application/json'},body:JSON.stringify({name:'python',months,fetch:fetchHistory})});
  const settle=async()=>{const deadline=Date.now()+1000;while(app.jobs.state.running){if(Date.now()>deadline)throw new Error('History job did not settle');await new Promise(resolve=>setTimeout(resolve,2));}};
  assert.equal(app.store.getHistoryPreference('python').months,1);assert.equal((await update(3)).status,200);await settle();assert.equal(visited.length,1);assert.equal(app.store.getHistoryPreference('python').months,3);assert.equal(app.store.stats().posts,1);
  assert.equal((await update(1,true)).status,200);await settle();assert.equal(visited.length,1);assert.equal(app.store.stats().posts,1);assert.equal(app.store.getPost('abc')?.title,'History post');
  assert.equal((await update(2)).status,400);assert.equal(app.store.getHistoryPreference('python').months,1);
  assert.equal((await update(0)).status,200);await settle();assert.equal(visited.length,2);assert.equal(app.store.feedSources()[0]?.historyTarget?.completion,'listing-end');
 }finally{await app.close();}
});

test('Refresh saves previously imported media, GET endpoints never download it, and per-post download routes are absent',async()=>{
 const {RequestQueue}=await import('../src/request-gate.ts');let downloads=0;
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0}),browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(){return{}as any;}},readListing:async()=>({account:'fixture_user',posts:[],ordinary:[],unknownTime:false,omissions:0,next:null,empty:true,signature:'empty-head'})},media:{fetch:async()=>{downloads++;return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});}}});
 app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,[{id:'abc',subreddit:'aww',title:'Unvisited imported media',permalink:'/r/aww/comments/abc/',created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'offline-api-fixture',observedAt:Date.now(),media:['Image'],attachments:[{kind:'image',url:'https://i.redd.it/fixture.png'}]}]);
 const origin=await app.listen();
 try{
  const state=await(await fetch(origin+'/api/state')).json();const post=async(path:string,data:unknown={})=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':state.token},body:JSON.stringify(data)});
  await fetch(origin+'/api/feed');const before=await(await fetch(origin+'/api/media/t3_abc')).json();assert.equal(before.sync.status,'pending');assert.equal(downloads,0);
  assert.equal((await post('media',{id:'t3_abc'})).status,404);assert.equal((await post('media/discover',{id:'t3_abc'})).status,404);assert.equal(downloads,0);
  assert.equal((await post('sync',{names:['aww']})).status,200);const deadline=Date.now()+3000;while(app.jobs.state.running){if(Date.now()>deadline)throw new Error('Offline sync did not finish');await new Promise(resolve=>setTimeout(resolve,5));}
  assert.equal(downloads,1);const ready=await(await fetch(origin+'/api/media/t3_abc')).json();assert.equal(ready.sync.status,'ready');assert.equal(ready.items[0].state,'ready');assert.equal((await(await fetch(origin+ready.items[0].url)).arrayBuffer()).byteLength,3);await fetch(origin+'/api/feed');assert.equal(downloads,1);
 }finally{await app.close();}
});

test('storage settings reject invalid caps, preserve content when lowered, and block collection before any website request',async()=>{
 let visits=0;const app=createReaderServer({database:':memory:',port:0,jobs:{browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(){visits++;return {}as any;}},readListing:async()=>({account:'fixture_user',posts:[],ordinary:[],unknownTime:false,omissions:0,next:null,empty:true,signature:'empty-head'})}});
 app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,['abc','def'].map(id=>({id,subreddit:'aww',title:'Stored '+id,body:'x'.repeat(500_000),permalink:`/r/aww/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,exportId:'storage-api',observedAt:Date.now(),media:['Text' as const]})));
 const origin=await app.listen();
 try{
  const state=await(await fetch(origin+'/api/state')).json();assert.equal(state.storage.limitBytes,10_000_000_000);
  const post=(path:string,data:unknown,token=state.token)=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token},body:JSON.stringify(data)});
  assert.equal((await post('settings',{maxStoredBytes:1_000_000},'')).status,403);
  for(const value of [null,0,999999,'1000000'])assert.equal((await post('settings',{maxStoredBytes:value})).status,400);
  assert.equal((await post('settings',{maxStoredBytes:1_000_000})).status,200);const limited=await(await fetch(origin+'/api/state')).json();assert(limited.storage.full);assert(limited.storage.percentUsed>100);assert.equal(limited.stats.posts,2);assert.equal((await post('sync',{names:['aww']})).status,400);assert.equal((await post('sync',{names:['aww']})).status,400);assert.equal(visits,0);
  assert.equal((await post('settings',{maxStoredBytes:2_000_000})).status,200);assert.equal(app.jobs.state.running,false);assert.equal(visits,0);assert.equal((await post('sync',{names:['aww']})).status,200);
  const deadline=Date.now()+3000;while(app.jobs.state.running){if(Date.now()>deadline)throw Error('Storage fixture did not finish');await new Promise(resolve=>setTimeout(resolve,5));}assert(visits>0);assert.equal(app.store.stats().posts,2);
 }finally{await app.close();}
});
