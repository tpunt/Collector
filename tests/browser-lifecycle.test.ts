import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {ReaderBrowser} from '../src/browser.ts';
import {RequestQueue} from '../src/request-gate.ts';

test('closing while Chrome launches closes the returned context without installing interception or creating an access pause',async()=>{
 const launch=chromium.launchPersistentContext;let entered!:()=>void,release!:(context:any)=>void,closed=0;
 const launching=new Promise<void>(resolve=>{entered=resolve;}),context=new Promise<any>(resolve=>{release=resolve;});
 chromium.launchPersistentContext=(async()=>{entered();return context;}) as typeof launch;
 const browser=new ReaderBrowser(()=>assert.fail('Intentional cancellation is not a service failure'),new RequestQueue({intervalMs:0}));
 try{
  const opening=browser.open();await launching;await browser.close();release({async close(){closed++;}});
  await assert.rejects(opening,/opening was cancelled/);assert.equal(closed,1);await browser.close();assert.equal(closed,1);
 }finally{chromium.launchPersistentContext=launch;await browser.close();}
});
