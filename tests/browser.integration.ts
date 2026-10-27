import '../src/browser-path.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { browserLaunchOptions } from '../src/browser-options.ts';
import { readListing, readThread, classifyMedia } from '../src/extract.ts';
import { createReaderServer } from '../src/server.ts';
import type { PostObservation } from '../src/domain.ts';

test('Classic extractor rejects hidden/invalid cards, ignores edit time and retains thread ancestry',async()=>{
  const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
  try{
    const page=await browser.newPage({javaScriptEnabled:false});
    await page.setContent(`<div id="header"><span class="user"><a href="https://old.reddit.com/user/fixture_user/">fixture_user</a></span></div><div class="tabmenu"><span class="selected">new</span></div><div id="siteTable"><div class="thing self" data-fullname="t3_abc" data-subreddit="Python" data-permalink="/r/Python/comments/abc/title/" data-url="https://old.reddit.com/r/python/comments/abc/title/"><div class="entry"><a class="title">A visible title</a><p class="tagline"><time datetime="2026-10-20T10:30:00Z">time</time><time class="edited-timestamp" datetime="2026-10-21T11:30:00Z">edited</time></p></div></div><div class="thing" hidden data-fullname="t3_hidden"><a class="title">Hidden</a></div><div class="thing" data-fullname="t3_bad" data-subreddit="Python"><a class="title">Missing time</a></div></div><span class="next-button"><a href="https://old.reddit.com/r/python/new/?after=t3_abc">next</a></span>`);
    const listing=await readListing(page,'python');assert.equal(listing.posts.length,1);assert.equal(listing.omissions,1);assert.equal(listing.unknownTime,true);assert.equal(listing.posts[0]?.created.epochMs,Date.parse('2026-10-20T10:30:00Z'));assert.deepEqual(listing.posts[0]?.media,['Text']);
    await page.setContent(`<div class="thing" data-fullname="t3_hidden" style="display:none"></div><div class="thing promoted" data-fullname="t3_ad">An unrelated advert</div><div class="thing" data-fullname="t3_abc"><div class="entry"><div class="usertext-body"><div class="md">Original body</div></div></div></div><div class="commentarea"><div class="dropdown lightdrop"><span class="selected">best</span></div><div class="drop-choices" style="display:none"><a href="https://old.reddit.com/r/python/comments/abc/title/?sort=top">top</a></div><div class="sitetable"><div class="thing comment" data-fullname="t1_root"><div class="entry"><div class="usertext"><div class="usertext-body"><div class="md">Root comment</div></div></div></div><div class="child"><div class="thing comment" data-fullname="t1_child"><div class="entry"><div class="usertext"><div class="usertext-body"><div class="md">Reply</div></div></div></div></div></div></div></div></div>`);
    const result=await readThread(page,'abc');assert.equal(result.snapshot.comments.length,2);assert.equal(result.snapshot.comments[0]?.parentId,'t3_abc');assert.equal(result.snapshot.comments[1]?.parentId,'t1_root');assert.equal(result.topLink,null);
    await page.route('https://old.reddit.com/**',route=>route.fulfill({contentType:'text/html',body:'<div class="thing deleted link self"><div class="entry"><a class="title">[ Removed by moderator ]</a><div class="usertext-body"><div class="md">[removed]</div></div></div></div><div class="commentarea"><div class="sitetable"><div class="thing comment" data-fullname="t1_survives"><div class="entry"><div class="usertext"><div class="usertext-body"><div class="md">Surviving discussion</div></div></div></div></div></div></div>'}));
    await page.goto('https://old.reddit.com/r/python/comments/abc/removed_post/');const removed=await readThread(page,'abc');assert.equal(removed.snapshot.availability,'removed');assert.equal(removed.snapshot.body,null);assert.equal(removed.snapshot.comments[0]?.body,'Surviving discussion');assert.equal(removed.snapshot.comments[0]?.parentId,'t3_abc');await assert.rejects(readThread(page,'def'),/layout/);
    assert.deepEqual(classifyMedia({self:false,outbound:'https://i.redd.it/example.jpg',video:false,image:false}),['Image']);
    assert.deepEqual(classifyMedia({self:false,outbound:'https://v.redd.it/example',video:false,image:false}),['Video']);
  }finally{await browser.close();}
});
test('web app supports actual feed filtering, thread drawer, history and streaming file upload without website traffic',async()=>{
  const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');
  const records:PostObservation[]=['Text','Image','Video'].map((media,index)=>({id:'t3_'+['abc','def','ghi'][index],subreddit:'python',title:media+' fixture story',permalink:'/r/python/comments/'+['abc','def','ghi'][index]+'/',created:{epochMs:1700000000000+index*1000,precisionMs:1000},source:'archive',exportId:'fixture',observedAt:1800000000000,body:media==='Text'?'Saved fixture body':'Media caption',media:[media as 'Text'|'Image'|'Video']}));app.store.importArchiveBatch(app.store.generation,records);
  const origin=await app.listen();const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
  try{
    const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(origin);await page.locator('.post-card').first().waitFor();assert.equal(await page.locator('.post-card').count(),3);
    await page.getByRole('button',{name:'Image',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1);assert.equal(await page.locator('.post-card').count(),1);
    assert.equal(await page.locator('.post-preview').innerText(),'Media caption');
    await page.getByRole('button',{name:'Media',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);
    assert.equal(await page.getByRole('button',{name:'Text fixture story',exact:true}).count(),0);assert.equal(await page.locator('.post-preview').count(),0);
    assert.equal(await page.getByRole('button',{name:'Image fixture story',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'Video fixture story',exact:true}).count(),1);
    assert.equal((await fetch(origin+'/api/feed?media=Media')).status,200);assert.equal((await fetch(origin+'/api/feed?media=invalid')).status,400);
    await page.getByRole('button',{name:'All posts',exact:true}).click();await page.getByRole('button',{name:'Text fixture story',exact:true}).waitFor();await page.getByRole('button',{name:'Text fixture story',exact:true}).click();await page.getByRole('dialog',{name:'Thread details'}).waitFor();assert(await page.getByText('Saved fixture body',{exact:true}).count());
    await page.getByRole('button',{name:'Close thread'}).click();await page.getByRole('button',{name:/Import an archive/}).click();await page.getByRole('button',{name:'Import a file',exact:true}).click();
    const file=Buffer.from(JSON.stringify({id:'jkl',subreddit:'python',title:'Uploaded archive story',created_utc:1700000004,is_self:true,selftext:'Local file body'})+'\n');
    await page.locator('input[type=file]').setInputFiles({name:'fixture.jsonl',mimeType:'application/x-ndjson',buffer:file});await page.getByRole('button',{name:'Import file',exact:true}).click();await page.getByText(/Selected file processed/).waitFor();await page.getByRole('button',{name:'Close dialog'}).click();await page.getByRole('button',{name:'Uploaded archive story',exact:true}).waitFor();
    await page.getByRole('button',{name:/Import an archive/}).click();await page.getByRole('button',{name:'Import a file',exact:true}).click();await page.getByLabel('Comment post IDs (optional)',{exact:true}).fill('t3_jkl');await page.locator('input[type=file]').setInputFiles({name:'comments.jsonl',mimeType:'application/x-ndjson',buffer:Buffer.from(JSON.stringify({id:'reply',subreddit:'python',link_id:'t3_jkl',parent_id:'t3_jkl',body:'Imported offline comment',created_utc:1700000005})+'\n')});await page.getByRole('button',{name:'Import file',exact:true}).click();await page.getByText(/Selected file processed/).waitFor();await page.getByRole('button',{name:'Close dialog'}).click();await page.getByRole('button',{name:'Uploaded archive story',exact:true}).click();await page.getByRole('dialog',{name:'Thread details'}).getByText('Imported offline comment',{exact:true}).waitFor();await page.getByRole('button',{name:'Close thread'}).click();
    await page.getByRole('button',{name:/Collection history/}).click();await page.getByRole('dialog',{name:'Collection history',exact:true}).waitFor();await page.getByRole('button',{name:'Close dialog'}).click();
    assert.equal(app.jobs.state.requests.sessionTotal,0);assert.deepEqual(errors,[]);
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:'/private/tmp/reddit-reader-ui.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  }finally{await browser.close();await app.close();}
});

test('feeds page refreshes individually or together, shows progress, stops one feed and confirms removal',async()=>{
  const pending=new Map<string,{resolve:(page:any)=>void;reject:(error:Error)=>void}>();const visited:string[]=[];
  const driver={counts:{intercepted:0,released:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async manualSignIn(){},
    async navigate(url:string){const name=new URL(url).pathname.split('/')[2]!;visited.push(name);return new Promise<any>((resolve,reject)=>pending.set(name,{resolve,reject}));},
    async close(){for(const item of pending.values())item.reject(new Error('Stopped fixture'));pending.clear();}};
  const finish=(name:string)=>{const item=pending.get(name);assert(item);pending.delete(name);item.resolve({url:()=>`https://old.reddit.com/r/${name}/new/`});};
  const app=createReaderServer({database:':memory:',port:0,jobs:{mediaSync:null,browser:driver,readListing:async(_page,name)=>{
    const id=name==='python'?'abc':'def';return{account:'fixture_user',posts:[{id:'t3_'+id,subreddit:name,title:name+' stored fixture',permalink:`/r/${name}/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'live',observedAt:Date.now(),body:'Stored fixture body',media:name==='python'?['Text']:['Image']}],ordinary:[],unknownTime:false,omissions:0,next:null,empty:false,signature:id};
  }}});
  app.store.addSubreddit('python');app.store.addSubreddit('aww');
  const origin=await app.listen();const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
  try{
    const page=await browser.newPage();await page.goto(origin+'/#feeds');const row=(name:string)=>page.locator(`[data-feed="${name}"]`);
    await row('python').waitFor();assert.equal(await page.getByRole('region',{name:'Subscribed feeds',exact:true}).getByText('Never',{exact:true}).count(),2);
    assert.equal(await page.getByText('YOUR REDDIT, AT YOUR PACE').count(),0);assert.equal(await page.getByLabel('From date').count(),0);assert.equal(await page.getByLabel('To date').count(),0);
    const background=await page.evaluate(()=>getComputedStyle(document.documentElement).backgroundColor);assert.equal(background,'rgb(17, 20, 22)');
    await page.getByRole('button',{name:'Sync all',exact:true}).click();await row('aww').getByText('Syncing',{exact:true}).waitFor();await row('python').getByText('Queued',{exact:true}).waitFor();
    await row('python').getByRole('button',{name:'Stop r/python',exact:true}).click();await row('python').getByText('Incomplete',{exact:true}).waitFor();assert.deepEqual(visited,['aww']);
    finish('aww');await row('aww').getByText('Incomplete',{exact:true}).waitFor();assert.equal(await row('aww').getByText('Media 0/1 offline · 1 awaiting sync',{exact:true}).count(),1);assert.equal(await row('aww').getByText('Never',{exact:true}).count(),1);
    await row('python').getByRole('button',{name:'Resume r/python',exact:true}).click();await row('python').getByText('Syncing',{exact:true}).waitFor();const deadline=Date.now()+3000;while(app.jobs.feedStatus('python')!=='idle'){if(Date.now()>deadline)throw new Error('Pending history did not finish');if(pending.has('python'))finish('python');await new Promise(resolve=>setTimeout(resolve,5));}await row('python').getByText('Completed with gaps',{exact:true}).waitFor();
    await row('python').getByRole('button',{name:'Remove r/python',exact:true}).click();await page.getByRole('dialog',{name:'Remove r/python?'}).waitFor();await page.getByRole('button',{name:'Keep feed',exact:true}).click();assert.equal(await row('python').count(),1);
    await row('python').getByRole('button',{name:'Remove r/python',exact:true}).click();await page.getByRole('button',{name:'Remove feed',exact:true}).click();await row('python').waitFor({state:'detached'});assert.deepEqual(app.store.followedSources(),['aww']);assert(app.store.getPost('abc'));
    await page.getByRole('button',{name:'＋ Add feed',exact:true}).click();await page.getByLabel('Subreddit',{exact:true}).fill('cats');await page.getByRole('button',{name:'Add & sync',exact:true}).click();await row('cats').getByText('Syncing',{exact:true}).waitFor();
    await row('cats').getByRole('button',{name:'Stop r/cats',exact:true}).click();await row('cats').getByText('Incomplete',{exact:true}).waitFor();assert.equal(await row('cats').getByText('Never',{exact:true}).count(),1);
    await row('aww').getByRole('button',{name:'r/aww',exact:true}).click();await page.getByRole('button',{name:'aww stored fixture',exact:true}).waitFor();assert.equal(await page.getByLabel('Filter by subreddit').inputValue(),'aww');
    await page.getByLabel('Filter by subreddit').selectOption('');await page.getByRole('button',{name:'Feeds',exact:false}).first().click();
    await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'/private/tmp/reddit-reader-feeds-dark.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);await page.screenshot({path:'/private/tmp/reddit-reader-feeds-mobile.png',fullPage:true});
  }finally{await browser.close();await app.close();}
});

test('local status polling preserves additional loaded pages of stored posts',async()=>{
  const app=createReaderServer({database:':memory:',port:0});app.store.addSubreddit('python');
  app.store.importArchiveBatch(app.store.generation,Array.from({length:75},(_,index)=>({id:'t3_'+(1000+index).toString(36),subreddit:'python',title:'Stored post '+index,permalink:`/r/python/comments/${(1000+index).toString(36)}/`,created:{epochMs:1700000000000+index*1000,precisionMs:1000},source:'archive' as const,exportId:'pagination-fixture',observedAt:1800000000000,media:['Text' as const]})));
  const origin=await app.listen();const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
  try{
    const page=await browser.newPage();await page.goto(origin);await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===50);await page.getByRole('button',{name:'Load more',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===75);
    await page.waitForTimeout(2500);assert.equal(await page.locator('.post-card').count(),75);assert.equal(app.jobs.state.requests.sessionTotal,0);
  }finally{await browser.close();await app.close();}
});

test('per-subreddit Clear has a cancellable confirmation, resets only that feed and keeps its history preference',async()=>{
 const app=createReaderServer({database:':memory:',port:0,jobs:{mediaSync:null}});
 for(const [name,id] of [['aww','abc'],['python','def']]){app.store.addSource({name:name!,historyMonths:name==='aww'?3:1});app.store.importArchiveBatch(app.store.generation,[{id:id!,subreddit:name!,title:name+' clear fixture',permalink:`/r/${name}/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'clear-ui',observedAt:1800000000000,media:['Text']}]);}
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.goto(origin+'/#feeds');const row=page.locator('[data-feed="aww"]');await row.getByRole('button',{name:'Clear data for r/aww',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'Clear all data for r/aww?',exact:true});await dialog.waitFor();await dialog.getByRole('button',{name:'Keep data',exact:true}).click();assert.equal(app.store.stats().posts,2);
  await row.getByRole('button',{name:'Clear data for r/aww',exact:true}).click();dialog=page.getByRole('dialog',{name:'Clear all data for r/aww?',exact:true});await dialog.getByRole('button',{name:'Clear data',exact:true}).click();await dialog.waitFor({state:'detached'});
  await row.getByText('0 posts',{exact:true}).waitFor();assert.equal(await row.getByLabel('History limit for r/aww').inputValue(),'3');assert.equal(app.store.stats().posts,1);assert(app.store.getPost('def'));assert.deepEqual(app.store.followedSources(),['aww','python']);assert.equal(app.jobs.state.requests.sessionTotal,0);
  await page.setViewportSize({width:390,height:844});await row.getByRole('button',{name:'Clear data for r/aww',exact:true}).click();dialog=page.getByRole('dialog',{name:'Clear all data for r/aww?',exact:true});await dialog.waitFor();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await dialog.getByRole('button',{name:'Keep data',exact:true}).click();
 }finally{await browser.close();await app.close();}
});

test('post deletion can be cancelled, works from feed and discussion, and stays excluded after refresh and reload',async()=>{
 const records=['abc','def'].map(id=>({id,subreddit:'python',title:id==='abc'?'Spam deletion fixture':'Keep deletion fixture',permalink:`/r/python/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'live' as const,observedAt:Date.now(),body:'Fixture body',media:['Text' as const]}));
 const app=createReaderServer({database:':memory:',port:0,jobs:{mediaSync:null,browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(){return{}as any;}},readListing:async()=>({account:'fixture_user',posts:records,ordinary:[],unknownTime:false,omissions:0,next:null,empty:false,signature:'deletion-fixture'})}});app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,records.map(row=>({...row,source:'archive',exportId:'delete-ui'})));const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.goto(origin);const trash=()=>page.getByRole('button',{name:'Delete post: Spam deletion fixture',exact:true});
  await trash().click();let dialog=page.getByRole('dialog',{name:'Delete this post?',exact:true});await dialog.getByRole('button',{name:'Keep post',exact:true}).click();assert.equal(app.store.stats().posts,2);
  await trash().click();await dialog.getByRole('button',{name:'Delete post',exact:true}).click();await dialog.waitFor({state:'detached'});await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1);assert.equal(await page.locator('.selection-bar').count(),0);assert.equal(await page.getByRole('button',{name:'Spam deletion fixture',exact:true}).count(),0);
  await page.getByRole('button',{name:'Sync all',exact:true}).click();await page.getByRole('button',{name:'Keep deletion fixture',exact:true}).waitFor();await page.reload();await page.getByRole('button',{name:'Keep deletion fixture',exact:true}).waitFor();assert.equal(await trash().count(),0);assert.equal(await page.locator('.post-card').count(),1);
  await page.getByRole('button',{name:'Keep deletion fixture',exact:true}).click();const thread=page.getByRole('dialog',{name:'Thread details',exact:true});await thread.getByRole('button',{name:'Delete post',exact:true}).click();dialog=page.getByRole('dialog',{name:'Delete this post?',exact:true});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await dialog.getByRole('button',{name:'Delete post',exact:true}).click();await thread.waitFor({state:'detached'});await page.getByRole('heading',{name:'No matching posts',exact:true}).waitFor();assert.equal(app.store.stats().posts,0);assert(app.store.isPostExcluded('abc'));assert(app.store.isPostExcluded('def'));assert.deepEqual(app.store.followedSources(),['python']);assert.equal(app.jobs.state.requests.sessionTotal,0);
 }finally{await browser.close();await app.close();}
});

test('late status polls and feed responses cannot restore an obsolete subreddit filter',async()=>{
 const app=createReaderServer({database:':memory:',port:0});
 for(const [name,id] of [['python','abc'],['aww','def']]){app.store.addSubreddit(name!);app.store.importArchiveBatch(app.store.generation,[{id:id!,subreddit:name!,title:name+' race fixture',permalink:`/r/${name}/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'race',observedAt:1800000000000,media:['Text']}]);}
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 let releasePoll!:()=>void,releaseFeed!:()=>void;
 try{
  const page=await browser.newPage();let stateCalls=0,pollSeenResolve!:()=>void;const pollSeen=new Promise<void>(resolve=>{pollSeenResolve=resolve;}),pollGate=new Promise<void>(resolve=>{releasePoll=resolve;});
  await page.route('**/api/state',async route=>{if(++stateCalls!==2){await route.continue();return;}const response=await route.fetch(),data=await response.json();data.stats.contentRevision++;pollSeenResolve();await pollGate;await route.fulfill({json:data});});
  await page.goto(origin);await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);await pollSeen;
  await page.getByLabel('Filter by subreddit').selectOption('aww');await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===1&&document.querySelector('.post-title')?.textContent==='aww race fixture');
  releasePoll();await page.waitForTimeout(300);assert.equal(await page.locator('.post-title').innerText(),'aww race fixture');assert.equal(await page.getByLabel('Filter by subreddit').inputValue(),'aww');
  let feedSeenResolve!:()=>void;const feedSeen=new Promise<void>(resolve=>{feedSeenResolve=resolve;}),feedGate=new Promise<void>(resolve=>{releaseFeed=resolve;});let hold=true;
  await page.route('**/api/feed?*',async route=>{if(!hold||new URL(route.request().url()).searchParams.get('subreddit')){await route.continue();return;}hold=false;const response=await route.fetch();feedSeenResolve();await feedGate;await route.fulfill({response});});
  await page.getByLabel('Filter by subreddit').selectOption('');await feedSeen;await page.getByLabel('Filter by subreddit').selectOption('aww');
  await page.waitForResponse(response=>response.url().includes('/api/feed?subreddit=aww'));releaseFeed();await page.waitForTimeout(300);
  assert.equal(await page.locator('.post-card').count(),1);assert.equal(await page.locator('.post-title').innerText(),'aww race fixture');
 }finally{releasePoll?.();releaseFeed?.();await browser.close();await app.close();}
});

test('history controls default to one month, expand automatically and contract without pruning',async()=>{
 const pending=new Map<string,{resolve:(page:any)=>void;reject:(error:Error)=>void}>();const visits:string[]=[];
 const app=createReaderServer({database:':memory:',port:0,jobs:{browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async manualSignIn(){},async close(){for(const item of pending.values())item.reject(new Error('History stopped'));pending.clear();},async navigate(url){visits.push(url);return new Promise<any>((resolve,reject)=>pending.set('python',{resolve,reject}));}},readListing:async()=>({account:'fixture_user',posts:[{id:'t3_abc',subreddit:'python',title:'Old collected post',permalink:'/r/python/comments/abc/',created:{epochMs:1600000000000,precisionMs:1000},source:'live',observedAt:Date.now(),body:'Complete fixture body',media:['Text']}],ordinary:[],unknownTime:false,omissions:0,next:null,empty:false,signature:'t3_abc'})}});
 app.store.addSubreddit('python');const origin=await app.listen();const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.goto(origin+'/#feeds');const row=page.locator('[data-feed="python"]');await row.waitFor();const select=row.getByLabel('History limit for r/python');assert.equal(await select.inputValue(),'1');assert.deepEqual(await select.locator('option').allTextContents(),['1 month','3 months','6 months','1 year','2 years','3 years','5 years','All time']);
  await select.selectOption('3');await row.getByText('Syncing',{exact:true}).waitFor();assert.equal(visits.length,1);pending.get('python')!.resolve({});pending.clear();await row.getByText('Completed with gaps',{exact:true}).waitFor();await row.getByText(/Oldest:/).waitFor();assert.equal(app.store.stats().posts,1);
  await select.selectOption('1');await page.waitForFunction(()=>document.querySelector('[aria-label="History limit for r/python"]') instanceof HTMLSelectElement && (document.querySelector('[aria-label="History limit for r/python"]') as HTMLSelectElement).value==='1');assert.equal(visits.length,1);assert.equal(app.store.stats().posts,1);assert.equal(await row.getByText(/Oldest:/).count(),1);
  await select.selectOption('0');await row.getByText('Syncing',{exact:true}).waitFor();assert.equal(visits.length,2);await row.getByRole('button',{name:'Stop r/python',exact:true}).click();await row.getByText('Incomplete',{exact:true}).waitFor();assert.equal(app.store.stats().posts,1);
  await page.screenshot({path:'/private/tmp/reddit-reader-history-controls.png',fullPage:true});await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);await page.screenshot({path:'/private/tmp/reddit-reader-history-mobile.png',fullPage:true});
 }finally{await browser.close();await app.close();}
});

