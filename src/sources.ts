import {subredditName,redditUrl} from './reddit-identity.ts';

export type Platform='reddit'|'tumblr';
/** Existing Reddit keys occupy the reserved bare/t3_ namespace. Every new
 * platform uses an explicit prefix; never reinterpret an existing library ID. */
export function tumblrBlog(input:string):string {
  let name=input.trim().toLowerCase().replace(/^tumblr:/,'').replace(/^@/,'');
  if(/^https?:\/\//.test(name)){
    const url=new URL(name);
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)throw new Error('Use a public Tumblr blog name or HTTPS Tumblr blog URL');
    if(url.hostname==='www.tumblr.com'&&/^\/[a-z0-9-]+\/?$/.test(url.pathname))name=url.pathname.replaceAll('/','');
    else if(/^[a-z0-9-]+\.tumblr\.com$/.test(url.hostname)&&url.pathname==='/')name=url.hostname.split('.')[0]!;
    else throw new Error('Use a Tumblr blog name or its tumblr.com blog URL');
  }
  if(!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name)||['www','assets','media','api','static','embed'].includes(name))throw new Error('Invalid Tumblr blog name');
  return name;
}
export function feedName(input:string):string {
  return /^tumblr:/i.test(input.trim())?'tumblr:'+tumblrBlog(input):subredditName(input);
}
export function feedIdentity(input:string){
  const name=feedName(input),tumblr=name.startsWith('tumblr:');
  return {platform:(tumblr?'tumblr':'reddit') as Platform,id:name,key:tumblr?name:'reddit:'+name,name:tumblr?name.slice(7):name,label:tumblr?'@'+name.slice(7):'r/'+name};
}
export function tumblrItem(input:string):{blog:string;id:string}|null {
  const match=/^tumblr:([a-z0-9-]+):([1-9][0-9]{0,19})$/.exec(input);
  return match?{blog:tumblrBlog(match[1]!),id:match[2]!}:null;
}
/** Both supported website layouts retain the same blog/item namespace. */
export function tumblrUrl(input:string,feed:string,listing=false):URL {
  const blog=tumblrBlog(feed),url=new URL(input,`https://${blog}.tumblr.com/`);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.search)throw new Error('Expected a public page on the selected Tumblr blog');
  const theme=url.hostname===blog+'.tumblr.com',web=url.hostname==='www.tumblr.com';
  const valid=theme?(listing?/^\/(?:page\/[1-9][0-9]{0,8}\/?)?$/.test(url.pathname):/^\/post\/[1-9][0-9]{0,19}(?:\/[^/]*)?\/?$/.test(url.pathname)):
    web?(listing?url.pathname.replace(/\/$/,'')==='/'+blog:new RegExp(`^/${blog}/[1-9][0-9]{0,19}(?:/[^/]*)?/?$`).test(url.pathname)):false;
  if(!valid)throw new Error('Expected a public '+(listing?'listing':'post')+' page on the selected Tumblr blog');
  return url;
}
export function tumblrPostUrl(input:string):string {
  const item=tumblrItem(input);if(!item)throw new Error('Invalid Tumblr post ID');
  return `https://www.tumblr.com/${item.blog}/${item.id}`;
}
/** Only a captured, post-bound native media frame may be visited. No APIs,
 * arbitrary embeds or cross-blog redirects are permitted. */
export function tumblrEmbedUrl(input:string,feed:string,expectedId?:string):URL {
  const blog=tumblrBlog(feed),url=new URL(input,`https://${blog}.tumblr.com/`);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.search)throw new Error('Invalid Tumblr media frame');
  const match=url.hostname===blog+'.tumblr.com'?/^\/photoset_iframe\/([1-9][0-9]{0,19})(?:\/[a-zA-Z0-9_-]{1,100})*\/?$/.exec(url.pathname):url.hostname==='www.tumblr.com'?new RegExp(`^/video/${blog}/([1-9][0-9]{0,19})(?:/[a-zA-Z0-9_-]{1,100})*/?$`).exec(url.pathname):null;
  if(!match||expectedId&&match[1]!==expectedId)throw new Error('Tumblr media frame does not belong to the requested post');
  return url;
}
/** The documented, public per-blog archive entry point. Traversal needs its own
 * adapter; accepting this document never makes it a normal post/listing. */
