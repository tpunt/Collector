import type {Author} from './authors.ts';
import {redditUrl} from './domain.ts';

/** Missing evidence is distinct from an explicitly deleted author. */
export function redditAuthor(input:unknown):Author|null|undefined {
  if(typeof input!=='string')return undefined;
  const name=input.trim();if(/^\[(deleted|removed)\]$/i.test(name))return null;
  if(!/^[a-z0-9_-]{1,64}$/i.test(name))return undefined;
  return {platform:'reddit',id:name.toLowerCase(),name};
}
export function redditDomAuthor(input:{name:string;href:string|null}|undefined):Author|null|undefined {
  if(!input)return undefined;
  const author=redditAuthor(input.name);if(!author)return author;
  try{
    const url=redditUrl(input.href??'');
    const match=/^\/(?:user|u)\/([^/]+)\/?$/i.exec(url.pathname);
    return match?.[1]?.toLowerCase()===author.id?author:undefined;
  }catch{return undefined;}
}
