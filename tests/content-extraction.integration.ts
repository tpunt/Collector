import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {readThread} from '../src/extract.ts';

test('full post text keeps rendered link destinations and original inline images without downloading duplicate previews',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage();await page.route('https://**/*',route=>route.abort());
  await page.setContent('<div class="thing self" data-fullname="t3_abc"><div class="entry"><div class="usertext-body"><div class="md"><p>Full post text <a href="https://example.com/article">read this</a></p><a href="https://i.redd.it/original.png"><img width="200" height="100" src="https://preview.redd.it/original.png?width=320"></a><a hidden href="https://hidden.test/">Hidden link</a></div></div></div></div><aside class="side"><a href="https://sidebar.test/">Sidebar</a></aside>');
  const result=await readThread(page,'abc');assert(result.snapshot.body?.includes('Full post text'));assert(result.snapshot.body?.includes('read this: https://example.com/article'));assert(!result.snapshot.body?.includes('hidden.test'));assert(!result.snapshot.body?.includes('sidebar.test'));assert.deepEqual(result.attachments,[{kind:'image',url:'https://i.redd.it/original.png'}]);
  await page.setContent('<div class="thing self" data-fullname="t3_abc"><div class="entry"><div class="usertext-body"><div class="md"></div></div></div></div>');assert.equal((await readThread(page,'abc')).snapshot.body,'');
 }finally{await browser.close();}
});