export function tumblrArchiveUrl(input:string,feed:string):URL {
  const blog=tumblrBlog(feed),url=new URL(input,`https://${blog}.tumblr.com/`);
  if(url.protocol!=='https:'||url.hostname!==blog+'.tumblr.com'||url.port||url.username||url.password||url.search||url.hash||url.pathname.replace(/\/$/,'')!=='/archive')throw new Error('Expected the selected Tumblr blog archive');
  return url;
}
export const TUMBLR_DAY=86_400_000;
const searchDate=(value:string)=>{const time=Date.parse(value+'T00:00:00Z');if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(time)||new Date(time).toISOString().slice(0,10)!==value)throw new Error('Invalid Tumblr search date');return time;};
/** Only generated, blog-bound dated website searches; no APIs or free queries. */
export function parseTumblrSearchUrl(input:string,feed?:string){
  const url=new URL(input);
  if(url.protocol!=='https:'||url.hostname!=='www.tumblr.com'||url.port||url.username||url.password||url.search||url.hash)throw new Error('Invalid Tumblr dated search');
  const match=/^\/search\/([^/]+)\/recent\/?$/.exec(url.pathname);if(!match)throw new Error('Invalid Tumblr dated search');
  const query=decodeURIComponent(match[1]!),parts=/^from:([a-z0-9-]+) since:(\d{4}-\d{2}-\d{2}) before:(\d{4}-\d{2}-\d{2})$/.exec(query),day=/^from:([a-z0-9-]+) date:(\d{4}-\d{2}-\d{2})$/.exec(query);
  if(!parts&&!day)throw new Error('Invalid Tumblr dated search');const blog=tumblrBlog((parts??day)![1]!);
  if(feed!==undefined&&blog!==tumblrBlog(feed))throw new Error('Tumblr dated search left the selected blog');
  const lower=day?searchDate(day[2]!):searchDate(parts![2]!)+TUMBLR_DAY,upper=day?lower+TUMBLR_DAY:searchDate(parts![3]!)-TUMBLR_DAY;
  if(lower<0||upper<=lower)throw new Error('Invalid Tumblr search interval');
  return{url,blog,query,lower,upper,exactDay:Boolean(day)};
}
export function tumblrSearchUrl(feed:string,lower:number,upper:number):string {
  if(!Number.isSafeInteger(lower)||!Number.isSafeInteger(upper)||lower<0||upper<=lower||lower%TUMBLR_DAY||upper%TUMBLR_DAY)throw new Error('Invalid Tumblr history window');
  // Overlap both UTC boundaries: Tumblr's date operators need not use the same
  // timezone/inclusive convention as the explicit post timestamps we validate.
  const query=upper-lower===TUMBLR_DAY?`from:${tumblrBlog(feed)} date:${new Date(lower).toISOString().slice(0,10)}`:`from:${tumblrBlog(feed)} since:${new Date(lower-TUMBLR_DAY).toISOString().slice(0,10)} before:${new Date(upper+TUMBLR_DAY).toISOString().slice(0,10)}`;
  const url='https://www.tumblr.com/search/'+encodeURIComponent(query)+'/recent';parseTumblrSearchUrl(url,feed);return url;
}
export function tumblrContentUrl(input:string,feed:string):URL {
  try{return tumblrUrl(input,feed,true);}catch{/* Try the post layout next. */}
  try{return tumblrUrl(input,feed);}catch{/* An archive is a separate public document. */}
  try{return parseTumblrSearchUrl(input,feed).url;}catch{/* Not a dated search. */}
  try{return tumblrArchiveUrl(input,feed);}catch{return tumblrEmbedUrl(input,feed);}
}
export function listingUrl(feed:string){const identity=feedIdentity(feed);return identity.platform==='tumblr'?`https://www.tumblr.com/${identity.name}`:`https://old.reddit.com/r/${identity.name}/new/`;}
export function validateListingUrl(input:string,feed:string){
  if(feedIdentity(feed).platform==='tumblr'){if(new URL(input).pathname.startsWith('/search/'))return parseTumblrSearchUrl(input,feed).url;return tumblrUrl(input,feed,true);}
  const url=redditUrl(input);if(url.hash||url.hostname!=='old.reddit.com'||!new RegExp(`^/r/${subredditName(feed)}/new/?$`,'i').test(url.pathname))throw new Error('Invalid committed listing URL');return url;
}
/** A public theme may contain frames or links to legacy APIs. Navigation and
 * styles are the only allowed resources; hidden embeds must not dispatch them. */
