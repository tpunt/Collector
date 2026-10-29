import type {HistoryTarget} from './store.ts';
import {TUMBLR_DAY,tumblrSearchUrl,tumblrBlog} from './sources.ts';
import {postId} from './domain.ts';

export interface TumblrRange {lower:number;upper:number}
type Outcome='query'|'checked'|'split'|'unverified'|'capped'|'listing';
export interface TumblrHistoryCheckpoint {
  kind:'tumblr-dated-search';version:1;scopeLower:number;scopeUpper:number;
  cursor:number;pending:TumblrRange[];
  active:{range:TumblrRange|null;ids:string[];outcome:Outcome}|null;
  queries:number;checked:number;unverified:number;capped:number;oldestChecked:number|null;
}
export interface HistoryDiscovery {
  method:'dated-search';queries:number;checkedWindows:number;unverifiedWindows:number;cappedWindows:number;
  oldestChecked:number|null;remainingWindows:number;currentLower:number|null;currentUpper:number|null;finished:boolean;
}
const floor=(time:number)=>Math.floor(time/TUMBLR_DAY)*TUMBLR_DAY;
const ceiling=(time:number)=>Math.floor(time/TUMBLR_DAY)*TUMBLR_DAY+TUMBLR_DAY;
// Include adjacent calendar days for exact-day searches too. Their website
// timezone can differ from UTC; only posts inside the actual target are saved.
const lowerDay=(time:number)=>Math.max(0,floor(time)-TUMBLR_DAY);
const upperDay=(time:number)=>ceiling(time)+TUMBLR_DAY;
export function newTumblrHistory(target:HistoryTarget,listingIds:string[]=[]):TumblrHistoryCheckpoint {
  return{kind:'tumblr-dated-search',version:1,scopeLower:target.lowerMs??0,scopeUpper:target.upperMs,cursor:upperDay(target.upperMs),pending:[],
    active:listingIds.length?{range:null,ids:listingIds,outcome:'listing'}:null,queries:0,checked:0,unverified:0,capped:0,oldestChecked:null};
}
/** The checkpoint is bounded by split depth plus one returned page of IDs.
 * Completed posts live in the normal tables, never an in-memory history set. */
