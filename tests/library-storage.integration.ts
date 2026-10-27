import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';
import {RequestQueue} from '../src/request-gate.ts';

const record=(id:string,subreddit='aww',url='https://i.redd.it/shared.png')=>({id,subreddit,title:'Cleanup '+id,body:'Offline fixture',permalink:`/r/${subreddit}/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,exportId:'storage-ui',observedAt:1800000000000,media:['Image' as const],attachments:[{kind:'image' as const,url}]});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVQAAAAASUVORK5CYII=','base64');
async function settled(app:ReturnType<typeof createReaderServer>){const until=Date.now()+5000;while(app.jobs.state.running){if(Date.now()>until)throw new Error('Storage fixture did not settle');await delay(2);}}

test('storage UI previews and cancels deletion, keeps shared media and permanently excludes confirmed posts',async()=>{
 let requests=0;const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async()=>{requests++;return new Response(png,{headers:{'Content-Type':'image/png'}});}}});app.store.addSubreddit('aww');app.store.addSubreddit('python');const rows=[record('aaa'),record('bbb','python'),record('ccc','aww','https://i.redd.it/only.png')];app.store.importArchiveBatch(app.store.generation,rows);app.store.setRead('aaa',true);app.store.setRead('ccc',true);
 const origin=await app.listen();app.jobs.syncMedia(['aww','python'],{resume:true});await settled(app);const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.addInitScript(()=>Object.defineProperty(document,'visibilityState',{get:()=> 'hidden'}));await page.goto(origin);await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Manage storage',exact:true}).click();
  await page.locator('.storage-table').waitFor();assert.equal(await page.getByLabel('Read posts only',{exact:true}).isChecked(),true);await page.getByLabel('Cleanup feed',{exact:true}).selectOption('aww');await page.getByLabel('Cleanup post type',{exact:true}).selectOption('Image');await page.getByLabel('Before date (UTC, optional)',{exact:true}).fill('2024-01-01');
  await page.getByRole('button',{name:'Preview deletion',exact:true}).click();await page.getByRole('group',{name:'Confirm selective deletion'}).waitFor();assert.equal(app.store.stats().posts,3);assert.equal(await page.getByRole('button',{name:'Delete 2 posts',exact:true}).count(),1);
  await page.getByRole('button',{name:'Keep posts',exact:true}).click();await page.getByRole('group',{name:'Confirm selective deletion'}).waitFor({state:'detached'});assert.equal(app.store.stats().posts,3);
  await page.getByRole('button',{name:'Preview deletion',exact:true}).click();await page.getByRole('button',{name:'Delete 2 posts',exact:true}).click();await page.getByText(/^2 posts deleted/).waitFor();assert.equal(app.store.stats().posts,1);assert.equal((await app.media.items('bbb'))[0]!.state,'ready');assert(app.store.isPostExcluded('aaa'));assert(app.store.isPostExcluded('ccc'));app.store.importArchiveBatch(app.store.generation,rows);assert.equal(app.store.stats().posts,1);assert.equal(requests,2);
  await page.getByRole('button',{name:'Reclaim freed space',exact:true}).click();await page.getByText('Freed database space and unassigned cache files reclaimed. Posts kept.',{exact:true}).waitFor();assert.equal(app.store.stats().posts,1);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 }finally{await browser.close();await app.close();}
});

test('preview aborts downloads; confirmation and fresh contents are required, and compaction warnings do not block file cleanup',async()=>{
 let requests=0,aborts=0;const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async(_url,options)=>{requests++;if(String(_url).includes('fast.png'))return new Response(png,{headers:{'Content-Type':'image/png'}});return new Promise<Response>((_resolve,reject)=>options?.signal?.addEventListener('abort',()=>{aborts++;reject(new Error('Stopped fixture download'));},{once:true}));}}});app.store.addSubreddit('aww');app.store.importArchiveBatch(app.store.generation,[record('aaa'),record('bbb','aww','https://i.redd.it/fast.png')]);app.store.setRead('aaa',true);app.store.setRead('bbb',true);const origin=await app.listen();
 try{
  const token=(await(await fetch(origin+'/api/state')).json()).token;
  const post=async(path:string,data:unknown)=>{const response=await fetch(origin+'/api/storage/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token},body:JSON.stringify(data)});return{status:response.status,data:await response.json()};};
  app.jobs.syncMedia(['aww'],{resume:true});while(requests<2)await delay(2);assert.equal((await post('preview',{feed:'notstored'})).status,400);assert.equal(aborts,0);
  const preview=await post('preview',{readOnly:true});assert.equal(preview.status,200);assert.equal(preview.data.files,1);assert.equal(aborts,1);assert.equal(app.jobs.state.running,false);assert.equal(app.store.mediaSync('aaa')!.status,'pending');assert.equal((await post('delete',{id:preview.data.id})).status,400);
  app.store.setRead('aaa',false);assert.equal((await post('delete',{id:preview.data.id,confirm:true})).status,400);assert(app.store.getPost('aaa'));
  app.store.setRead('aaa',true);const fresh=await post('preview',{readOnly:true});const db=(app.store as any).db,exec=db.exec.bind(db);db.exec=(sql:string)=>{if(sql.includes('VACUUM'))throw new Error('Fixture compaction failure');return exec(sql);};
  const deleted=await post('delete',{id:fresh.data.id,confirm:true});assert.equal(deleted.status,200);assert.match(deleted.data.warning,/compaction failed/);assert.equal(app.store.getPost('aaa'),null);assert.equal(app.store.isPostExcluded('aaa'),true);assert.equal(app.media.status.pending,0);assert.equal(app.media.status.bytes,0);assert.equal((await app.media.inventory()).length,0);assert.equal(requests,2);db.exec=exec;
 }finally{await app.close();}
});
