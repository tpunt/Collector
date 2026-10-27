import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';
import {RequestQueue} from '../src/request-gate.ts';

test('retained favourites serve cached images, complete galleries and videos after unsubscribing, until their content is deleted',async()=>{
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVQAAAAASUVORK5CYII=','base64'),video=await readFile(new URL('./fixtures/media.mp4',import.meta.url));let downloads=0;
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0})},media:{fetch:async input=>{downloads++;return new Response(String(input).endsWith('.mp4')?video:png,{headers:{'Content-Type':String(input).endsWith('.mp4')?'video/mp4':'image/png'}});}}});app.store.addSubreddit('aww');
 const author={platform:'reddit',id:'alice_example',name:'Alice_Example'},base={subreddit:'aww',author,body:'Saved body',created:{epochMs:1700000000000,precisionMs:1000},source:'archive' as const,exportId:'retained-media',observedAt:1800000000000};
 app.store.importArchiveBatch(app.store.generation,[{...base,id:'image',title:'Retained image',permalink:'/r/aww/comments/image/',media:['Image'],attachments:[{kind:'image',url:'https://i.redd.it/retained.png'}]},
  {...base,id:'gallery',title:'Retained gallery',permalink:'/r/aww/comments/gallery/',media:['Image'],outbound:'https://www.reddit.com/gallery/gallery/',attachments:[0,1].map(index=>({kind:'image' as const,url:`https://i.redd.it/retained-${index}.png`,caption:'Slide '+(index+1),collection:{id:'reddit:t3_gallery',index,total:2}}))},
  {...base,id:'video',title:'Retained video',permalink:'/r/aww/comments/video/',media:['Video'],outbound:'https://v.redd.it/retained/DASH_720.mp4',attachments:[{kind:'video',url:'https://v.redd.it/retained/DASH_720.mp4'}]}]);
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  for(const id of ['image','gallery','video']){await app.media.syncPost(id,'retained',10,new AbortController().signal);app.store.setPostFavourite(id,true);}app.store.setUserFavourite(author,true);assert.equal(downloads,4);
  const image=(await app.media.items('image'))[0]!,movie=(await app.media.items('video'))[0]!;app.store.removeSubreddit('aww');
  assert.equal((await fetch(origin+image.url)).status,200,'Unsubscribing must not revoke access to owned offline files');assert.equal((await fetch(origin+movie.url,{headers:{Range:'bytes=0-2'}})).status,206);
  const page=await browser.newPage(),external:string[]=[];await page.addInitScript(()=>Object.defineProperty(document,'visibilityState',{get:()=> 'hidden'}));await page.route('**/*',route=>{if(route.request().url().startsWith(origin))return route.continue();external.push(route.request().url());return route.abort();});await page.goto(origin+'/#favourites');await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===3);
  for(const image of await page.locator('.post-card img').all()){await image.scrollIntoViewIfNeeded();await image.evaluate((image:HTMLImageElement)=>{image.loading='eager';});}
  await page.waitForFunction(()=>[...document.querySelectorAll<HTMLImageElement>('.post-card img')].length===3&&[...document.querySelectorAll<HTMLImageElement>('.post-card img')].every(image=>image.naturalWidth===1));
  const player=page.locator('.post-card video');await player.evaluate((video:HTMLVideoElement)=>video.load());await page.waitForFunction(()=>{const video=document.querySelector<HTMLVideoElement>('.post-card video');return video&&video.readyState>=2&&video.videoWidth===320&&video.videoHeight===180;});
  await page.getByRole('button',{name:'Retained gallery',exact:true}).click();const drawer=page.getByRole('dialog',{name:'Thread details',exact:true});await drawer.getByText('2/2 files saved offline · Scroll horizontally to view all',{exact:true}).waitFor();assert.equal(await drawer.locator('img').count(),2);await page.getByRole('button',{name:'Close thread',exact:true}).click();
  await page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:/^Favourite users /}).click();await page.waitForFunction(()=>document.querySelectorAll('.post-card').length===3);assert.deepEqual(external,[]);assert.equal(downloads,4);assert.equal(app.jobs.state.requests.sessionTotal,0);
  const keys=app.store.deletePost('image');await app.media.clearPost('image',keys);assert.equal((await fetch(origin+image.url)).status,404);app.store.clearSubreddit('aww');await app.media.reconcile();assert.equal((await fetch(origin+movie.url)).status,404);
 }finally{await browser.close();await app.close();}
});
