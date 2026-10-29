import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

test('the production Tumblr browser uses matching HTTP 404/410 evidence for missing posts, while unknown pages, listings and cross-post redirects remain retryable',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'collector-tumblr-nav-')),previous=process.env.REDDIT_READER_DATA_DIR;process.env.REDDIT_READER_DATA_DIR=directory;
 const {ReaderBrowser}=await import('../src/browser.ts'),{RequestQueue}=await import('../src/request-gate.ts'),{BrowserLimiter}=await import('../src/limiter.ts'),{PostUnavailableError,PostIdentityError,UnsupportedMediaError}=await import('../src/sync-errors.ts'),{readTumblrPost,readTumblrListing}=await import('../src/tumblr.ts');
 const browser=new ReaderBrowser(undefined,new RequestQueue({intervalMs:0}));let status=404,redirect=false;
 try{
  await browser.open(30,'tumblr');(browser as any).limiter=new BrowserLimiter({navigationMs:0});
  await (browser as any).context.route('**/*',async(route:any)=>{
   const url=new URL(route.request().url());if(redirect&&url.pathname==='/staff/12345'){await route.fulfill({status:302,headers:{Location:'https://www.tumblr.com/staff/99999'}});return;}
   await route.fulfill({status,contentType:'text/html',body:'<main><h1>Nothing here</h1></main>'});
  });
  for(status of [404,410])await assert.rejects(browser.navigate('https://www.tumblr.com/staff/12345'),(error:unknown)=>error instanceof PostUnavailableError&&error.postId==='tumblr:staff:12345');
  status=200;const unknown=await browser.navigate('https://www.tumblr.com/staff/12345');await assert.rejects(readTumblrPost(unknown,'tumblr:staff:12345'),PostIdentityError);
  status=404;const listing=await browser.navigate('https://www.tumblr.com/staff');await assert.rejects(readTumblrListing(listing,'tumblr:staff'),/theme was not recognised/);
  await assert.rejects(browser.navigate('https://staff.tumblr.com/photoset_iframe/12345/hash/500/'),UnsupportedMediaError);
  redirect=true;const wrong=await browser.navigate('https://www.tumblr.com/staff/12345');await assert.rejects(readTumblrPost(wrong,'tumblr:staff:12345'),PostIdentityError);
 }finally{await browser.close();if(previous===undefined)delete process.env.REDDIT_READER_DATA_DIR;else process.env.REDDIT_READER_DATA_DIR=previous;await rm(directory,{recursive:true,force:true});}
});
