import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';
import {RequestQueue} from '../src/request-gate.ts';

async function fixture(){
 const directory=await mkdtemp(join(tmpdir(),'collector-player-'));
 try{
  // This must contain a picture AND sound; the audio-only input is not a movie.
  const movie=join(directory,'movie.mp4');await promisify(execFile)('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-stream_loop','-1','-i',fileURLToPath(new URL('./fixtures/media.mp4',import.meta.url)),'-stream_loop','-1','-i',fileURLToPath(new URL('./fixtures/media-audio.mp4',import.meta.url)),'-map','0:v:0','-map','1:a:0','-c','copy','-t','8','-movflags','+faststart',movie]);
  const video=await readFile(movie),png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVQAAAAASUVORK5CYII=','base64');let downloads=0;
  const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async input=>{downloads++;return new Response(String(input).endsWith('.mp4')?video:png,{headers:{'Content-Type':String(input).endsWith('.mp4')?'video/mp4':'image/png'}});}}});app.store.addSubreddit('aww');
  const base={subreddit:'aww',created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,exportId:'player',observedAt:Date.now()};
  app.store.importArchiveBatch(app.store.generation,[{...base,id:'video',title:'Video with picture and sound',permalink:'/r/aww/comments/video/',media:['Video'],attachments:[{kind:'video',url:'https://v.redd.it/preview/DASH_720.mp4'}]},
   {...base,id:'gallery',title:'Gallery preview',permalink:'/r/aww/comments/gallery/',media:['Image'],attachments:[0,1].map(index=>({kind:'image' as const,url:`https://i.redd.it/preview-${index}.png`,caption:'Image caption '+(index+1),collection:{id:'reddit:t3_gallery',index,total:2}}))}]);
  for(const id of ['video','gallery'])await app.media.syncPost(id,'fixture',10,new AbortController().signal);
  return{app,origin:await app.listen(),downloads:()=>downloads,close:async()=>{await app.close();await rm(directory,{recursive:true,force:true});}};
 }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
}

