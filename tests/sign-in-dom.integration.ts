import '../src/browser-path.ts';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {chromium} from 'playwright';
import {browserLaunchOptions} from '../src/browser-options.ts';
import {collectSignInDom,watchSignIn} from '../src/sign-in.ts';
import type {SignInObservation} from '../src/sign-in.ts';

const tumblrNav='<nav><a href="/dashboard">Home</a><a href="/inbox">Inbox</a><a href="/settings/account">Settings</a></nav>';
async function until(condition:()=>boolean){const end=Date.now()+5000;while(!condition()){if(Date.now()>end)throw new Error('Sign-in observation timed out');await delay(5);}}

test('sign-in extraction requires rendered first-party identity evidence, without treating a destination URL or post links as authentication',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'}),page=await browser.newPage();
 try{
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:'<body></body>'}));
  await page.goto('https://www.tumblr.com/dashboard');
  assert.equal((await page.evaluate(collectSignInDom,'tumblr' as const)).state,'unknown');
  await page.setContent(tumblrNav);assert.equal((await page.evaluate(collectSignInDom,'tumblr' as const)).state,'signed-in');
  await page.setContent('<article>'+tumblrNav+'</article>');assert.equal((await page.evaluate(collectSignInDom,'tumblr' as const)).state,'unknown');
  await page.setContent('<div style="opacity:0">'+tumblrNav+'</div>');assert.equal((await page.evaluate(collectSignInDom,'tumblr' as const)).state,'unknown');
  await page.setContent(tumblrNav.replace('href="/inbox"','href="https://example.com/inbox"'));assert.equal((await page.evaluate(collectSignInDom,'tumblr' as const)).state,'unknown');
  await page.goto('https://www.tumblr.com/login');await page.setContent('<input type="email"><input type="password">');assert.deepEqual(await page.evaluate(collectSignInDom,'tumblr' as const),{state:'signed-out',account:null});
  await page.goto('https://staff.tumblr.com/');await page.setContent(tumblrNav);assert.equal((await page.evaluate(collectSignInDom,'tumblr' as const)).state,'unknown');
  await page.goto('https://old.reddit.com/');await page.setContent('<div id="header"><span class="user"><a href="/user/fixture_user/">fixture_user</a></span></div>');assert.deepEqual(await page.evaluate(collectSignInDom,'reddit' as const),{state:'signed-in',account:'fixture_user'});
  await page.setContent('<div id="header"><span class="user"><a href="/user/different_user">fixture_user</a></span></div>');assert.equal((await page.evaluate(collectSignInDom,'reddit' as const)).state,'unknown');
  await page.goto('https://example.com/');await page.setContent('<div id="header"><span class="user"><a href="/user/fixture_user/">fixture_user</a></span></div>');assert.equal((await page.evaluate(collectSignInDom,'reddit' as const)).state,'unknown');
 }finally{await browser.close();}
});

test('manual sign-in observes login transitions without network polling, stops on confirmation, and reports a user-closed window',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'}),context=await browser.newContext(),page=await context.newPage();let requests=0,stop:(()=>void)|undefined;
 try{
  await page.route('**/*',route=>{requests++;return route.fulfill({contentType:'text/html',body:'<input type="email">'});});await page.goto('https://www.tumblr.com/login');
  const observations:SignInObservation[]=[];stop=watchSignIn(context,'tumblr',value=>observations.push(value),10);await until(()=>observations.some(value=>value.state==='signed-out'));
  await page.setContent(tumblrNav);await until(()=>observations.some(value=>value.state==='signed-in'));assert.equal(requests,1);const count=observations.length;
  await page.setContent('<input type="email">');await delay(30);assert.equal(observations.length,count);stop();
  stop=watchSignIn(context,'tumblr',value=>observations.push(value),10);await context.close();await until(()=>observations.some(value=>value.state==='closed'));
 }finally{stop?.();await browser.close();}
});

test('Reddit verification checks the Classic account header after login, once, instead of accepting a redirect as proof',async()=>{
 const browser=await chromium.launch({...browserLaunchOptions,headless:true,channel:'chrome'}),context=await browser.newContext(),page=await context.newPage();const requests:string[]=[],observations:SignInObservation[]=[];let stop:(()=>void)|undefined;
 try{
  await page.route('**/*',route=>{const url=route.request().url();requests.push(url);return route.fulfill({contentType:'text/html',body:url.includes('old.reddit.com')?'<div id="header"><span class="user"><a href="/user/fixture_user">fixture_user</a></span></div>':'<h1>Redirect destination</h1>'});});
  await page.goto('https://www.reddit.com/');stop=watchSignIn(context,'reddit',value=>observations.push(value),10);await until(()=>observations.some(value=>value.state==='signed-in'));assert.deepEqual(requests,['https://www.reddit.com/','https://old.reddit.com/']);assert.equal(observations.at(-1)?.account,'fixture_user');
 }finally{stop?.();await browser.close();}
});
