import type {Page} from 'playwright';
import {absoluteTime,postId,validateObservation} from './domain.ts';
import type {PostObservation,MediaKind} from './domain.ts';
import {feedIdentity,tumblrItem,tumblrUrl} from './sources.ts';
import {mediaReferences,MAX_MEDIA_REFERENCES} from './media-reference.ts';
import type {Listing} from './extract.ts';
import {PostIdentityError,ExtractionError} from './sync-errors.ts';

/** Public theme HTML only: attached content and explicit attributes. No API,
 * hydration-state traversal, screenshots or page-script execution. */
export function collectTumblrDom(){
  const visible=(element:Element)=>!element.closest('[hidden],template,[aria-hidden="true"],.notes,.post-notes')&&getComputedStyle(element).display!=='none'&&getComputedStyle(element).visibility!=='hidden'&&element.getClientRects().length>0;
  const roots=[...document.querySelectorAll('article,[data-post-id],.post[id],.posts > .post')].filter(visible).filter(element=>!element.parentElement?.closest('article,[data-post-id],.post[id]'));
  const rows=roots.map(element=>{
    const links=[...element.querySelectorAll<HTMLAnchorElement>('a[href]')];
    const permalink=links.find(link=>/\/post\/[0-9]+(?:\/|$)/.test(link.href));
    const clone=element.cloneNode(true) as HTMLElement;
    const original=[...element.querySelectorAll('*')],copied=[...clone.querySelectorAll('*')];
    original.forEach((node,index)=>{if(!visible(node))copied[index]?.remove();});
    clone.querySelectorAll('script,style,nav,footer,.tags,.post-tags,.notes,.post-notes,.like_button,.reblog_button,.post-controls,button').forEach(node=>node.remove());
    clone.querySelectorAll('br').forEach(node=>node.replaceWith('\n'));
    clone.querySelectorAll('p,li,div,blockquote,h1,h2,h3').forEach(node=>node.append('\n'));
    const text=(clone.textContent??'').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
    const files=[...element.querySelectorAll<HTMLImageElement|HTMLVideoElement|HTMLSourceElement>('img,video,video source')].filter(node=>visible(node)&&!node.closest('.avatar,.post-avatar,.reblog-avatar,.blog-avatar,.notes,.post-notes')).flatMap(node=>{
      const srcset=node.getAttribute('srcset')??node.getAttribute('data-srcset');
      const best=srcset?.split(',').map(item=>item.trim().split(/\s+/)).sort((a,b)=>parseInt(b[1]??'0')-parseInt(a[1]??'0'))[0]?.[0];
      return [best??node.getAttribute('data-orig-src')??node.getAttribute('data-src')??node.getAttribute('src')].filter((url):url is string=>Boolean(url));
    });
    const frames=[...element.querySelectorAll<HTMLIFrameElement>('iframe')].map(node=>node.getAttribute('src')??'');
    let incomplete=Boolean(element.querySelector('.paywall,[data-paywall],.post-plus-paywall'));
    // NPF media blocks are explicit attributes on rendered content, not app state.
    for(const node of element.querySelectorAll('[data-npf]'))try{
      const block=JSON.parse(node.getAttribute('data-npf')??'{}');
      if(['image','video'].includes(block.type)){
        const variants=Array.isArray(block.media)?block.media:block.media?[block.media]:[];
        const best=variants.sort((a:any,b:any)=>(b.width??0)-(a.width??0))[0];
        if(best?.url)files.push(best.url);else if(block.type==='video'&&typeof block.url==='string')frames.push(block.url);else incomplete=true;
      }
      if(block.type==='paywall')incomplete=true;
    }catch{incomplete=true;}
    const readMore=incomplete||links.some(link=>/read more|keep reading/i.test(link.textContent??''));
    return {permalink:element.getAttribute('data-post-url')??permalink?.href??null,
      id:element.getAttribute('data-post-id')??element.id.match(/(?:post[-_]?)?([0-9]{5,})$/)?.[1]??null,
      title:element.querySelector('h1,h2,h3')?.textContent?.trim()??text.split('\n')[0]?.slice(0,200)??'',
      datetime:element.querySelector('time[datetime]')?.getAttribute('datetime')??null,
      timestamp:element.getAttribute('data-timestamp'),
      body:text,files,frames,readMore,
      pinned:element.matches('.pinned,.pinned-post,[data-pinned="true"]')};
  });
  const current=Number(location.pathname.match(/^\/page\/([0-9]+)/)?.[1]??1);
  const next=[...document.querySelectorAll<HTMLAnchorElement>('a[href]')].find(link=>{
    try{const url=new URL(link.href);return url.origin===location.origin&&url.pathname.replace(/\/$/,'')===`/page/${current+1}`&&!url.search;}catch{return false;}
  });
  const blocked=/log in to|sign up to|verify you are human|access denied|too many requests|privacy consent/i.test(document.querySelector('h1')?.textContent??'');
  const empty=Boolean(document.querySelector('.no-posts,.no_posts,[data-empty-blog="true"]'));
  return {rows,next:next?.href??null,blocked,empty,canonical:document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href??null};
}
function observation(row:ReturnType<typeof collectTumblrDom>['rows'][number],feed:string,complete=false):PostObservation {
  const identity=feedIdentity(feed),url=row.permalink?tumblrUrl(row.permalink,feed):null;
  const id=url?.pathname.split('/')[2]??row.id;if(!id)throw new Error('Tumblr post identity is missing');
  if(row.id&&row.id!==id)throw new PostIdentityError(`tumblr:${identity.name}:${id}`,[row.id],row.permalink??'');
  const timestamp=row.timestamp&&/^[0-9]+$/.test(row.timestamp)?Number(row.timestamp)*1000:null;
  const created=row.datetime?absoluteTime(row.datetime):timestamp!==null?{epochMs:timestamp,precisionMs:1000}:null;
  if(!created)throw new Error('Tumblr theme does not expose an absolute post time');
  const files=mediaReferences(row.files.map(url=>new URL(url,`https://${identity.name}.tumblr.com`).href));
  if(files.length>MAX_MEDIA_REFERENCES)throw new Error('Tumblr post contains too many attachments');
  const unknownFiles=row.files.filter(url=>!mediaReferences([new URL(url,`https://${identity.name}.tumblr.com`).href]).length);
  const embedded=row.frames.find(url=>!url.includes('assets.tumblr.com')&&!url.includes('like_iframe'));
  if(complete&&(row.readMore||unknownFiles.length||row.frames.some(url=>/photoset_iframe|video_file|video\.tumblr\.com/i.test(url))))throw new ExtractionError('post-content','Tumblr theme hides some content or media; this post cannot yet be saved completely',{missingFields:['body','attachments']});
  const media:MediaKind[]=['Text',...new Set(files.map(file=>file.kind==='image'?'Image' as const:'Video' as const)),...(embedded?['Video' as const]:[])];
  const itemId=`tumblr:${identity.name}:${id}`;
  return validateObservation({id:itemId,subreddit:feed,title:row.title||`Post by @${identity.name}`,permalink:`https://${identity.name}.tumblr.com/post/${id}/`,
    created,source:'live',observedAt:Date.now(),author:{platform:'tumblr',id:identity.name,name:'@'+identity.name},body:row.body,bodyNeedsFetch:!complete,
    media:media.length?media:['Text'],attachments:complete?files.map((file,index)=>({...file,collection:{id:itemId,index,total:files.length}})):[],outbound:embedded?new URL(embedded,`https://${identity.name}.tumblr.com`).href:undefined});
}
export async function readTumblrListing(page:Page,feed:string):Promise<Listing>{
  tumblrUrl(page.url(),feed,true);const dom=await page.evaluate(collectTumblrDom);
  const evidence={rows:dom.rows.length,selector:'article,[data-post-id],.post[id]',emptyMarker:dom.empty,nextPresent:Boolean(dom.next)};
  if(dom.blocked)throw new ExtractionError('access','Tumblr requires sign-in or access confirmation; public-blog collection paused',evidence);
  if(!dom.rows.length&&!dom.empty)throw new ExtractionError('listing-layout','Tumblr theme was not recognised; no explicit empty state',evidence);
  const posts:PostObservation[]=[];let omissions=0;
  for(const row of dom.rows)try{posts.push(observation(row,feed));}catch{omissions++;}
  // Unknown dates/identity must remain retryable, rather than permanently skip a
  // page or report that all history was collected.
  if(omissions)throw new ExtractionError('listing-records',`${omissions} Tumblr post(s) lacked a supported identity or absolute time; page checkpoint kept for retry`,{...evidence,accepted:posts.length,rejected:omissions,missingFields:['id','datetime','permalink']});
  const next=dom.next?tumblrUrl(dom.next,feed,true).href:null;
  return{account:'',posts,ordinary:posts.filter((_,index)=>!dom.rows[index]?.pinned).map(post=>({id:post.id,createdMs:post.created.epochMs,precisionMs:post.created.precisionMs})),unknownTime:false,omissions:0,next,empty:dom.empty,signature:posts.map(post=>post.id).join(',')};
}
export async function readTumblrPost(page:Page,input:string):Promise<PostObservation>{
  const id=postId(input),identity=tumblrItem(id);if(!identity)throw new PostIdentityError(input,[],page.url());
  const feed='tumblr:'+identity.blog;const url=tumblrUrl(page.url(),feed);
  if(url.pathname.split('/')[2]!==identity.id)throw new PostIdentityError(id,[],page.url());
  const dom=await page.evaluate(collectTumblrDom);
  if(dom.blocked)throw new Error('Tumblr requires sign-in or access confirmation');
  const row=dom.rows.find(row=>row.id===identity.id||row.permalink&&new URL(row.permalink,page.url()).pathname.split('/')[2]===identity.id);
  if(!row)throw new PostIdentityError(id,dom.rows.map(row=>row.id),page.url());
  return observation(row,feed,true);
}
