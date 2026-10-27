import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';

test('production age password encryption uses work factor 18 and validates a real export',async()=>{
 const app=createReaderServer({database:':memory:',port:0});await app.listen();
 try{
  const backup=await app.backups.create('production fixture password'),path=app.backups.download(backup.id).path;
  assert.match((await readFile(path)).subarray(0,256).toString('ascii'),/-> scrypt [A-Za-z0-9+/]+ 18\n/);
  assert.equal((await app.backups.prepare(createReadStream(path),'production fixture password')).posts,0);
 }finally{await app.close();}
});

test('Settings creates a downloadable encrypted backup and validates before confirmed replacement',async()=>{
 const app=createReaderServer({database:':memory:',port:0,backup:{workFactor:10}}),directory=await mkdtemp(join(tmpdir(),'collector-backup-ui-'));
 const post=(id:string)=>({id,subreddit:'python',title:'Backup '+id,body:'Offline content',permalink:`/r/python/comments/${id}/`,created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,exportId:'backup-ui',observedAt:1800000000000,media:['Text' as const]});
 app.store.addSubreddit('python');app.store.importArchiveBatch(app.store.generation,[post('abc'),post('spam')]);app.store.setRead('abc',true);app.store.deletePost('spam');
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());await page.goto(origin);
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByLabel('Backup passphrase',{exact:true}).fill('backup fixture password');await page.getByLabel('Repeat passphrase',{exact:true}).fill('backup fixture password');
  await page.getByRole('button',{name:'Create encrypted backup',exact:true}).click();const link=page.getByRole('link',{name:'Download backup',exact:true});await link.waitFor();
  const event=page.waitForEvent('download');await link.click();const download=await event,path=join(directory,'collector.tar.age');await download.saveAs(path);
  app.store.importArchiveBatch(app.store.generation,[post('later')]);
  await page.getByLabel('Encrypted backup file',{exact:true}).setInputFiles(path);await page.getByLabel('Restore passphrase',{exact:true}).fill('wrong password');await page.getByRole('button',{name:'Validate backup',exact:true}).click();await page.getByText('Could not decrypt this backup. Check the passphrase and file integrity.',{exact:true}).waitFor();assert(app.store.getPost('later'));
  await page.getByLabel('Restore passphrase',{exact:true}).fill('backup fixture password');await page.getByRole('button',{name:'Validate backup',exact:true}).click();await page.getByRole('group',{name:'Confirm library replacement'}).waitFor();assert(app.store.getPost('later'));
  await page.getByRole('button',{name:'Keep current library',exact:true}).click();await page.getByRole('group',{name:'Confirm library replacement'}).waitFor({state:'detached'});assert(app.store.getPost('later'));
  await page.getByLabel('Restore passphrase',{exact:true}).fill('backup fixture password');await page.getByRole('button',{name:'Validate backup',exact:true}).click();await page.getByRole('group',{name:'Confirm library replacement'}).waitFor();
  const reload=app.media.reload.bind(app.media);let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
  app.media.reload=async()=>{entered();await waiting;await reload();};
  await page.getByRole('button',{name:'Replace library',exact:true}).click();await started;
  let readCompleted=false;const reading=fetch(origin+'/api/storage').then(async response=>{readCompleted=true;assert.equal(response.status,200);return response.json();});
  try{await delay(50);assert.equal(readCompleted,false,'Reads must wait until both the restored database and media are ready');}finally{release();}
  assert.equal((await reading).feeds[0].posts,1);app.media.reload=reload;
  await page.getByText('Library restored. Sync explicitly when ready; the current browser account will be verified.',{exact:true}).waitFor();
  assert.equal(app.store.getPost('later'),null);assert.notEqual(app.store.getPost('abc')!.readAt,null);assert(app.store.isPostExcluded('spam'));assert.equal(app.jobs.state.running,false);assert.equal(app.media.status.requests,0);
  const denied=await fetch(origin+'/api/restore/commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({confirm:true})});assert.equal(denied.status,403);
 }finally{await browser.close();await app.close();await rm(directory,{recursive:true,force:true});}
});
