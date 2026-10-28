import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createOnlineReaderServer} from './online-fixture.ts';
import {RequestQueue} from '../src/request-gate.ts';
import type {PostObservation} from '../src/domain.ts';

test('one feed control waits for local media before showing successful sync, then displays the cached image offline',async()=>{
 let release!:()=>void,started=false,downloads=0;const gate=new Promise<void>(resolve=>{release=resolve;});
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDVQAAAAASUVORK5CYII=','base64'),old=Date.now()-45*86400000;
 const app=await createOnlineReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0}),
  browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:5000},async open(){},async close(){},async manualSignIn(){},async navigate(url){return{url:()=>url}as any;}},
  readListing:async page=>{
   const prefix=page.url().includes('?')?'b':'a';
   const posts:PostObservation[]=Array.from({length:5},(_,i)=>({id:`t3_${prefix}${i}`,subreddit:'aww',title:'Saved history '+prefix+i,permalink:`/r/aww/comments/${prefix}${i}/`,created:{epochMs:old-i,precisionMs:1000},source:'live',observedAt:Date.now(),body:'Complete fixture body',media:['Text']}));
   return{account:'fixture_user',posts:[{...posts[0]!,id:'t3_img',title:'Saved offline image',permalink:'/r/aww/comments/img/',media:['Image'],attachments:[{kind:'image',url:'https://i.redd.it/fixture.png'}]},...posts],ordinary:posts.map(post=>({id:post.id,createdMs:post.created.epochMs,precisionMs:1000})),unknownTime:false,omissions:0,next:`https://old.reddit.com/r/aww/new/?after=t3_${prefix}4`,empty:false,signature:prefix};
  }},media:{fetch:async()=>{downloads++;started=true;await gate;return new Response(png,{headers:{'Content-Type':'image/png'}});}}});
 app.store.addSubreddit('aww');const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage(),external:string[]=[];await page.route('**/*',route=>{if(new URL(route.request().url()).origin!==origin){external.push(route.request().url());return route.abort();}return route.continue();});
  await page.goto(origin+'/#feeds');const row=page.locator('[data-feed="aww"]');await row.getByRole('button',{name:'Sync r/aww',exact:true}).click();
  await row.getByText('Syncing',{exact:true}).waitFor();assert(started);assert.equal(app.store.feedSync('aww').lastSuccessAt,null);
  assert.equal(await row.getByText('Never',{exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:/Continue history|Continue sync|Fetch history|Refresh/}).count(),0);
  release();await row.getByText('Saved offline',{exact:true}).waitFor();assert(app.store.feedSync('aww').lastSuccessAt);assert.equal(downloads,1);
  assert.equal(await row.getByRole('button',{name:'Sync r/aww',exact:true}).count(),1);assert.equal(await row.getByText('Never',{exact:true}).count(),0);
  await row.getByRole('button',{name:'r/aww',exact:true}).click();await page.waitForFunction(()=>{const image=document.querySelector('.post-media img')as HTMLImageElement|null;return image?.naturalWidth===1;});
  await page.getByRole('button',{name:'Copy local path',exact:true}).waitFor();assert.equal(downloads,1);assert.deepEqual(external,[]);
 }finally{release();await browser.close();await app.close();}
});
