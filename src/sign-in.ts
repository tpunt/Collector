import type {BrowserContext} from 'playwright';
import type {Platform} from './sources.ts';

export const MANUAL_SIGN_IN_REQUEST_LIMIT=1000;

export interface SignInObservation {
  state:'signed-in'|'signed-out'|'unknown'|'closed'|'form-error';
  account:string|null;
}
export interface SignInStatus {
  state:'unknown'|'checking'|'waiting'|'signed-in'|'unverified'|'error';
  account:string|null;
  verifiedAt:number|null;
  detail?:string;
}
export const emptySignInStatus=():SignInStatus=>({state:'unknown',account:null,verifiedAt:null});

/** Runs only against rendered first-party UI. Never reads cookies, input values,
 * scripts, hydration state, response bodies or account settings. */
export function collectSignInDom(platform:Platform):SignInObservation {
  const unknown:SignInObservation={state:'unknown',account:null};
  const host=location.hostname;
  if(location.protocol!=='https:'||location.port||!(platform==='tumblr'?host==='www.tumblr.com':['www.reddit.com','old.reddit.com','reddit.com'].includes(host)))return unknown;
  function visible(element:Element):boolean {
    if(!element.isConnected||element.closest('template,[hidden],[inert],[aria-hidden="true"]'))return false;
    for(let node:Element|null=element;node;node=node.parentElement){
      const style=getComputedStyle(node);
      if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0')return false;
    }
    return element.getClientRects().length>0;
  }
  const links=(scope:ParentNode)=>[...scope.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(visible);
  const path=(link:HTMLAnchorElement)=>{
    try{const url=new URL(link.href);return url.origin===location.origin?url.pathname.replace(/\/$/,''):'';}catch{return '';}
  };
  const loginRoute=platform==='tumblr'?/^\/login(?:\/|$)/:/^\/(?:login|account\/login)(?:\/|$)/;
  if(loginRoute.test(location.pathname)&&[...document.querySelectorAll('body > pre')].some(element=>visible(element)&&/^Cannot POST \/login\/?$/.test((element.textContent??'').trim())))return{state:'form-error',account:null};
  if(platform==='reddit'){
    for(const link of links(document.querySelector('#header .user')??document.createDocumentFragment())){
      const match=/^\/user\/([a-z0-9_-]{3,24})$/i.exec(path(link));
      if(match&&(link.textContent??'').trim().toLowerCase()===match[1]!.toLowerCase())return{state:'signed-in',account:match[1]!};
    }
  }else{
    // These personal navigation destinations are absent from logged-out Tumblr.
    // Require several together inside site navigation, rather than a dashboard
    // URL or an account link embedded in somebody else's post.
    for(const navigation of document.querySelectorAll('nav,[role="navigation"]')){
      if(!visible(navigation)||navigation.closest('article,[data-post-id]'))continue;
      const paths=new Set(links(navigation).map(path));
      if(paths.has('/dashboard')&&paths.has('/inbox')&&[...paths].some(value=>/^\/settings(?:\/account)?$/.test(value)))return{state:'signed-in',account:null};
    }
  }
  if(document.readyState==='complete'&&loginRoute.test(location.pathname)&&[...document.querySelectorAll('input[type="email"],input[type="password"],input[autocomplete="username"]')].some(visible))return{state:'signed-out',account:null};
  return unknown;
}

/** Polls the already open sign-in DOM; polling itself makes no HTTP requests.
 * A successful Reddit redirect gets one paced Classic-page identity check.
 * Closing/cancelling invalidates every pending result before it can escape. */
export function watchSignIn(context:BrowserContext,platform:Platform,onChange:(state:SignInObservation)=>void,intervalMs=1000):()=>void {
  let stopped=false,timer:ReturnType<typeof setTimeout>|null=null,classicCheck=false;
  const stop=()=>{stopped=true;if(timer)clearTimeout(timer);context.off('close',closed);};
  const closed=()=>{if(stopped)return;stop();onChange({state:'closed',account:null});};
  context.on('close',closed);
  const poll=async()=>{
    try{
      for(const page of context.pages()){
        if(stopped)return;
        const observation=await page.evaluate(collectSignInDom,platform);
        if(stopped)return;
        if(observation.state==='signed-in'||observation.state==='form-error'){stop();onChange(observation);return;}
        if(observation.state==='signed-out')onChange(observation);
        const url=new URL(page.url());
        if(platform==='reddit'&&!classicCheck&&url.protocol==='https:'&&!url.port&&['www.reddit.com','reddit.com'].includes(url.hostname)&&!/^\/(?:login|account\/login|register|password)(?:\/|$)/.test(url.pathname)){
          classicCheck=true;
          await page.goto('https://old.reddit.com/',{waitUntil:'commit',timeout:180_000});
        }
      }
    }catch{/* A navigation can destroy its previous DOM; the next poll reads the new page. */}
    finally{if(!stopped){timer=setTimeout(()=>void poll(),intervalMs);timer.unref();}}
  };
  void poll();
  return stop;
}