export function tumblrResourceAllowed(input:string,type:string,blog:string|null,navigation?:string):boolean {
  try{
    const url=new URL(input);
    if(url.protocol!=='https:'||url.port||url.username||url.password||!blog)return false;
    if(type==='Document'){
      const feed='tumblr:'+tumblrBlog(blog);
      try{tumblrArchiveUrl(input,feed);return input===navigation;}catch{/* Not an archive entry point. */}
      try{parseTumblrSearchUrl(input,feed);return input===navigation;}catch{/* Not a dated search. */}
      tumblrContentUrl(input,feed);
      try{tumblrEmbedUrl(input,feed);return input===navigation;}catch{return true;}
    }
    return type==='Stylesheet'&&[blog+'.tumblr.com','www.tumblr.com','static.tumblr.com','assets.tumblr.com'].includes(url.hostname)&&/\.css$/.test(url.pathname);
  }catch{return false;}
}
/** Tumblr's collector uses outbound for a separate embedded player. A cached
 * hosted picture/video does not also establish a saved copy of that player. */
export function hasExternalAttachment(post:{subreddit:string;outbound:string|null;media:readonly string[]}):boolean {
  return feedIdentity(post.subreddit).platform==='tumblr'&&Boolean(post.outbound)&&post.media.includes('Video');
}
export const EXTERNAL_ATTACHMENT_NOTE='An embedded player requires internet; hosted attachments are saved locally';

/** Only known public origins and structural identifiers. Never query parameters,
 * fragments, URL credentials, post-title slugs or signed CDN paths. */
export function diagnosticPage(input:unknown):string|undefined {
  try{
    if(typeof input!=='string'||input.length>8000)return;
    const url=new URL(input);if(url.protocol!=='https:'||url.port)return;
    if(['old.reddit.com','www.reddit.com','reddit.com'].includes(url.hostname)){
      const match=/^\/r\/([a-z0-9_]{2,21})\/(new|comments\/([a-z0-9]{1,16}))\/?/i.exec(url.pathname);
      return url.origin+(match?`/r/${match[1]!.toLowerCase()}/${match[2]}/`:'/');
    }
    if(/^[a-z0-9-]+\.tumblr\.com$/.test(url.hostname)&&!['api','assets','static'].includes(url.hostname.split('.')[0]!)){
      const match=/^\/(post\/[0-9]{1,20}|page\/[0-9]{1,9})(?:\/|$)/.exec(url.pathname);return url.origin+(match?'/'+match[1]+'/':'/');
    }
    if(url.hostname==='www.tumblr.com'){const match=/^\/([a-z0-9-]{1,32})(?:\/([1-9][0-9]{0,19}))?(?:\/|$)/.exec(url.pathname);if(match&&match[1]!=='video')return url.origin+'/'+match[1]+(match[2]?'/'+match[2]:'')+'/';}
    if(url.hostname==='arctic-shift.photon-reddit.com')return url.origin+'/api/posts/search';
    if(['i.redd.it','v.redd.it','i.imgur.com','preview.redd.it','external-preview.redd.it'].includes(url.hostname)||/^(?:[a-z0-9-]+\.)?media\.tumblr\.com$/.test(url.hostname))return url.origin+'/[media]';
  }catch{/* URLs are optional diagnostic context. */}
}
