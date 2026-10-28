import type {Page} from 'playwright';
import {absoluteTime,postId,validateObservation} from './domain.ts';
import type {PostObservation,MediaKind} from './domain.ts';
import {feedIdentity,tumblrItem,tumblrUrl,tumblrEmbedUrl} from './sources.ts';
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
    const permalink=links.find(link=>{try{const url=new URL(link.href);return url.origin===location.origin&&/^\/post\/[0-9]+(?:\/|$)/.test(url.pathname);}catch{return false;}});
    const clone=element.cloneNode(true) as HTMLElement;
    const original=[...element.querySelectorAll('*')],copied=[...clone.querySelectorAll('*')];
    original.forEach((node,index)=>{if(!visible(node))copied[index]?.remove();});
    clone.querySelectorAll('script,style,nav,footer,.tags,.post-tags,.notes,.post-notes,.like_button,.reblog_button,.post-controls,button').forEach(node=>node.remove());
    clone.querySelectorAll('br').forEach(node=>node.replaceWith('\n'));
    clone.querySelectorAll('p,li,div,blockquote,h1,h2,h3').forEach(node=>node.append('\n'));
    const text=(clone.textContent??'').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
    const files:string[]=[],frames:string[]=[],mediaOrder:string[]=[];
    const addFile=(url:string)=>{files.push(url);mediaOrder.push(url);},addFrame=(url:string)=>{frames.push(url);mediaOrder.push(url);};
    let incomplete=Boolean(element.querySelector('.paywall,[data-paywall],.post-plus-paywall'));
    const fileUrl=(node:Element)=>{
      if(node.tagName==='VIDEO'||node.tagName==='SOURCE'&&node.parentElement?.tagName==='VIDEO')return node.getAttribute('src')??node.getAttribute('data-src');
      const srcset=node.getAttribute('srcset')??node.getAttribute('data-srcset');
      const best=srcset?.split(',').map(item=>item.trim().split(/\s+/)).sort((a,b)=>parseFloat(b[1]??'0')-parseFloat(a[1]??'0'))[0]?.[0];
      const link=node.closest('a')?.getAttribute('href');
      return node.getAttribute('data-orig-src')??(link&&/^https:\/\/(?:[a-z0-9-]+\.)?media\.tumblr\.com\/.+\.(?:png|jpe?g|gif|webp|avif)$/i.test(link)?link:null)??best??node.getAttribute('data-src')??node.getAttribute('src');
    };
    for(const node of element.querySelectorAll('picture,img,video,iframe,[data-npf]')){
      if(node.closest('.avatar,.post-avatar,.reblog-avatar,.blog-avatar,.notes,.post-notes'))continue;
      if(!visible(node.tagName==='PICTURE'?node.querySelector('img')??node:node))continue;
      // A rendered NPF block is one attachment. Its thumbnail child is never a
      // second image; only explicit media variants are considered.
      if(node.hasAttribute('data-npf'))try{
        const block=JSON.parse(node.getAttribute('data-npf')??'{}');
        if(['image','video'].includes(block.type)){
          const variants=Array.isArray(block.media)?block.media:block.media?[block.media]:[];
          const best=variants.filter((item:any)=>typeof item?.url==='string').sort((a:any,b:any)=>(b.width??0)-(a.width??0))[0];
          if(best?.url)addFile(best.url);else if(block.type==='video'&&typeof block.url==='string')addFrame(block.url);else incomplete=true;
        }else if(block.type==='paywall'||block.type==='audio')incomplete=true;
        continue;
      }catch{incomplete=true;continue;}
      if(node.parentElement?.closest('[data-npf]'))continue;
      if(node.tagName==='IFRAME'){const frame=node.getAttribute('src');if(frame)addFrame(frame);continue;}
      if(node.tagName==='IMG'&&node.closest('picture'))continue;
      let selected=node;
      if(node.tagName==='PICTURE')selected=[...node.querySelectorAll('source')].find(source=>!source.media||matchMedia(source.media).matches)??node.querySelector('img')??node;
      if(node.tagName==='VIDEO'&&!node.getAttribute('src')){const candidates=[...node.querySelectorAll('source')].filter(source=>!source.media||matchMedia(source.media).matches);selected=candidates.find(source=>/\.mp4(?:\?|$)/i.test(source.src))??candidates.find(source=>/\.webm(?:\?|$)/i.test(source.src))??candidates[0]??node;}
      const file=fileUrl(selected);if(file)addFile(file);else if(node.tagName==='VIDEO'||node.tagName==='PICTURE')incomplete=true;
    }
    const readMore=incomplete||links.some(link=>/read more|keep reading/i.test(link.textContent??''));
    return {permalink:element.getAttribute('data-post-url')??permalink?.href??null,
      id:element.getAttribute('data-post-id')??element.id.match(/(?:post[-_]?)?([0-9]{5,})$/)?.[1]??null,
      title:element.querySelector('h1,h2,h3')?.textContent?.trim()??text.split('\n')[0]?.slice(0,200)??'',
      datetime:element.querySelector('time[datetime]')?.getAttribute('datetime')??(location.pathname.startsWith('/post/')?document.querySelector<HTMLMetaElement>('meta[property="article:published_time"]')?.content:null)??null,
      timestamp:element.getAttribute('data-timestamp'),
      body:text,files,frames,mediaOrder,readMore,
      pinned:element.matches('.pinned,.pinned-post,[data-pinned="true"]')};
  });
  const current=Number(location.pathname.match(/^\/page\/([0-9]+)/)?.[1]??1);
  const pageLinks=[...document.querySelectorAll<HTMLAnchorElement>('a[href]')].filter(link=>visible(link)&&link.getAttribute('aria-disabled')!=='true'&&!link.hasAttribute('disabled')&&!['','#'].includes(link.getAttribute('href')?.trim()??''));
  const next=pageLinks.find(link=>{
    try{const url=new URL(link.href);return url.origin===location.origin&&url.pathname.replace(/\/$/,'')===`/page/${current+1}`&&!url.search&&!url.hash;}catch{return false;}
  })??pageLinks.find(link=>link.rel.split(/\s+/).includes('next')&&/\/page\//.test(link.href));
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
  const embedded=row.frames.find(url=>{try{tumblrEmbedUrl(url,feed,id);return false;}catch{return !/assets\.tumblr\.com|like_iframe/.test(url);}});
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
  if(next){const current=Number(new URL(page.url()).pathname.match(/^\/page\/([0-9]+)/)?.[1]??1);if(new URL(next).pathname.replace(/\/$/,'')!==`/page/${current+1}`)throw new ExtractionError('pagination','Tumblr next-page link did not advance one page; checkpoint kept',evidence);}
  return{account:'',posts,ordinary:posts.filter((_,index)=>!dom.rows[index]?.pinned).map(post=>({id:post.id,createdMs:post.created.epochMs,precisionMs:post.created.precisionMs})),unknownTime:false,omissions:0,next,empty:dom.empty,signature:posts.map(post=>post.id).join(',')};
}
export async function readTumblrPost(page:Page,input:string,navigate?:(url:string)=>Promise<Page>):Promise<PostObservation>{
  const id=postId(input),identity=tumblrItem(id);if(!identity)throw new PostIdentityError(input,[],page.url());
  const feed='tumblr:'+identity.blog;const url=tumblrUrl(page.url(),feed);
  if(url.pathname.split('/')[2]!==identity.id)throw new PostIdentityError(id,[],page.url());
  const dom=await page.evaluate(collectTumblrDom);
  if(dom.blocked)throw new Error('Tumblr requires sign-in or access confirmation');
  const row=dom.rows.find(row=>row.id===identity.id||row.permalink&&new URL(row.permalink,page.url()).pathname.split('/')[2]===identity.id);
  if(!row)throw new PostIdentityError(id,dom.rows.map(row=>row.id),page.url());
  const expanded={...row,files:[...row.files],frames:[...row.frames],mediaOrder:[...row.mediaOrder]};
  const native=row.frames.filter(url=>{try{tumblrEmbedUrl(url,feed,identity.id);return true;}catch{return false;}});
  if(native.length&&!navigate)throw new ExtractionError('post-content','Tumblr theme hides some content in a native media frame; collection is incomplete',{missingFields:['attachments']});
  if(native.length>20)throw new ExtractionError('post-content','Too many native media frames; collection is incomplete',{missingFields:['attachments']});
  if(row.frames.some(url=>/photoset_iframe|www\.tumblr\.com\/video\//i.test(url)&&!native.includes(url)))throw new ExtractionError('post-content','Tumblr theme hides some content in an untrusted media frame; collection is incomplete',{missingFields:['attachments']});
  for(const frameUrl of native){
    const expected=tumblrEmbedUrl(frameUrl,feed,identity.id),frame=await navigate!(expected.href);
    if(tumblrEmbedUrl(frame.url(),feed,identity.id).href!==expected.href)throw new Error('Tumblr media frame redirected unexpectedly');
    const media=await frame.evaluate((photoset:boolean)=>{
      const visible=(node:Element)=>!node.closest('[hidden],[aria-hidden="true"]')&&getComputedStyle(node).display!=='none';
      const best=(node:Element)=>{
        if(node.tagName==='VIDEO'||node.tagName==='SOURCE'&&node.parentElement?.tagName==='VIDEO')return node.getAttribute('src')??node.getAttribute('data-src');
        const link=node.closest('a')?.getAttribute('href'),srcset=node.getAttribute('srcset')??node.getAttribute('data-srcset');
        return node.getAttribute('data-orig-src')??(link&&/^https:\/\/(?:[a-z0-9-]+\.)?media\.tumblr\.com\/.+\.(?:png|jpe?g|gif|webp|avif)$/i.test(link)?link:null)??srcset?.split(',').map(value=>value.trim().split(/\s+/)).sort((a,b)=>parseFloat(b[1]??'0')-parseFloat(a[1]??'0'))[0]?.[0]??node.getAttribute('src');
      };
      const files=[...document.querySelectorAll(photoset?'picture,img':'video')].filter(visible).flatMap(node=>{
        if(node.tagName==='IMG'&&node.closest('picture'))return [];
        let selected=node;
        if(node.tagName==='PICTURE')selected=[...node.querySelectorAll('source')].find(source=>!source.media||matchMedia(source.media).matches)??node.querySelector('img')??node;
        if(node.tagName==='VIDEO'&&!node.getAttribute('src')){const sources=[...node.querySelectorAll('source')].filter(source=>!source.media||matchMedia(source.media).matches);selected=sources.find(source=>/\.mp4(?:\?|$)/i.test(source.src))??sources.find(source=>/\.webm(?:\?|$)/i.test(source.src))??sources[0]??node;}
        const file=best(selected);return file?[file]:[];
      });
      return{files,frames:document.querySelectorAll('iframe').length,blocked:/log in|access denied|verify you are human/i.test(document.querySelector('h1')?.textContent??'')};
    },expected.pathname.startsWith('/photoset_iframe/'));
    if(!media.files.length||media.frames||media.blocked)throw new ExtractionError('post-content','Tumblr native frame did not expose every media file; collection is incomplete',{missingFields:['attachments']});
    const valid=mediaReferences(media.files.map(url=>new URL(url,expected).href));
    if(valid.length!==new Set(media.files.map(url=>new URL(url,expected).href)).size)throw new ExtractionError('post-content','Tumblr native frame exposed unsupported attachments; collection is incomplete',{missingFields:['attachments']});
    expanded.mediaOrder=expanded.mediaOrder.flatMap(url=>url===frameUrl?valid.map(item=>item.url):[url]);
    expanded.files=expanded.mediaOrder.filter(url=>!expanded.frames.includes(url)||url===frameUrl);expanded.files=expanded.files.filter(url=>url!==frameUrl);expanded.frames=expanded.frames.filter(url=>url!==frameUrl);
  }
  return observation(expanded,feed,true);
}
