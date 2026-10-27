import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {readListing,readThread} from '../src/extract.ts';
import {discoverMedia} from '../src/media-discovery.ts';

test('listing extraction ignores sidebar and unrelated listings, including their pagination',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage({javaScriptEnabled:false});
  const card=(id:string,title:string)=>`<div class="thing self" data-fullname="t3_${id}" data-subreddit="python" data-permalink="/r/python/comments/${id}/"><div class="entry"><a class="title">${title}</a><p class="tagline"><time datetime="2026-10-20T10:30:00Z">time</time></p></div></div>`;
  await page.setContent(`<div id="header"><span class="user"><a href="https://old.reddit.com/user/fixture_user/">fixture_user</a></span></div><div class="tabmenu"><span class="selected">new</span></div><aside class="side"><div class="gadget">${card('recent','Previously viewed')}<span class="next-button"><a href="https://old.reddit.com/r/python/new/?after=t3_wrong">next</a></span></div></aside><div class="sitetable linklisting" id="siteTable">${card('main','Actual feed')}<div class="nav-buttons"><span class="next-button"><a href="https://old.reddit.com/r/python/new/?after=t3_main">next</a></span></div></div><div id="other-listing">${card('related','Related post')}</div>`);
  const listing=await readListing(page,'python');
  assert.deepEqual(listing.posts.map(post=>post.id),['t3_main']);
  assert.deepEqual(listing.ordinary.map(post=>post.id),['t3_main']);
  assert.equal(listing.next,'https://old.reddit.com/r/python/new/?after=t3_main');
  assert.equal(listing.omissions,0);
  await page.setContent(`<div id="header"><span class="user"><a href="https://old.reddit.com/user/fixture_user/">fixture_user</a></span></div><div class="tabmenu"><span class="selected">new</span></div><aside class="side"><span class="next-button"><a href="https://old.reddit.com/r/python/new/?after=t3_wrong">next</a></span></aside><div id="siteTable">${card('main','Actual feed')}</div><div class="nav-buttons"><span class="next-button"><a href="https://old.reddit.com/r/python/new/?after=t3_main">next</a></span></div>`);
  assert.equal((await readListing(page,'python')).next,'https://old.reddit.com/r/python/new/?after=t3_main');
 }finally{await browser.close();}
});

test('a native video poster cannot replace its observed video manifest or count as saved video',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.route('https://**/*',route=>route.abort());
  await page.setContent('<div class="thing" data-fullname="t3_abc" data-url="https://v.redd.it/mainvideo"><div class="expando"><img src="https://preview.redd.it/poster.jpg"><video src="blob:https://old.reddit.com/video"></video></div></div>');
  assert.deepEqual((await readThread(page,'abc')).attachments,[]);
  const manifest='https://v.redd.it/mainvideo/DASHPlaylist.mpd';
  assert.deepEqual(await discoverMedia(page,'abc',()=>[manifest],new AbortController().signal),[{kind:'video',url:manifest}]);
  await assert.rejects(discoverMedia(page,'abc',()=>[],AbortSignal.timeout(30)));
  await page.setContent('<div id="header"><span class="user"><a href="https://old.reddit.com/user/fixture_user/">fixture_user</a></span></div><div class="tabmenu"><span class="selected">new</span></div><div id="siteTable"><div class="thing" data-fullname="t3_abc" data-subreddit="aww" data-permalink="/r/aww/comments/abc/" data-url="https://v.redd.it/mainvideo"><div class="entry"><a class="title">Native video</a><p class="tagline"><time datetime="2026-10-20T10:30:00Z">time</time></p></div><div class="media-preview"><img src="https://preview.redd.it/poster.jpg"></div></div></div>');
  const listing=await readListing(page,'aww');assert.deepEqual(listing.posts[0]?.media,['Video']);assert.deepEqual(listing.posts[0]?.attachments,[]);
 }finally{await browser.close();}
});
