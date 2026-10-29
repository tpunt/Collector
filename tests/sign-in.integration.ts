import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {createReaderServer} from '../src/server.ts';
import {RequestQueue} from '../src/request-gate.ts';
import {AccessError} from '../src/browser.ts';
import type {Platform} from '../src/sources.ts';
async function until(condition:()=>boolean){const end=Date.now()+10000;while(!condition()){if(Date.now()>end)throw new Error('Sign-in state did not settle');await delay(5);}}

test('separate Tumblr and Reddit manual sign-in controls respect Offline mode and retain the selected source when paused and resumed',async()=>{
 const opened:Platform[]=[],counts={released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:0};let closed=0;
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0}),browser:{counts,async open(){},async close(){closed++;},async navigate(){assert.fail('Signing in must not collect a feed');},async manualSignIn(platform='reddit'){opened.push(platform);counts.released++;}}}});
 const origin=await app.listen(),browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'});
 try{
  const state=await(await fetch(origin+'/api/state')).json();const post=(path:string,data:unknown={})=>fetch(origin+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Reader-Token':state.token},body:JSON.stringify(data)});
  assert.equal((await post('sign-in',{platform:'tumblr'})).status,400);assert.deepEqual(opened,[]);
  const page=await browser.newPage();await page.goto(origin);await page.getByRole('button',{name:'Settings',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Open Tumblr sign-in browser',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();await page.getByRole('switch',{name:'Offline mode',exact:true}).click();await page.getByRole('button',{name:'Settings',exact:true}).click();
  assert.equal((await post('sign-in',{platform:'unknown'})).status,400);assert.deepEqual(opened,[]);
  await page.getByRole('button',{name:'Open Tumblr sign-in browser',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Finish Tumblr sign-in',exact:true}).waitFor();
  assert.deepEqual(opened,['tumblr']);assert.equal(app.jobs.state.manualPlatform,'tumblr');assert.equal(app.store.getSetting('account'),null);assert.equal(await page.getByRole('button',{name:'Open Reddit sign-in browser',exact:true}).isDisabled(),true);
  await app.networkMode.change(true);assert.equal(app.jobs.state.manual,false);assert.equal(app.networkMode.status.paused.signIn,true);assert.equal(app.store.getSetting<{signInPlatform:string}>('offlineResume')!.signInPlatform,'tumblr');
  await app.networkMode.change(false);await until(()=>opened.length===2);assert.deepEqual(opened,['tumblr','tumblr']);assert.equal(app.jobs.state.manualPlatform,'tumblr');
  await page.getByRole('dialog').getByRole('button',{name:'Finish Tumblr sign-in',exact:true}).click();await page.getByRole('button',{name:'Open Tumblr sign-in browser',exact:true}).waitFor();assert.equal(app.jobs.state.manualPlatform,null);
  await page.getByRole('button',{name:'Open Reddit sign-in browser',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Finish Reddit sign-in',exact:true}).waitFor();assert.deepEqual(opened,['tumblr','tumblr','reddit']);
  await page.getByRole('dialog').getByRole('button',{name:'Finish Reddit sign-in',exact:true}).click();await until(()=>!app.jobs.state.manual);assert(closed>=3);assert.equal(app.store.stats().posts,0);assert.equal(app.store.getSetting('account'),null);
  assert.equal((await post('sign-in/finish')).status,400);
 }finally{await browser.close();await app.close();}
});

test('a denied Tumblr sign-in closes its window, retains its service pause and never binds or clears the Reddit account',async()=>{
 let starts=0;
 const app=createReaderServer({database:':memory:',port:0,jobs:{network:new RequestQueue({intervalMs:0}),browser:{counts:{released:0,intercepted:0,aborted:0,suppressed:0,intervalMs:0},async open(){},async close(){},async navigate(){assert.fail('No feed should be collected');},async manualSignIn(){starts++;}}}});
 try{
  await app.networkMode.change(false);app.store.bindAccount('fixture_user');
  const pause={reason:'Tumblr returned 429',notBefore:Date.now()+60000};app.store.setSetting('accessPause:tumblr',pause);await assert.rejects(app.jobs.signIn('tumblr'),/Cooldown/);assert.equal(starts,0);assert.deepEqual(app.store.getSetting('accessPause:tumblr'),pause);
  app.store.setSetting('accessPause:tumblr',null);await app.jobs.signIn('tumblr');app.jobs.accessFailure(new AccessError('Tumblr denied access (403)',null,'tumblr'));
  assert.equal(app.jobs.state.manual,false);assert.equal(app.jobs.state.sourcePause!.reason,'Tumblr denied access (403)');assert.equal(app.jobs.state.accessPause,null);assert.equal(app.store.getSetting('account'),'fixture_user');
  await app.jobs.close();await app.jobs.signIn('tumblr');assert.equal(app.jobs.offlineWork().signIn,true);assert.equal(app.jobs.offlineWork().signInPlatform,'tumblr');await app.jobs.finishSignIn();
 }finally{await app.close();}
});
