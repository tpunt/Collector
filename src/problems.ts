import {mkdirSync,readFileSync,renameSync,statSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {feedIdentity,feedName,EXTERNAL_ATTACHMENT_NOTE,diagnosticPage} from './sources.ts';
import {postId} from './domain.ts';
import {ExtractionError,PostIdentityError} from './sync-errors.ts';

export const PROBLEM_MESSAGES={
  'listing-layout':'The website listing layout was not recognised. Collection paused; checkpoint kept.',
  'listing-records':'Some posts could not be parsed. Collection paused; page checkpoint kept for retry.',
  'pagination':'The next-page link was invalid. Collection paused; checkpoint kept.',
  'post-identity':'The displayed post did not match the requested post. Collection paused.',
  'post-content':'Full post text or media could not be extracted. Sync remains incomplete.',
  'access':'The website denied access or requires sign-in/verification. Collection paused.',
  'download':'A media download failed or a file was unavailable. Check the feed before resuming.',
  'archive-response':'The archive service request failed or its response changed. Checkpoint kept.',
  'archive-records':'Some archive records were invalid and were omitted. See the import counters.',
  'import':'Archive file processing failed. Import progress is shown separately.',
  'collection':'Collection encountered an unexpected problem. Check the feed status before resuming.',
  'runtime':'Collector encountered an internal error.',
} as const;
export type ProblemCode=keyof typeof PROBLEM_MESSAGES;
export interface ExtractionFacts {rows?:number;accepted?:number;rejected?:number;missingFields?:string[];selector?:string;emptyMarker?:boolean;nextPresent?:boolean;expectedId?:string;visibleIds?:string[]}
export interface ProblemContext {operation:string;feed?:string|null;post?:string|null;url?:string|null;checkpoint?:string|null;code?:ProblemCode;facts?:ExtractionFacts;occurrences?:number}
export type ProblemReporter=(context:ProblemContext,error:unknown)=>void;
export interface ProblemSample {post?:string;url?:string;checkpoint?:string;facts?:ExtractionFacts;error:{type:string;code?:string;httpStatus?:number;stack:string[]}}
export interface ProblemRecord {id:string;code:ProblemCode;operation:string;platform?:string;feed?:string;firstAt:number;lastAt:number;count:number;seen:number;samples:ProblemSample[]}
const FIELDS=new Set(['id','title','datetime','permalink','subreddit','body','next','account','sort','posts','attachments','post-cards']);
const bounded=(value:unknown,max=Number.MAX_SAFE_INTEGER)=>Number.isSafeInteger(value)&&Number(value)>=0?Math.min(Number(value),max):undefined;
const identity=(value:unknown)=>{try{return typeof value==='string'?postId(value):undefined;}catch{return undefined;}};
function facts(input:ExtractionFacts|undefined):ExtractionFacts|undefined {
  if(!input||typeof input!=='object')return;
  const value:ExtractionFacts={};
  for(const key of ['rows','accepted','rejected'] as const)if(bounded(input[key])!==undefined)value[key]=bounded(input[key]);
  if(Array.isArray(input.missingFields))value.missingFields=[...new Set(input.missingFields.filter(field=>FIELDS.has(field)))].slice(0,11);
  if(typeof input.selector==='string'&&['#siteTable','.thing[data-fullname^="t3_"]','.tabmenu .selected','article,[data-post-id],.post[id]'].includes(input.selector))value.selector=input.selector;
  for(const key of ['emptyMarker','nextPresent'] as const)if(typeof input[key]==='boolean')value[key]=input[key];
  if(identity(input.expectedId))value.expectedId=identity(input.expectedId);
  if(Array.isArray(input.visibleIds))value.visibleIds=input.visibleIds.map(identity).filter((id):id is string=>Boolean(id)).slice(0,5);
  return Object.keys(value).length?value:undefined;
}

function classify(error:unknown,context:ProblemContext):ProblemCode|null {
  const item=error as Error,message=typeof item?.message==='string'?item.message.slice(0,2000):'',name=item?.constructor?.name;
  if(name==='StorageLimitError'||item?.name==='AbortError'||message.startsWith('Offline mode is on')||message===EXTERNAL_ATTACHMENT_NOTE||message.startsWith('Offline download is not supported'))return null;
  if(['SyncLimitError','AccessError'].includes(name??'')&&/budget|storage (limit|cap)/i.test(message))return null;
  if(context.code)return context.code;
  if(error instanceof ExtractionError)return error.code;
  if(error instanceof PostIdentityError)return 'post-identity';
  if(name==='AccessError'&&context.operation==='download'&&/network request failed/i.test(message))return 'download';
  if(name==='AccessError'||/sign.in|account header|denied access|verification|returned (403|429)/i.test(message))return 'access';
  if(/layout|theme.*recognis|expected.*listing/i.test(message))return 'listing-layout';
  if(/pagination|next.*url|listing url/i.test(message))return 'pagination';
  return context.operation==='download'?'download':context.operation.startsWith('archive')?'archive-response':context.operation==='import'?'import':context.operation==='request'?'runtime':context.operation==='body'?'post-content':'collection';
}
function errorInfo(error:unknown):ProblemSample['error'] {
  const item=error as Error&{code?:unknown;cause?:{code?:unknown}},name=item?.constructor?.name??'Error';
  const type=/^(Error|TypeError|RangeError|SyntaxError|TimeoutError|AccessError|ExtractionError|PostIdentityError|UnsupportedMediaError|SyncLimitError|StorageLimitError|DOMException)$/.test(name)?name:'Error';
  const message=typeof item?.message==='string'?item.message.slice(0,2000):'';
  const rawCode=item?.code??item?.cause?.code??/\bnet::(ERR_[A-Z0-9_]{1,40})\b/.exec(message)?.[1],code=typeof rawCode==='string'&&/^(?:E[A-Z0-9_]{1,40}|ERR_[A-Z0-9_]{1,40})$/.test(rawCode)?rawCode:undefined;
  const status=/\b(?:HTTP|returned|status|access)\s*[:(]?\s*([45][0-9]{2})\b/i.exec(message);
  const stack=[...new Set((typeof item?.stack==='string'?item.stack.slice(0,16000):'').split('\n').flatMap(line=>{const match=/\/(src\/[a-z0-9-]+\.ts):([0-9]+):([0-9]+)/.exec(line);return match?[`${match[1]}:${match[2]}:${match[3]}`]:[];}))].slice(0,5);
  return{type,code,httpStatus:status?Number(status[1]):undefined,stack};
}

/** Problem-only snapshots, bounded on disk and in memory. Counters update for
 * every occurrence; repeated writes are coalesced, never individual row logs. */
export class ProblemLog {
  readonly path:string;
  private records:ProblemRecord[]=[];
  private dropped=0;
  private writeError:string|null=null;
  private dirty=false;
  private timer:ReturnType<typeof setTimeout>|null=null;
  private writes:number[]=[];
  private lastWrite=0;
  private closed=false;
  private now:()=>number;
  private interval:number;
  private maxBytes:number;
  private maxEntries:number;
  private burst:number;
  constructor(directory:string,options:{now?:()=>number;intervalMs?:number;maxBytes?:number;maxEntries?:number;burst?:number}={}){
    this.path=join(directory,'problems.json');this.now=options.now??Date.now;this.interval=options.intervalMs??60_000;this.maxBytes=options.maxBytes??256*1024;this.maxEntries=options.maxEntries??200;this.burst=options.burst??20;
    if(!Number.isSafeInteger(this.maxBytes)||this.maxBytes<1024||!Number.isSafeInteger(this.maxEntries)||this.maxEntries<1||!Number.isSafeInteger(this.interval)||this.interval<1||!Number.isSafeInteger(this.burst)||this.burst<1)throw new Error('Invalid problem log bounds');
    try{
      if(statSync(this.path).size>this.maxBytes)throw new Error('oversized');
      const file=JSON.parse(readFileSync(this.path,'utf8'));
      if(file.version!==1||!Array.isArray(file.records)||file.records.length>this.maxEntries)throw new Error('format');
      this.dropped=bounded(file.dropped)??0;
      for(const row of file.records){
        if(!row||!Object.hasOwn(PROBLEM_MESSAGES,row.code)||!/^[a-f0-9-]{36}$/.test(row.id)||typeof row.operation!=='string'||!/^[a-z-]{1,40}$/.test(row.operation)||bounded(row.count)===undefined||row.count<1||bounded(row.seen)===undefined||row.seen>row.count||bounded(row.firstAt)===undefined||bounded(row.lastAt)===undefined||!Array.isArray(row.samples))throw new Error('record');
        let feed:string|undefined;try{if(row.feed)feed=feedName(row.feed);}catch{throw new Error('feed');}
        const samples:ProblemSample[]=row.samples.slice(0,3).map((sample:ProblemSample)=>({post:identity(sample.post),url:diagnosticPage(sample.url),checkpoint:typeof sample.checkpoint==='string'&&/^[a-f0-9-]{36}$/.test(sample.checkpoint)?sample.checkpoint:undefined,facts:facts(sample.facts),error:{type:/^[A-Za-z]{1,30}$/.test(sample.error?.type)?sample.error.type:'Error',code:typeof sample.error?.code==='string'&&/^(?:E[A-Z0-9_]{1,40}|ERR_[A-Z0-9_]{1,40})$/.test(sample.error.code)?sample.error.code:undefined,httpStatus:bounded(sample.error?.httpStatus,599),stack:Array.isArray(sample.error?.stack)?sample.error.stack.filter(line=>/^src\/[a-z0-9-]+\.ts:[0-9]+:[0-9]+$/.test(line)).slice(0,5):[]}}));
        this.records.push({id:row.id,code:row.code,operation:row.operation,platform:feed?feedIdentity(feed).platform:undefined,feed,firstAt:row.firstAt,lastAt:row.lastAt,count:row.count,seen:row.seen,samples});
      }
    }catch(error){this.records=[];if((error as NodeJS.ErrnoException).code!=='ENOENT')this.writeError='The saved problem log could not be read. New problems are kept in memory until it can be saved.';}
  }
  report:ProblemReporter=(context,error)=>{
    if(this.closed)return;
    const code=classify(error,context);if(!code)return;
    let feed:string|undefined;try{if(context.feed)feed=feedName(context.feed);}catch{/* Never store arbitrary labels. */}
    const operation=/^[a-z-]{1,40}$/.test(context.operation)?context.operation:'collection',now=this.now();
    const key=(row:ProblemRecord)=>row.code===code&&row.operation===operation&&row.feed===feed;
    let row=this.records.find(key),fresh=!row;
    if(!row){row={id:randomUUID(),code,operation,feed,platform:feed?feedIdentity(feed).platform:undefined,firstAt:now,lastAt:now,count:0,seen:0,samples:[]};this.records.push(row);}
    row.lastAt=Math.max(row.lastAt,now);row.count=Math.min(Number.MAX_SAFE_INTEGER,row.count+Math.max(1,bounded(context.occurrences)??1));
    const sample:ProblemSample={post:identity(context.post),url:diagnosticPage(context.url),checkpoint:context.checkpoint&&/^[a-f0-9-]{36}$/.test(context.checkpoint)?context.checkpoint:undefined,facts:facts(context.facts??(error instanceof ExtractionError?error.facts:error instanceof PostIdentityError?{expectedId:error.expectedId,visibleIds:error.visibleMainIds}:undefined)),error:errorInfo(error)};
    if(row.samples.length<3&&!row.samples.some(previous=>JSON.stringify(previous)===JSON.stringify(sample)))row.samples.push(sample);
    this.records=this.records.filter(previous=>previous!==row);this.records.unshift(row);this.records.sort((a,b)=>b.lastAt-a.lastAt);while(this.records.length>this.maxEntries){this.records.pop();this.dropped++;}this.dirty=true;
    if(fresh||now-this.lastWrite>=this.interval)this.flush();else this.schedule();
  };
  private schedule(){if(!this.closed&&!this.timer){this.timer=setTimeout(()=>{this.timer=null;this.flush();},Math.max(1,this.interval-(this.now()-this.lastWrite)));this.timer.unref();}}
  private flush(force=false){
    if(!this.dirty)return;
    const now=this.now();this.writes=this.writes.filter(at=>now-at<this.interval);
    if(!force&&this.writes.length>=this.burst){if(this.timer)clearTimeout(this.timer);this.timer=setTimeout(()=>{this.timer=null;this.flush();},Math.max(1,this.writes[0]!+this.interval-now));this.timer.unref();return;}
    const serialize=()=>JSON.stringify({version:1,app:'Collector',runtime:{node:process.version},dropped:this.dropped,records:this.records});
    while(this.records.length>this.maxEntries||Buffer.byteLength(serialize())>this.maxBytes){this.records.pop();this.dropped++;}
    this.lastWrite=now;this.writes.push(now);
    try{
      mkdirSync(join(this.path,'..'),{recursive:true,mode:0o700});writeFileSync(this.path+'.tmp',serialize(),{mode:0o600});renameSync(this.path+'.tmp',this.path);
      this.dirty=false;this.writeError=null;
    }catch{this.writeError='The problem log could not be saved. Problems are still visible in this session.';this.lastWrite=now;this.schedule();}
  }
  get status(){return{path:this.path,groups:this.records.length,unseen:this.records.reduce((sum,row)=>sum+row.count-row.seen,0),dropped:this.dropped,writeError:this.writeError,maxBytes:this.maxBytes,maxEntries:this.maxEntries};}
  list(){return{...this.status,app:'Collector',runtime:{node:process.version},records:structuredClone(this.records).map(row=>({...row,message:PROBLEM_MESSAGES[row.code]}))};}
  acknowledge(selection:{id:string;count:number}[]){
    if(!Array.isArray(selection)||selection.length>this.maxEntries||selection.some(row=>!row||typeof row.id!=='string'||!/^[a-f0-9-]{36}$/.test(row.id)||bounded(row.count)===undefined))throw new Error('Invalid displayed problem selection');
    let changed=false;
    for(const selected of selection){const row=this.records.find(row=>row.id===selected.id);if(row&&Math.min(row.count,selected.count)>row.seen){row.seen=Math.min(row.count,selected.count);changed=true;}}
    if(changed){this.dirty=true;this.flush(true);}
  }
  close(){this.closed=true;if(this.timer)clearTimeout(this.timer);this.timer=null;this.flush(true);}
}
