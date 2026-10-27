import {MEDIA_FILTERS,subredditName} from './domain.ts';
import type {MediaFilter} from './domain.ts';
import type {ReaderStore} from './store.ts';
import type {MediaInventory} from './media.ts';

export interface CleanupCriteria {feed:string;kind:MediaFilter|'';beforeMs:number|null;readOnly:boolean}
export function cleanupCriteria(input:Record<string,unknown>):CleanupCriteria {
  if(input.feed!==undefined&&typeof input.feed!=='string')throw new Error('Choose a feed');
  const feed=input.feed?subredditName(String(input.feed)):'';
  if(input.kind!==undefined&&input.kind!==''&&!MEDIA_FILTERS.includes(input.kind as MediaFilter))throw new Error('Choose a post type');
  if(input.readOnly!==undefined&&typeof input.readOnly!=='boolean')throw new Error('Invalid read selection');
  let beforeMs:number|null=null;
  if(input.before!==undefined&&input.before!==''){
    if(typeof input.before!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(input.before))throw new Error('Choose a valid cutoff date');
    beforeMs=Date.parse(input.before+'T00:00:00Z');
    if(!Number.isSafeInteger(beforeMs)||beforeMs<0||new Date(beforeMs).toISOString().slice(0,10)!==input.before)throw new Error('Choose a valid cutoff date');
  }
  return{feed,kind:input.kind as MediaFilter||'',beforeMs,readOnly:input.readOnly!==false};
}
export function storageBreakdown(store:ReaderStore,inventory:MediaInventory[]){
  const feeds=store.storageFeeds().map(feed=>({...feed,bytes:0,exclusiveBytes:0,sharedFiles:0}));
  const byFeed=new Map(feeds.map(feed=>[feed.feed,feed]));
  const types=['image','video','other'].map(kind=>({kind,files:0,bytes:0}));
  let mediaBytes=0,unassignedBytes=0,sharedBytes=0;
  for(const file of inventory){
    mediaBytes+=file.bytes;const type=types.find(type=>type.kind===file.kind)!;type.files++;type.bytes+=file.bytes;
    const owners=[...new Set(file.owners.map(owner=>owner.feed))].sort();
    if(!owners.length){unassignedBytes+=file.bytes;continue;}
    if(owners.length>1)sharedBytes+=file.bytes;
    owners.forEach((name,index)=>{
      const feed=byFeed.get(name)!;
      feed.bytes+=Math.floor(file.bytes/owners.length)+(index<file.bytes%owners.length?1:0);
      if(owners.length===1)feed.exclusiveBytes+=file.bytes;else feed.sharedFiles++;
    });
  }
  const databaseBytes=store.stats().databaseBytes;
  return{databaseBytes,mediaBytes,totalBytes:databaseBytes+mediaBytes,unassignedBytes,sharedBytes,types,feeds};
}
export type LibraryStorage=ReturnType<typeof storageBreakdown>;
export function cleanupPreview(store:ReaderStore,inventory:MediaInventory[],criteria:CleanupCriteria){
  const ids=store.cleanupIds(criteria),selected=new Set(ids);let files=0,bytes=0,sharedFilesKept=0;
  for(const file of inventory){
    if(!file.owners.some(owner=>selected.has(owner.postId)))continue;
    if(file.owners.every(owner=>selected.has(owner.postId))){files++;bytes+=file.bytes;}else sharedFilesKept++;
  }
  return{ids,posts:ids.length,files,reclaimableBytes:bytes,sharedFilesKept,criteria,
    examples:ids.slice(0,10).map(id=>{const post=store.getPost(id)!;return{id,title:post.title,feed:post.subreddit};})};
}
export type CleanupPreview=Omit<ReturnType<typeof cleanupPreview>,'ids'>&{id:string};
