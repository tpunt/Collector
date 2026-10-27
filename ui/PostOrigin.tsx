import React from 'react';

export interface PostOriginInfo {
  platform:{id:string;label:string};
  feed:{id:string;label:string};
}

/** Shared post metadata receives platform/feed labels from its collector. */
export function PostOrigin({origin,onSelectFeed}:{origin:PostOriginInfo;onSelectFeed?:(origin:PostOriginInfo)=>void}){
  return <span className="post-origin" data-platform={origin.platform.id}><span className="post-platform">{origin.platform.label}</span>{onSelectFeed?<button type="button" onClick={()=>onSelectFeed(origin)}>{origin.feed.label}</button>:<span className="post-feed-label">{origin.feed.label}</span>}</span>;
}