test('compact offline video controls play, pause, seek, change sound and preserve the player through native full screen',async()=>{
 const data=await fixture(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage(),external:string[]=[];await page.route('**/*',route=>{if(!route.request().url().startsWith(data.origin)){external.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto(data.origin);const video=page.locator('video');await page.waitForFunction(()=>{const video=document.querySelector('video');return video&&video.readyState>=2&&video.videoWidth===320&&video.videoHeight===180&&video.duration>=7.9;});
  const controls=page.getByRole('group',{name:'Video controls: Video with picture and sound',exact:true});assert((await controls.boundingBox())!.height<=34);assert.equal(await video.getAttribute('controls'),null);
  await controls.getByRole('button',{name:'Play: Video with picture and sound',exact:true}).click();await page.waitForFunction(()=>document.querySelector('video')!.currentTime>0&&!document.querySelector('video')!.paused);
  await page.waitForFunction(()=>((document.querySelector('video') as HTMLVideoElement&{webkitAudioDecodedByteCount:number}).webkitAudioDecodedByteCount)>0);
  await controls.getByRole('button',{name:'Pause: Video with picture and sound',exact:true}).click();assert(await video.evaluate(video=>(video as HTMLVideoElement).paused));
  const position=controls.getByRole('slider',{name:'Playback position: Video with picture and sound',exact:true});await position.focus();await position.press('End');assert((await video.evaluate(video=>(video as HTMLVideoElement).currentTime))>7);await position.press('Home');assert.equal(await video.evaluate(video=>(video as HTMLVideoElement).currentTime),0);
  await controls.getByRole('button',{name:'Mute: Video with picture and sound',exact:true}).click();assert(await video.evaluate(video=>(video as HTMLVideoElement).muted));await controls.getByRole('button',{name:'Unmute: Video with picture and sound',exact:true}).click();
  const volume=controls.getByRole('slider',{name:'Volume: Video with picture and sound',exact:true});await volume.focus();await volume.press('Home');assert.equal(await video.evaluate(video=>(video as HTMLVideoElement).volume),0);await volume.press('End');assert.equal(await video.evaluate(video=>(video as HTMLVideoElement).volume),1);assert.equal(await video.evaluate(video=>(video as HTMLVideoElement).muted),false);
  const handle=await video.elementHandle();await video.press('k');await controls.getByRole('button',{name:'Pause: Video with picture and sound',exact:true}).waitFor();
  await controls.getByRole('button',{name:'Enter full screen: Video with picture and sound',exact:true}).click();await page.waitForFunction(()=>Boolean(document.fullscreenElement));const viewer=page.getByRole('dialog',{name:'Full screen: Video with picture and sound',exact:true});await viewer.waitFor();
  assert(await handle!.evaluate(video=>video.isConnected&&!(video as HTMLVideoElement).paused));assert.equal(await viewer.locator('video').count(),1);await viewer.getByRole('button',{name:'Close full screen',exact:true}).click();await page.waitForFunction(()=>!document.fullscreenElement&&!document.querySelector('[data-media-expanded="true"]'));
  assert(await handle!.evaluate(video=>video.isConnected&&!(video as HTMLVideoElement).paused));await video.press('k');
  await page.getByRole('button',{name:'View image full screen: Gallery preview — image 1',exact:true}).click();await page.waitForFunction(()=>Boolean(document.fullscreenElement?.querySelector('img')));await page.getByRole('dialog',{name:'Full screen: Gallery preview — image 1',exact:true}).getByRole('button',{name:'Close full screen',exact:true}).click();await page.waitForFunction(()=>!document.fullscreenElement);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.equal(await controls.evaluate(element=>element.scrollWidth>element.clientWidth),false);
  assert.deepEqual(external,[]);assert.equal(data.downloads(),3);assert.equal(data.app.jobs.state.requests.sessionTotal,0);
 }finally{await browser.close();await data.close();}
});

test('image and video viewers work when native full screen is denied, retain gallery captions and focus, and Escape keeps the discussion open',async()=>{
 const data=await fixture(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage({viewport:{width:1100,height:850}});await page.addInitScript(()=>{Element.prototype.requestFullscreen=async()=>{throw new DOMException('Full screen unavailable','NotAllowedError');};Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});});
  await page.goto(data.origin);const image=page.getByRole('button',{name:'View image full screen: Gallery preview — image 1',exact:true});await image.waitFor();await image.click();
  const viewer=page.getByRole('dialog',{name:'Full screen: Gallery preview — image 1',exact:true});await viewer.waitFor();assert.equal(await page.evaluate(()=>document.fullscreenElement),null);assert.equal(Math.round((await viewer.boundingBox())!.width),1100);assert.equal(Math.round((await viewer.boundingBox())!.height),850);await viewer.getByText('Image caption 1',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Close full screen');await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Close full screen');
  await page.evaluate(()=>Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}));await page.waitForTimeout(1300);assert.equal(data.app.store.getPost('gallery')!.readAt,null,'Enlarging only the image must not mark the whole post read');
  await page.keyboard.press('Escape');await viewer.waitFor({state:'hidden'});assert.equal(await image.evaluate(element=>element===document.activeElement),true);assert.notEqual(await page.evaluate(()=>document.body.style.overflow),'hidden');
  await page.getByRole('button',{name:'Gallery preview',exact:true}).click();const drawer=page.getByRole('dialog',{name:'Thread details',exact:true});await drawer.waitFor();const second=drawer.getByRole('button',{name:'View image full screen: Gallery preview — image 2',exact:true});await second.scrollIntoViewIfNeeded();await second.click();
  const secondViewer=page.getByRole('dialog',{name:'Full screen: Gallery preview — image 2',exact:true});await secondViewer.waitFor();await secondViewer.getByText('Image caption 2',{exact:true}).waitFor();await page.keyboard.press('Escape');await secondViewer.waitFor({state:'hidden'});assert(await drawer.isVisible());await drawer.getByRole('button',{name:'Close thread',exact:true}).click();
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Enter full screen: Video with picture and sound',exact:true}).click();const movie=page.getByRole('dialog',{name:'Full screen: Video with picture and sound',exact:true});await movie.waitFor();assert.equal(Math.round((await movie.boundingBox())!.width),390);assert.equal(Math.round((await movie.boundingBox())!.height),844);await page.keyboard.press('Escape');await movie.waitFor({state:'hidden'});
  assert.equal(data.downloads(),3);assert.equal(data.app.jobs.state.requests.sessionTotal,0);
 }finally{await browser.close();await data.close();}
});
