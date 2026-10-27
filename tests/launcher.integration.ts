import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {launchCollector} from '../src/launcher.ts';
import {readInstance} from '../src/instance.ts';
import {createReaderServer} from '../src/server.ts';

const root=resolve(import.meta.dirname,'..');
const local={build:async()=>{},openBrowser:async(_origin:string)=>{}};
async function waitFor(condition:()=>boolean|Promise<boolean>){const end=Date.now()+10_000;while(!await condition()){if(Date.now()>end)throw new Error('Launcher did not settle');await new Promise(resolve=>setTimeout(resolve,20));}}

test('launch reuses one library, isolates clones, falls back from a busy default and releases leases on Quit/relaunch',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'collector launch with spaces '));const opens:string[]=[];
 const occupied=createServer((_req,res)=>res.end('another service'));occupied.listen(0,'127.0.0.1');await once(occupied,'listening');const port=(occupied.address()as {port:number}).port;
 let first:Awaited<ReturnType<typeof launchCollector>>|undefined,second:typeof first;
 try{
  first=await launchCollector({...local,directory:join(directory,'first'),port,fallback:true,openBrowser:async url=>{opens.push(url);}});assert.equal(first.reused,false);assert.notEqual(Number(new URL(first.origin).port),port);
  const initial=await(await fetch(first.origin+'/api/state')).json();assert(initial.canQuit);assert.equal(initial.job.requests.sessionTotal,0);assert.equal(initial.job.running,false);
  const reused=await launchCollector({...local,directory:join(directory,'first'),openBrowser:async url=>{opens.push(url);}});assert(reused.reused);assert.equal(reused.origin,first.origin);assert.deepEqual(opens,[first.origin,first.origin]);
  const otherRoot=join(directory,'other checkout');await mkdir(otherRoot);await assert.rejects(launchCollector({...local,directory:join(directory,'first'),root:otherRoot}),/another checkout/);
  await assert.rejects(launchCollector({...local,directory:join(directory,'conflict'),port}),{code:'EADDRINUSE'});assert.equal(readInstance(join(directory,'conflict','reader.sqlite')),null);
  second=await launchCollector({...local,directory:join(directory,'second'),port:0});assert.notEqual(first.origin,second.origin);
  const appOrigin=first.origin;const wrong=await fetch(appOrigin+'/api/shutdown',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});assert.equal(wrong.status,403);
  const quit=await fetch(appOrigin+'/api/shutdown',{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':initial.token},body:'{}'});assert.equal(quit.status,200);await first.closed;assert.equal(readInstance(join(directory,'first','reader.sqlite')),null);
  first=await launchCollector({...local,directory:join(directory,'first'),port:0});const reopened=await(await fetch(first.origin+'/api/state')).json();assert.equal(reopened.job.requests.sessionTotal,0);assert.equal(reopened.job.running,false);
  await assert.rejects(launchCollector({...local,directory:join(directory,'build failure'),build:async()=>{throw new Error('Injected build failure');}}),/Injected build failure/);assert.equal(readInstance(join(directory,'build failure','reader.sqlite')),null);
 }finally{await first?.stop();await second?.stop();occupied.closeAllConnections();await new Promise<void>(resolve=>occupied.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});

test('Settings Quit stops the actual UI cleanly; a restore recovery block still allows shutdown',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'collector-quit-')),app=await launchCollector({...local,directory,port:0});
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(app.origin);await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('button',{name:'Quit app',exact:true}).click();await page.getByRole('heading',{name:'Collector stopped'}).waitFor();await app.closed;await page.waitForTimeout(2200);assert.deepEqual(errors,[]);assert.equal(await page.getByText('Failed to fetch',{exact:true}).count(),0);
  let blocked!:ReturnType<typeof createReaderServer>;blocked=createReaderServer({database:join(directory,'reader.sqlite'),port:0,onShutdown:()=>blocked.close()});const origin=await blocked.listen();
  try{const {token}=await(await fetch(origin+'/api/state')).json();blocked.backups.recoveryRequired=true;assert.equal((await fetch(origin+'/api/state')).status,400);const response=await fetch(origin+'/api/shutdown',{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':token},body:'{}'});assert.equal(response.status,200);await waitFor(()=>readInstance(join(directory,'reader.sqlite'))===null);}finally{await blocked.close();}
 }finally{await browser.close();await app.stop();await rm(directory,{recursive:true,force:true});}
});

test('a database held by a legacy process without a lease is refused', {skip:process.platform!=='darwin'},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'collector-legacy-')),database=join(directory,'reader.sqlite');
 const earlier=createReaderServer({database,port:0});await earlier.close();
 const child=spawn(process.execPath,['-e','const fs=require("node:fs");const fd=fs.openSync(process.argv[1],"r+");console.log("ready");setInterval(()=>{},1000);',database],{stdio:['ignore','pipe','pipe']});
 try{await once(child.stdout!,'data');assert.throws(()=>createReaderServer({database,port:0}),/already open by another process/);assert.equal(readInstance(database),null);}finally{child.kill();await once(child,'exit');await rm(directory,{recursive:true,force:true});}
});


test('an OS lock excludes other processes and a crash releases it without manual lock removal',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'collector-crash-')),database=join(directory,'reader.sqlite');
 const child=spawn(process.execPath,['--input-type=module','-e',`import {claimInstance} from ${JSON.stringify(new URL('../src/instance.ts',import.meta.url).href)};claimInstance(process.argv[1],process.argv[2]);console.log('ready');setInterval(()=>{},1000);`,database,root],{stdio:['ignore','pipe','pipe']});
 try{await once(child.stdout!,'data');assert.throws(()=>createReaderServer({database,port:0}),/already open/);child.kill('SIGKILL');await once(child,'exit');assert(readInstance(database),'The crashed process leaves its discovery record');const app=await launchCollector({...local,directory,port:0});try{assert.equal(app.reused,false);assert.equal(readInstance(database)?.pid,process.pid);}finally{await app.stop();}}finally{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}await rm(directory,{recursive:true,force:true});}
});
