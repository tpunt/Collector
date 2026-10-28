import type {PostOriginInfo} from './PostOrigin.tsx';
import {feedIdentity} from '../src/sources.ts';
export const PLATFORMS=[{id:'reddit',label:'Reddit'},{id:'tumblr',label:'Tumblr'}] as const;
export function sourceOrigin(feed:string):PostOriginInfo {
 const identity=feedIdentity(feed);
 return {platform:PLATFORMS.find(platform=>platform.id===identity.platform)!,feed:{id:identity.id,label:identity.label}};
}
export const feedLabel=(feed:string)=>sourceOrigin(feed).feed.label;