test('inline images and playable video use cached local assets, range responses and no remote browser requests',async()=>{
 const {readFile,stat}=await import('node:fs/promises');const {RequestQueue}=await import('../src/request-gate.ts');
 const video=await readFile(new URL('./fixtures/media.mp4',import.meta.url)),audio=await readFile(new URL('./fixtures/media-audio.mp4',import.meta.url)),manifest=await readFile(new URL('./fixtures/media.mpd',import.meta.url));const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVQAAAAASUVORK5CYII=','base64');let downloads=0,networkTime=0;const mediaStarts:number[]=[],samples=[0,1,0.25,0.75];
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({fromCompletion:true,random:()=>samples.shift()!,clock:{now:()=>networkTime,sleep:async ms=>{networkTime+=ms;}}})},media:{fetch:async url=>{downloads++;mediaStarts.push(networkTime);networkTime+=37;const isAudio=String(url).endsWith('audio.mp4'),isVideo=String(url).endsWith('.mp4'),isManifest=String(url).endsWith('.mpd');return new Response(isManifest?manifest:isAudio?audio:isVideo?video:png,{headers:{'Content-Type':isManifest?'application/dash+xml':isAudio?'audio/mp4':isVideo?'video/mp4':'image/png'}});}}});app.store.addSubreddit('aww');
 app.store.importArchiveBatch(app.store.generation,['Image','Video'].map((kind,index)=>({id:'t3_'+['abc','def'][index],subreddit:'aww',title:kind+' inline fixture',permalink:`/r/aww/comments/${['abc','def'][index]}/`,created:{epochMs:1700000000000+index*1000,precisionMs:1000},source:'archive' as const,exportId:'inline-fixture',observedAt:Date.now(),media:[kind as 'Image'|'Video'],attachments:[{kind:kind==='Image'?'image' as const:'video' as const,url:kind==='Image'?'https://i.redd.it/fixture.png':'https://v.redd.it/fixture/DASHPlaylist.mpd'}]})));
 const origin=await app.listen();const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage(),remote:string[]=[];await page.route('**/*',route=>{if(!route.request().url().startsWith(origin))remote.push(route.request().url());return route.continue();});
  await page.goto(origin);await page.getByText('Not downloaded',{exact:true}).first().waitFor();await page.getByText('Awaiting sync · Sync this feed to save it offline',{exact:true}).first().waitFor();assert.equal(downloads,0);assert.equal(await page.getByRole('button',{name:'Load media',exact:true}).count(),0);app.jobs.syncMedia(['aww'],{});await page.waitForFunction(()=>{const image=document.querySelector('.post-media img') as HTMLImageElement|null;const video=document.querySelector('.post-media video') as HTMLVideoElement|null;return image?.naturalWidth===1&&video!==null&&video.readyState>=2;});
  assert.equal(await page.getByText('Not downloaded',{exact:true}).count(),0);
  assert.equal(downloads,4);assert.deepEqual(mediaStarts.slice(1).map((time,index)=>time-mediaStarts[index]!-37),[4000,6000,4500],'Image/manifest/video/audio gaps must be independently randomized after completion');assert.equal(samples.length,0);assert.deepEqual(remote,[]);await page.locator('video').evaluate(async(video:HTMLVideoElement)=>{video.muted=true;await video.play();});await page.waitForFunction(()=>(document.querySelector('video') as HTMLVideoElement).currentTime>0);await page.locator('video').evaluate((video:HTMLVideoElement)=>video.pause());
  for(const [id,title] of [['t3_abc','Image inline fixture'],['t3_def','Video inline fixture']]){const file=(await app.media.items(id!))[0]!;assert(file.localPath);assert((await stat(file.localPath)).isFile());const card=page.locator('.post-card').filter({has:page.getByRole('button',{name:title!,exact:true})});const copy=card.locator('.badges').getByRole('button',{name:'Copy local path',exact:true});await copy.waitFor();assert.equal(await copy.getAttribute('title'),file.localPath);assert.equal(await card.locator('details').count(),0);await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin});await copy.click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),file.localPath);}
  assert.equal(await page.locator('.sidebar').getByText('Session requests',{exact:true}).count(),1);assert.equal(await page.locator('main footer').count(),0);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);await page.setViewportSize({width:1280,height:720});
  const videoUrl=await page.locator('video').getAttribute('src');assert(videoUrl?.startsWith('/media/t3_def/'));const range=await fetch(origin+videoUrl,{headers:{Range:'bytes=0-15'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,16);assert.match(range.headers.get('content-range')??'',/^bytes 0-15\//);
  assert.equal((await fetch(origin+videoUrl,{headers:{Range:'bytes=999999-'}})).status,416);
  await page.getByRole('button',{name:'Image inline fixture',exact:true}).click();await page.getByRole('dialog',{name:'Thread details'}).locator('img').waitFor();assert.equal(downloads,4);assert.equal(await page.getByText(/Media content is not downloaded/).count(),0);assert.equal(await page.getByRole('button',{name:'Load media',exact:true}).count(),0);await page.getByRole('button',{name:'Close thread'}).click();await page.reload();await page.locator('img').waitFor();assert.equal(downloads,4);
  app.store.removeSubreddit('aww');assert.equal((await fetch(origin+videoUrl)).status,200);
  app.store.clearSubreddit('aww');await app.media.reconcile();assert.equal((await fetch(origin+videoUrl)).status,404);
 }finally{await browser.close();await app.close();}
});

