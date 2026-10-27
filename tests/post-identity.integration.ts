import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {readThread} from '../src/extract.ts';
import {discoverMedia} from '../src/media-discovery.ts';

test('thread and media identity ignore sidebar copies and hidden copies of the requested post',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.route('https://**/*',route=>route.abort());
  await page.setContent('<aside class="side"><div class="thing" data-fullname="t3_abc" data-url="https://i.redd.it/sidebar.jpg"><div class="entry"><div class="usertext-body"><div class="md">Sidebar copy</div></div></div></div></aside><div hidden class="thing" data-fullname="t3_abc" data-url="https://i.redd.it/hidden.jpg"></div><div class="thing" data-fullname="t3_abc" data-url="https://i.redd.it/main.jpg"><div class="entry"><div class="usertext-body"><div class="md">Actual post</div></div></div></div>');
  assert.equal((await readThread(page,'abc')).snapshot.body,'Actual post');
  assert.deepEqual(await discoverMedia(page,'abc',()=>[],new AbortController().signal),[{kind:'image',url:'https://i.redd.it/main.jpg'}]);
 }finally{await browser.close();}
});

test('media discovery recognises an explicitly removed OP only on its matching canonical thread URL',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.route('https://**/*',route=>route.abort());
  await page.route('https://old.reddit.com/r/aww/comments/**',route=>route.fulfill({contentType:'text/html',body:'<div class="thing link deleted"><div class="entry"><a class="title">[ Removed by moderator ]</a></div></div><div class="commentarea"><div class="sitetable"></div></div>'}));
  await page.goto('https://old.reddit.com/r/aww/comments/abc/');
  await assert.rejects(discoverMedia(page,'abc',()=>[],new AbortController().signal),(error:any)=>error.availability==='removed');
  await page.goto('https://old.reddit.com/r/aww/comments/def/');
  await assert.rejects(discoverMedia(page,'abc',()=>[],new AbortController().signal),(error:any)=>error.name==='PostIdentityError'&&error.availability===undefined&&error.message.includes('t3_abc'));
 }finally{await browser.close();}
});

test('an actual unidentified page reports the requested and observed IDs without accepting another post',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.setContent('<div class="thing" data-fullname="t3_def"></div>');
  await assert.rejects(discoverMedia(page,'abc',()=>[],new AbortController().signal),(error:any)=>error.name==='PostIdentityError'&&error.expectedId==='t3_abc'&&error.visibleMainIds.includes('t3_def'));
 }finally{await browser.close();}
});
