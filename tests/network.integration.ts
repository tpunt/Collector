import '../src/browser-path.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChromiumRequestGate, chromiumControlUrl,RequestQueue } from '../src/request-gate.ts';
import { chromium } from 'playwright';
import { browserLaunchOptions } from '../src/browser-options.ts';

test('independent source lanes reach local HTTP concurrently while documents and CSS stay paced within each source', {timeout:30000},async()=>{
 const hits:{path:string;at:number}[]=[],failures:string[]=[];let began!:()=>void,redditEnded=0;
 const redditBegan=new Promise<void>(resolve=>{began=resolve;}),server=createServer(async(req,res)=>{
  const path=req.url!;hits.push({path,at:performance.now()});res.setHeader('Content-Type',path.endsWith('.css')?'text/css':'text/html');
  if(path==='/reddit/post'){began();await new Promise(resolve=>setTimeout(resolve,500));redditEnded=performance.now();}
  res.end(path.endsWith('.css')?'body{color:black}':`<link rel="stylesheet" href="${path.replace('/post','/style.css')}"><main>Local source fixture</main>`);
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${(server.address()as any).port}`,directory=await mkdtemp(join(tmpdir(),'collector-source-pacing-')),queue=new RequestQueue({intervalMs:100,fromCompletion:true});
 const contexts:Awaited<ReturnType<typeof chromium.launchPersistentContext>>[]=[],gates:ChromiumRequestGate[]=[];
 try{
  for(const source of ['reddit','tumblr']){const profile=join(directory,source),context=await chromium.launchPersistentContext(profile,{...browserLaunchOptions,channel:'chrome',headless:true});contexts.push(context);gates.push(await ChromiumRequestGate.install(await chromiumControlUrl(profile),{queue,source,allowResource:url=>url.startsWith(origin+'/'),blockedResourceTypes:['Image','Media','Font','Script','XHR','Fetch','Ping','Other'],onFailure:(_reason,code)=>failures.push(code)}));}
  const reddit=contexts[0]!.pages()[0]!.goto(origin+'/reddit/post');await redditBegan;await contexts[1]!.pages()[0]!.goto(origin+'/tumblr/post');await reddit;
  const at=(path:string)=>hits.find(hit=>hit.path===path)!.at;assert(at('/tumblr/post')<redditEnded,'Tumblr waited for an unrelated Reddit response');assert(at('/reddit/style.css')-redditEnded>=80);assert(at('/tumblr/style.css')-at('/tumblr/post')>=80);assert.deepEqual(failures,[]);assert.equal(queue.released,4);
 }finally{gates.forEach(gate=>gate.stop());await Promise.all(contexts.map(context=>context.close()));gates.forEach(gate=>gate.disposeAfterBrowserClose());await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});

test('manual sign-in resources load concurrently, preserve scripted form submission and still block requests in Offline mode',async()=>{
 const hits:{path:string;time:number;method:string}[]=[],failures:string[]=[];let submitted='';
 const server=createServer(async(req,res)=>{
  const path=req.url!;hits.push({path,time:performance.now(),method:req.method!});
  if(path==='/login'&&req.method==='GET'){res.setHeader('Content-Type','text/html');res.end('<link rel="stylesheet" href="/one.css"><link rel="stylesheet" href="/two.css"><form method="post" action="/login"><input name="username" aria-label="Username"><button>Log in</button></form><script src="/client.js"></script>');}
  else if(path==='/client.js'){res.setHeader('Content-Type','text/javascript');res.end("const form=document.querySelector('form');form.addEventListener('submit',async event=>{event.preventDefault();await fetch('/session',{method:'POST',body:new URLSearchParams(new FormData(form))});document.body.append(Object.assign(document.createElement('p'),{textContent:'Session confirmed'}));});form.dataset.ready='true';");}
  else if(path==='/one.css'||path==='/two.css'){await new Promise(resolve=>setTimeout(resolve,150));res.setHeader('Content-Type','text/css');res.end('body{color:black}');}
  else if(path==='/session'){for await(const chunk of req)submitted+=chunk;res.end('ok');}
  else if(path==='/redirect-offline'){queue.setOffline(true);res.writeHead(302,{location:'/must-not-follow'}).end();}
  else res.end('ok');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const directory=await mkdtemp(join(tmpdir(),'collector-normal-sign-in-')),context=await chromium.launchPersistentContext(directory,{...browserLaunchOptions,channel:'chrome',headless:true}),queue=new RequestQueue({intervalMs:5000});let gate:ChromiumRequestGate|undefined;
 try{
  gate=await ChromiumRequestGate.install(await chromiumControlUrl(directory),{queue,paceRequests:false,maxRequests:1000,onFailure:(_reason,code)=>failures.push(code)});
  const page=context.pages()[0]!;await page.goto(`http://127.0.0.1:${(server.address()as any).port}/login`);await page.locator('form[data-ready="true"]').waitFor();
  await page.getByLabel('Username').fill('fixture_user');await page.getByRole('button',{name:'Log in',exact:true}).click();await page.getByText('Session confirmed',{exact:true}).waitFor();
  assert.equal(submitted,'username=fixture_user');assert(!hits.some(hit=>hit.path==='/login'&&hit.method==='POST'));assert.equal(gate.counts.intervalMs,0);assert.equal(queue.intervalMs,5000);assert.equal(queue.released,0);
  const resources=hits.filter(hit=>['/one.css','/two.css','/client.js'].includes(hit.path));assert.equal(resources.length,3);assert(Math.max(...resources.map(hit=>hit.time))-Math.min(...resources.map(hit=>hit.time))<1000,'Manual resources were serialized behind the collection delay');
  await page.evaluate(async()=>{await fetch('/redirect-offline').catch(()=>{});});assert(!hits.some(hit=>hit.path==='/must-not-follow'));
  queue.setOffline(true);await page.evaluate(async()=>{await fetch('/must-not-send').catch(()=>{});});assert(!hits.some(hit=>hit.path==='/must-not-send'));assert.deepEqual(failures,[]);
 }finally{gate?.stop();await context.close();gate?.disposeAfterBrowserClose();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});

test('concurrent manual resources cannot exceed the sign-in request safety budget',async()=>{
 const hits:string[]=[];let budget=0;
 const server=createServer((req,res)=>{hits.push(req.url!);res.setHeader('Content-Type','text/html');res.end(req.url==='/page'?Array.from({length:12},(_,i)=>`<img src="/image-${i}">`).join(''):'ok');});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const directory=await mkdtemp(join(tmpdir(),'collector-manual-budget-')),context=await chromium.launchPersistentContext(directory,{...browserLaunchOptions,channel:'chrome',headless:true});let gate:ChromiumRequestGate|undefined;
 try{
  gate=await ChromiumRequestGate.install(await chromiumControlUrl(directory),{paceRequests:false,maxRequests:3,onBudget:()=>{budget++;}});
  await context.pages()[0]!.goto(`http://127.0.0.1:${(server.address()as any).port}/page`,{waitUntil:'commit'});const end=Date.now()+3000;while(!budget&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(budget,1);assert(hits.length<=3,`Request budget overrun: ${hits.length}`);
 }finally{gate?.stop();await context.close();gate?.disposeAfterBrowserClose();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});

test('a website-cancelled fetch waiting for its paced turn does not close the browser or release the cancelled request',async()=>{
 const hits:{path:string;time:number}[]=[],failures:string[]=[];
 const server=createServer((req,res)=>{
  hits.push({path:req.url!,time:performance.now()});res.setHeader('Content-Type',req.url==='/script.js'?'text/javascript':'text/html');
  res.end(req.url==='/page'?'<script src="/script.js"></script><img src="/image">':req.url==='/script.js'?"const abort=new AbortController();fetch('/cancelled',{signal:abort.signal}).catch(()=>{});setTimeout(()=>abort.abort(),10);setTimeout(()=>fetch('/after'),800);":'ok');
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
 const directory=await mkdtemp(join(tmpdir(),'collector-cancelled-request-')),context=await chromium.launchPersistentContext(directory,{...browserLaunchOptions,channel:'chrome',headless:true});let gate:ChromiumRequestGate|undefined;
 try{
  gate=await ChromiumRequestGate.install(await chromiumControlUrl(directory),{intervalMs:100,onFailure:(_reason,code)=>failures.push(code)});
  await context.pages()[0]!.goto(`http://127.0.0.1:${(server.address()as any).port}/page`);
  const end=Date.now()+5000;while(!hits.some(hit=>hit.path==='/after')&&!failures.length&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(failures,[]);assert(hits.some(hit=>hit.path==='/after'));assert(!hits.some(hit=>hit.path==='/cancelled'));assert(gate.counts.aborted>=1);
  const gaps=hits.slice(1).map((hit,index)=>hit.time-hits[index]!.time);assert(gaps.every(gap=>gap>=80),`Pacing changed after cancellation: ${gaps}`);
 }finally{gate?.stop();await context.close();gate?.disposeAfterBrowserClose();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});

test('a collection resource policy blocks unrelated scripts before dispatch while native controls still run',async()=>{
 const hits:string[]=[];
 const server=createServer((req,res)=>{hits.push(req.url!);res.setHeader('Content-Type',req.url==='/native.js'?'text/javascript':'text/html');if(req.url==='/native.js')res.end("document.body.append(Object.assign(document.createElement('p'),{textContent:'Native controls ready'}))");else{const port=(server.address()as any).port;res.end(`<html><body><script src="/native.js"></script><script src="http://localhost:${port}/unrelated.js"></script></body></html>`);}});
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const directory=await mkdtemp(join(tmpdir(),'reader-resource-policy-'));let context:any,gate:ChromiumRequestGate|undefined;
 try{
  context=await chromium.launchPersistentContext(directory,{...browserLaunchOptions,headless:true,channel:'chrome'});gate=await ChromiumRequestGate.install(await chromiumControlUrl(directory),{intervalMs:5,allowResource:url=>new URL(url).hostname==='127.0.0.1',blockedResourceTypes:['Image','Other']});
  const page=context.pages()[0];await page.goto(`http://127.0.0.1:${(server.address()as any).port}/page`);await page.getByText('Native controls ready',{exact:true}).waitFor();assert(hits.includes('/native.js'));assert(!hits.includes('/unrelated.js'));assert(gate.counts.suppressed>=1);
 }finally{await context?.close();gate?.disposeAfterBrowserClose();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});

test('real Chromium HTTP requests are spaced across redirects, frames, workers, resources and new tabs', { timeout: 30_000 }, async () => {
  const hits: { path: string; time: number }[] = [];
  const server = createServer((request, response) => {
    const path = request.url!;
    hits.push({ path, time: performance.now() });
    if (path === '/redirect') { response.writeHead(302, { location: '/page' }).end(); return; }
    if (path === '/page') {
      response.setHeader('Content-Type', 'text/html');
      const port = (server.address() as { port: number }).port;
      response.end(`<script src="/script.js"></script><img src="/image.svg"><iframe src="http://localhost:${port}/frame"></iframe>`);
    } else if (path === '/script.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(`fetch('/fetch'); new Worker('/worker.js');`);
    } else if (path === '/worker.js') {
      response.setHeader('Content-Type', 'text/javascript');
      response.end(`fetch('/worker-fetch');`);
    } else if (path === '/frame') {
      response.setHeader('Content-Type', 'text/html');
      response.end(`<script>fetch('/frame-fetch')</script>`);
    } else if (path === '/image.svg') {
      response.setHeader('Content-Type', 'image/svg+xml');
      response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>');
    } else response.end('ok');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing loopback address');
  const origin = `http://127.0.0.1:${address.port}`;
  const profile = await mkdtemp(join(tmpdir(), 'botnet-network-fixture-'));
  const context = await chromium.launchPersistentContext(profile, {
    ...browserLaunchOptions,
    headless: true, channel: process.env.REDDIT_READER_BROWSER_CHANNEL ?? 'chrome',
    // Enables Chromium's command-line inspection API for this local-only check.
    args: [...browserLaunchOptions.args, '--enable-automation'],
  });
  let gate: ChromiumRequestGate | undefined;
  try {
    const inspector = await context.browser()!.newBrowserCDPSession();
    const commandLine = await inspector.send('Browser.getBrowserCommandLine');
    assert(!commandLine.arguments.includes('--no-sandbox'), 'Chrome must run with its sandbox enabled');
    assert(!commandLine.arguments.includes('--disable-setuid-sandbox'), 'Do not disable a sandbox component');
    await inspector.detach();
    gate = await ChromiumRequestGate.install(await chromiumControlUrl(profile), {
      intervalMs: 150, onFailure: reason => { console.error(reason); void context.close(); },
    });
    const page = await context.newPage();
    const extra = await context.newPage();
    await Promise.all([page.goto(`${origin}/redirect`), extra.goto(`${origin}/extra`)]);
    await page.waitForFunction(() => true);
    const deadline = Date.now() + 10_000;
    while (!hits.some(hit => hit.path === '/worker-fetch') || !hits.some(hit => hit.path === '/frame-fetch')) {
      if (Date.now() > deadline) throw new Error(`Missing fixture requests: ${hits.map(hit => hit.path).join(', ')}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    for (const path of ['/redirect', '/page', '/extra', '/script.js', '/image.svg', '/frame', '/fetch', '/worker.js', '/worker-fetch', '/frame-fetch']) {
      assert(hits.some(hit => hit.path === path), `Missing ${path}`);
    }
    // The server may receive a request before Chrome acknowledges its dispatch
    // over CDP. Wait for that asynchronous counter before comparing the two.
    while (gate.counts.released < hits.length) {
      if (Date.now() > deadline) throw new Error(`Request counter did not settle: ${gate.counts.released} acknowledged, ${hits.length} received`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    const gaps = hits.slice(1).map((hit, index) => hit.time - hits[index]!.time);
    assert(gaps.every(gap => gap >= 125), `Server saw a burst: gaps ${gaps.map(gap => gap.toFixed(1)).join(', ')}`);
    assert(gate.counts.released >= hits.length);
    console.log(JSON.stringify({ sandboxEnabled: true, fixtureRequests: hits.length, minimumGapMs: Math.min(...gaps), configuredGapMs: 150 }));
  } finally {
    gate?.stop();
    await context.close();
    gate?.disposeAfterBrowserClose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
  }
});

test('collector suppression and request budget prevent extra network dispatch', {timeout:30_000}, async()=>{
  const hits:string[]=[];
  const server=createServer((req,res)=>{hits.push(req.url!);res.setHeader('Content-Type','text/html');res.end('<script src="/blocked-script"></script><img src="/blocked-image"><p>Local fixture</p>');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const profile=await mkdtemp(join(tmpdir(),'botnet-budget-fixture-'));
  const context=await chromium.launchPersistentContext(profile,{...browserLaunchOptions,headless:true,channel:'chrome'});
  let gate:ChromiumRequestGate|undefined;let budget=false;
  try{
    gate=await ChromiumRequestGate.install(await chromiumControlUrl(profile),{intervalMs:100,blockedResourceTypes:['Script','Image','Other'],maxRequests:1,onBudget:()=>{budget=true;}});
    const page=await context.newPage();await page.goto(origin+'/first');
    await assert.rejects(()=>page.goto(origin+'/second',{timeout:3000}));
    assert.equal(budget,true);assert.deepEqual(hits,['/first']);assert(gate.counts.suppressed>=2);assert.equal(gate.counts.released,1);
  }finally{gate?.stop();await context.close();gate?.disposeAfterBrowserClose();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(profile,{recursive:true,force:true});}
});

test('player MP4 and DASH requests are observed and blocked before dispatch, including XHR streams',async()=>{
 const profile=await mkdtemp(join(tmpdir(),'reader-player-fixture-'));const context=await chromium.launchPersistentContext(profile,{...browserLaunchOptions,headless:true,channel:'chrome'});let gate:ChromiumRequestGate|undefined;const seen:string[]=[];
 try{
  gate=await ChromiumRequestGate.install(await chromiumControlUrl(profile),{onMediaRequest:url=>seen.push(url)});
  const page=await context.newPage();const url='https://v.redd.it/fixture/CMAF_720.mp4';
  await page.evaluate(async url=>{await fetch(url).catch(()=>{});},url);
  const manifest='https://v.redd.it/fixture/DASHPlaylist.mpd';await page.evaluate(async url=>{await fetch(url).catch(()=>{});},manifest);assert.deepEqual(seen,[url,manifest]);assert.equal(gate.counts.released,0);assert.equal(gate.counts.suppressed,2);
 }finally{gate?.stop();await context.close();gate?.disposeAfterBrowserClose();await rm(profile,{recursive:true,force:true});}
});