test('expanded media discovery binds DASH manifests, rejects unsupported media and keeps incomplete discovery retryable',async t=>{
 const {discoverMedia}=await import('../src/media-discovery.ts');const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 const {UnsupportedMediaError}=await import('../src/sync-errors.ts');
 try{
  const page=await browser.newPage();await page.route('https://**/*',route=>route.abort());
  await page.setContent(`<div class="thing" data-fullname="t3_abc" data-url="https://v.redd.it/boundmedia"><button class="expando-button collapsed" onclick="this.className='expando-button expanded';this.nextElementSibling.style.display='block'">Expand video</button><div class="expando" style="display:none"><video src="blob:https://old.reddit.com/fixture"></video><video src="https://v.redd.it/boundmedia/CMAF_96.mp4"></video><img hidden src="https://i.redd.it/hidden.jpeg"></div></div>`);
  const video=await discoverMedia(page,'t3_abc',()=>['https://v.redd.it/unrelated/CMAF_720.mp4','https://v.redd.it/boundmedia/CMAF_720.mp4','https://v.redd.it/boundmedia/CMAF_96.mp4','https://v.redd.it/boundmedia/DASHPlaylist.mpd'],new AbortController().signal);
  assert.deepEqual(video,[{kind:'video',url:'https://v.redd.it/boundmedia/DASHPlaylist.mpd'}]);
  await page.setContent('<div class="thing" data-fullname="t3_abc" data-url="https://www.youtube.com/watch?v=fixture">Video</div>');
  await assert.rejects(discoverMedia(page,'abc',()=>[],new AbortController().signal),UnsupportedMediaError);
  await page.setContent('<div class="thing" data-fullname="t3_abc">Video</div>');
  await assert.rejects(discoverMedia(page,'abc',()=>[],new AbortController().signal),error=>error instanceof Error&&!(error instanceof UnsupportedMediaError)&&/retry/.test(error.message));
  await page.setContent('<div class="thing" data-fullname="t3_abc" data-url="https://v.redd.it/boundmedia">Video</div>');
  const now=Date.now;let elapsed=false;const clock=t.mock.method(Date,'now',()=>now()+(elapsed?45_001:0));
  try{await assert.rejects(discoverMedia(page,'abc',()=>{elapsed=true;return [];},new AbortController().signal),error=>error instanceof Error&&!(error instanceof UnsupportedMediaError)&&/timeout/.test(error.message));}
  finally{clock.mock.restore();}
 }finally{await browser.close();}
});

