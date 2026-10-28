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
export function tumblrUrl(input:string,feed:string,listing=false):URL {
  const blog=tumblrBlog(feed),url=new URL(input,`https://${blog}.tumblr.com/`);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.hash||url.hostname!==blog+'.tumblr.com')throw new Error('Expected a public page on the selected Tumblr blog');
  const valid=listing?(/^\/(?:page\/[1-9][0-9]{0,8}\/?)?$/.test(url.pathname)&&!url.search):/^\/post\/[1-9][0-9]{0,19}(?:\/[^/]*)?\/?$/.test(url.pathname)&&!url.search;
  if(!valid)throw new Error('Invalid Tumblr '+(listing?'listing':'post')+' URL');
  return url;
}
export function listingUrl(feed:string){const identity=feedIdentity(feed);return identity.platform==='tumblr'?`https://${identity.name}.tumblr.com/`:`https://old.reddit.com/r/${identity.name}/new/`;}
export function validateListingUrl(input:string,feed:string){
  if(feedIdentity(feed).platform==='tumblr')return tumblrUrl(input,feed,true);
  const url=redditUrl(input);if(url.hash||url.hostname!=='old.reddit.com'||!new RegExp(`^/r/${subredditName(feed)}/new/?$`,'i').test(url.pathname))throw new Error('Invalid committed listing URL');return url;
}
/** A public theme may contain frames or links to legacy APIs. Navigation and
 * styles are the only allowed resources; hidden embeds must not dispatch them. */
export function tumblrResourceAllowed(input:string,type:string,blog:string|null):boolean {
  try{
    const url=new URL(input);
    if(url.protocol!=='https:'||url.port||url.username||url.password||!blog)return false;
    if(type==='Document'){
      const feed='tumblr:'+tumblrBlog(blog);
      tumblrUrl(input,feed,!url.pathname.startsWith('/post/'));return true;
    }
    return type==='Stylesheet'&&[blog+'.tumblr.com','static.tumblr.com','assets.tumblr.com'].includes(url.hostname)&&/\.css$/.test(url.pathname);
  }catch{return false;}
}
/** Tumblr's collector uses outbound for a separate embedded player. A cached
 * hosted picture/video does not also establish a saved copy of that player. */
export function hasExternalAttachment(post:{subreddit:string;outbound:string|null;media:readonly string[]}):boolean {
  return feedIdentity(post.subreddit).platform==='tumblr'&&Boolean(post.outbound)&&post.media.includes('Video');
}
export const EXTERNAL_ATTACHMENT_NOTE='An embedded player requires internet; hosted attachments are saved locally';
