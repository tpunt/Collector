import type {PostOriginInfo} from './PostOrigin.tsx';

/** Current storage/collection is Reddit-specific; keep its display mapping here. */
export const REDDIT_PLATFORM={id:'reddit',label:'Reddit'};
export function redditOrigin(subreddit:string):PostOriginInfo {
  return{platform:REDDIT_PLATFORM,feed:{id:subreddit,label:'r/'+subreddit}};
}