test('All subreddits replaces Posts, and Settings saves a non-destructive storage cap with sidebar percentage',async()=>{
 const app=createReaderServer({database:':memory:',port:0});for(const name of ['aww','python'])app.store.addSubreddit(name);
 app.store.importArchiveBatch(app.store.generation,['aww','python'].map((name,index)=>({id:index?'def':'abc',subreddit:name,title:name+' storage fixture',body:'x'.repeat(500_000),permalink:`/r/${name}/comments/${index?'def':'abc'}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,exportId:'storage-ui',observedAt:Date.now(),media:['Text' as const]})));
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.goto(origin+'/#feeds');const sidebar=page.locator('.sidebar');await sidebar.getByRole('button',{name:'All subreddits 2',exact:true}).waitFor();assert.equal(await sidebar.getByRole('button',{name:/^Posts\b/}).count(),0);
  await sidebar.getByRole('button',{name:'All subreddits 2',exact:true}).click();await page.getByRole('heading',{name:'All subreddits',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===2);
  await sidebar.getByRole('button',{name:'r/python 1',exact:true}).click();await page.getByRole('heading',{name:'r/python',exact:true}).waitFor();await sidebar.getByRole('button',{name:'All subreddits 2',exact:true}).click();assert.equal(await page.getByLabel('Filter by subreddit').inputValue(),'');
  await sidebar.getByRole('button',{name:'Settings',exact:true}).click();let dialog=page.getByRole('dialog',{name:'Settings',exact:true});const input=()=>dialog.getByLabel('Max stored size (GB)',{exact:true});assert.equal(await input().inputValue(),'10');await input().fill('0.001');await dialog.getByRole('button',{name:'Save cap',exact:true}).click();await dialog.getByRole('status').getByText('Saved',{exact:true}).waitFor();assert(app.store.storage.full);assert.match(await sidebar.locator('.storage-stat').innerText(),/\d+\.\d+% used/);assert((await sidebar.locator('.storage-stat').innerText()).includes('1.0 MB'));assert.equal(app.store.stats().posts,2);
  await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await page.getByText('Storage cap reached. Existing content is kept; increase the cap to continue collecting.',{exact:true}).waitFor();await sidebar.getByRole('button',{name:'Settings',exact:true}).click();dialog=page.getByRole('dialog',{name:'Settings',exact:true});assert.equal(await input().inputValue(),'0.001');await input().fill('0.02');await dialog.getByRole('button',{name:'Save cap',exact:true}).click();await dialog.getByText('Saved',{exact:true}).waitFor();assert.equal(app.store.storage.full,false);assert.equal(app.jobs.state.requests.sessionTotal,0);await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();await page.reload();await sidebar.getByRole('button',{name:'Settings',exact:true}).click();dialog=page.getByRole('dialog',{name:'Settings',exact:true});assert.equal(await input().inputValue(),'0.02');await dialog.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false,JSON.stringify(await page.evaluate(()=>Array.from(document.querySelectorAll('body *')).filter(el=>el.getBoundingClientRect().right>innerWidth).map(el=>({tag:el.tagName,class:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right,text:el.textContent?.slice(0,80)})).slice(0,15))));await sidebar.getByRole('button',{name:'All subreddits 2',exact:true}).waitFor({state:'visible'});assert.equal(app.store.stats().posts,2);
 }finally{await browser.close();await app.close();}
});

test('offline reader has no selection or summary controls; discussions still work and Clear reports compaction warnings',async()=>{
 const app=createReaderServer({database:':memory:',port:0,jobs:{browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(url){return{url:()=>url}as any;}},readAccount:async()=> 'fixture_user',readThread:async()=>({topLink:null,attachments:[],snapshot:{id:'reader-snapshot',postId:'t3_abc',source:'live',observedAt:Date.now(),capturedAt:null,sort:'best',body:'Saved discussion body',availability:'available',comments:[{id:'t1_comment',postId:'t3_abc',parentId:'t3_abc',ancestry:'known',body:'A saved fixture comment',availability:'available',createdMs:1700000001000}],omitted:2,sample:'One visible fixture comment'}})}});
 app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,[{id:'abc',subreddit:'python',title:'Offline UI fixture',permalink:'/r/python/comments/abc/',created:{epochMs:1700000000000,precisionMs:1000},source:'archive',exportId:'reader-ui',observedAt:Date.now(),body:'Complete fixture body',media:['Text']}]);
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  app.store.pauseSource('python','Previous discussion failed');
  const page=await browser.newPage();await page.goto(origin);await page.getByRole('button',{name:'Offline UI fixture',exact:true}).click();
  let dialog=page.getByRole('dialog',{name:'Thread details',exact:true});await dialog.getByRole('button',{name:'Read discussion in browser',exact:true}).click();await dialog.getByText('A saved fixture comment',{exact:true}).waitFor();assert.equal(app.store.latestSnapshot('abc')?.comments.length,1);assert.equal(app.store.feedSources()[0]?.sync.reason,null);
  assert.equal(await page.getByRole('checkbox').count(),0);assert.equal(await page.getByRole('button',{name:/Summari[sz]e/}).count(),0);assert.equal(await page.locator('.selection-bar').count(),0);await dialog.getByRole('button',{name:'Close thread',exact:true}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();assert.equal(await page.getByText(/Summaries:/).count(),0);await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  const db=(app.store as any).db,exec=db.exec.bind(db);db.exec=(sql:string)=>{if(sql.includes('VACUUM'))throw new Error('Fixture compaction failure');return exec(sql);};
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Clear collected content',exact:true}).click();await page.getByRole('dialog',{name:'Clear content?',exact:true}).getByRole('button',{name:'Clear content',exact:true}).click();
  await page.getByText('Content cleared. Database compaction failed; some allocated space may remain in use.',{exact:true}).waitFor();assert.equal(app.store.stats().posts,0);assert.deepEqual(app.store.followedSources(),['python']);
 }finally{await browser.close();await app.close();}
});