export function tumblrHistoryCheckpoint(target:HistoryTarget):TumblrHistoryCheckpoint|null {
  const raw=target.boundary.source;if(raw===undefined)return null;
  const value=structuredClone(raw) as TumblrHistoryCheckpoint,lower=lowerDay(target.lowerMs??0),upper=upperDay(target.upperMs);
  const integer=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
  const range=(r:any)=>r&&integer(r.lower)&&integer(r.upper)&&r.lower%TUMBLR_DAY===0&&r.upper%TUMBLR_DAY===0&&r.lower>=lower&&r.upper<=upper&&r.lower<r.upper;
  if(!value||value.kind!=='tumblr-dated-search'||value.version!==1||value.scopeLower!==(target.lowerMs??0)||value.scopeUpper!==target.upperMs||!integer(value.cursor)||value.cursor<lower||value.cursor>upper||value.cursor%TUMBLR_DAY||!Array.isArray(value.pending)||value.pending.length>32||!value.pending.every(range)||
    ![value.queries,value.checked,value.unverified,value.capped].every(integer)||value.oldestChecked!==null&&(!integer(value.oldestChecked)||value.oldestChecked<lower||value.oldestChecked>upper))throw new Error('Saved Tumblr history checkpoint is invalid; use Rescan history to restart discovery without deleting posts');
  if(value.active!==null){
    const a=value.active;if(!a||typeof a!=='object'||!['query','checked','split','unverified','capped','listing'].includes(a.outcome)||a.range!==null&&!range(a.range)||a.range===null&&a.outcome!=='listing'||a.range!==null&&a.outcome==='listing'||!Array.isArray(a.ids)||a.ids.length>2000||!a.ids.every(id=>{try{return postId(id)===id&&id.startsWith('tumblr:'+tumblrBlog(target.subreddit)+':');}catch{return false;}}))throw new Error('Saved Tumblr history page is invalid; use Rescan history');
  }
  return value;
}
function annualLower(cursor:number,lower:number){return Math.max(lower,Date.UTC(new Date(cursor-1).getUTCFullYear(),0,1));}
/** Plan before fetching, so a failure never skips the window just taken. */
export function planTumblrWindow(state:TumblrHistoryCheckpoint):TumblrRange|null {
  if(state.active)return state.active.range;
  let range=state.pending.pop();
  if(!range&&state.cursor>lowerDay(state.scopeLower)){range={lower:annualLower(state.cursor,lowerDay(state.scopeLower)),upper:state.cursor};state.cursor=range.lower;}
  if(!range)return null;
  state.active={range,ids:[],outcome:'query'};return range;
}
export function captureTumblrWindow(state:TumblrHistoryCheckpoint,ids:string[],potentiallyCapped:boolean,unverifiedEmpty:boolean){
  const active=state.active;if(!active?.range||active.outcome!=='query')throw new Error('Tumblr search window was not planned');
  active.ids=[...new Set(ids)];
  active.outcome=potentiallyCapped?(active.range.upper-active.range.lower>TUMBLR_DAY?'split':'capped'):unverifiedEmpty?'unverified':'checked';
}
/** Called only after this page's durable text/media work has finished. */
export function finishTumblrWindow(state:TumblrHistoryCheckpoint){
  const active=state.active;if(!active||active.outcome==='query')throw new Error('Tumblr search page is not saved yet');
  if(active.range){
    state.queries++;
    if(active.outcome==='split'){
      const middle=floor((active.range.lower+active.range.upper)/2);
      state.pending.push({lower:active.range.lower,upper:middle},{lower:middle,upper:active.range.upper});
    }else{
      state.checked++;state.oldestChecked=Math.min(state.oldestChecked??Infinity,active.range.lower);
      if(active.outcome==='unverified'||active.outcome==='capped')state.unverified++;
      if(active.outcome==='capped')state.capped++;
    }
  }
  state.active=null;
}
export function tumblrCheckpointUrl(feed:string,state:TumblrHistoryCheckpoint):string|null {
  const range=state.active?.range??state.pending.at(-1)??(state.cursor>lowerDay(state.scopeLower)?{lower:annualLower(state.cursor,lowerDay(state.scopeLower)),upper:state.cursor}:null);
  return range?tumblrSearchUrl(feed,range.lower,range.upper):null;
}
export function tumblrHistorySummary(target:HistoryTarget|null):HistoryDiscovery|null {
  if(!target||!target.subreddit.startsWith('tumblr:'))return null;let state:TumblrHistoryCheckpoint|null;try{state=tumblrHistoryCheckpoint(target);}catch{return null;}if(!state)return null;
  let cursor=state.cursor,remaining=state.pending.length+Number(Boolean(state.active));
  while(cursor>lowerDay(state.scopeLower)){cursor=annualLower(cursor,lowerDay(state.scopeLower));remaining++;}
  return{method:'dated-search',queries:state.queries,checkedWindows:state.checked,unverifiedWindows:state.unverified,cappedWindows:state.capped,oldestChecked:state.oldestChecked,
    remainingWindows:remaining,currentLower:state.active?.range?.lower??null,currentUpper:state.active?.range?.upper??null,finished:remaining===0};
}
export function tumblrHistoryReason(state:TumblrHistoryCheckpoint){return `Dated search finished: ${state.checked} date ${state.checked===1?'window':'windows'} checked${state.unverified?`, ${state.unverified} unverified`:''}${state.capped?`, ${state.capped} daily result limits`:''}. Tumblr search indexing can omit posts, including reblogs without added content and many pre-2017 posts; complete coverage is not verified.`;}
