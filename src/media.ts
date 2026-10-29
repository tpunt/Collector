import {hasExternalAttachment,EXTERNAL_ATTACHMENT_NOTE,UNSUPPORTED_ATTACHMENT_NOTE,externalAttachmentNote,feedIdentity} from './sources.ts';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile, open } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import type { ReaderStore } from './store.ts';
import type { MediaReference } from './media-reference.ts';
import { isGallery,completeCollection,mediaReference,isRemovedMediaPlaceholder } from './media-reference.ts';
import { RequestQueue } from './request-gate.ts';
import { AccessError } from './browser.ts';
import { retryAfter } from './limiter.ts';
import { spawn } from 'node:child_process';
import { dashMedia } from './dash.ts';
import { SyncLimitError, UnsupportedMediaError } from './sync-errors.ts';
import {mediaKey} from './media-key.ts';
import {postId} from './domain.ts';
export {mediaKey} from './media-key.ts';

interface Cached { key: string; type: string; bytes: number }
interface Task { postId: string; subreddit:string; revision:number; reference: MediaReference; generation: number; controller: AbortController; started?:boolean; pending?:Promise<unknown> }
export interface MediaItem { key: string; kind: 'image' | 'video'; state: 'idle' | 'queued' | 'loading' | 'ready' | 'error'; url: string | null; localPath: string | null; message?: string;caption?:string }
export interface MediaInventory {key:string;kind:'image'|'video'|'other';bytes:number;owners:{postId:string;feed:string}[]}
export interface MediaDependencies { directory: string; queue: RequestQueue; fetch?: typeof fetch; onAccess: (error: AccessError) => void; maxRequests?: number; maxBytes?: number; onSaved?:(feed:string,bytes:number)=>void }

/** Public observed media shares the owning platform's browser request lane. */
export class MediaCache {
  private store: ReaderStore;
  private options: MediaDependencies;
  private cached = new Map<string, Cached>();
  private tasks = new Map<string, Task>();
  private states = new Map<string, {subreddit:string;state: 'queued' | 'loading' | 'error'; message?: string; permanent?:boolean; pause?:boolean}>();
  private pending = new Set<Promise<unknown>>();
  private ready: Promise<void>;
  private pruning:Promise<void>|null=null;
  private reconciledRevision:string|null=null;
  private bytes = 0;
  private metadataBytes = 0;
  private diskFiles = new Map<string,number>();
  private requests = 0;
  private budget: number;
  constructor(store: ReaderStore, options: MediaDependencies) {
    this.store = store; this.options = options; this.budget = options.maxRequests ?? 40;
    this.store.setExternalStorageUsage(()=>this.bytes+this.metadataBytes);
    this.ready = this.load();
    // Observe eager I/O failures until the owner awaits initialize/close.
    void this.ready.catch(()=>{});
  }
  private async load() {
    await mkdir(this.options.directory, {recursive:true, mode:0o700});
    for (const name of await readdir(this.options.directory)) {
      if (name.endsWith('.part')) { await rm(join(this.options.directory,name),{force:true}); continue; }
      if (/^[a-f0-9]{64}(\.json)?$/.test(name)) {
        const file=await stat(join(this.options.directory,name));
        if(!file.isFile())continue;
        this.diskFiles.set(name,file.size);
        if(name.endsWith('.json'))this.metadataBytes+=file.size;else this.bytes+=file.size;
      }
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      try {
        const metadata=await readFile(join(this.options.directory,name),'utf8');
        const data = JSON.parse(metadata) as Cached;
        if (data.key !== name.slice(0,-5) || !/^(image\/(jpeg|png|gif|webp|avif)|video\/(mp4|webm))$/.test(data.type)) continue;
        const file = await stat(join(this.options.directory,data.key));
        if (!file.isFile() || file.size !== data.bytes || data.bytes <= 0) continue;
        this.cached.set(data.key,data);
      } catch { /* Incomplete cache entries are unavailable, never served. */ }
    }
  }
  get status() { return {requests:this.requests,bytes:this.bytes,pending:this.tasks.size,revision:this.store.mediaSyncRevision}; }
  async backupFiles():Promise<string[]> {
    await this.ready;
    return [...this.cached.keys()].filter(key=>this.store.hasMediaOwner(key)).flatMap(key=>[key,key+'.json']);
  }
  async inventory():Promise<MediaInventory[]> {
    await this.ready;
    for(const [name,previous] of [...this.diskFiles]){
      const key=name.replace(/\.json$/,''),cached=this.cached.get(key);
      const active=()=>{for(const taskKey of this.tasks.keys())if(taskKey.endsWith(':'+key))return true;return false;};
      if(active())continue;
      let bytes:number|undefined;
      try{const file=await stat(join(this.options.directory,name));if(file.isFile())bytes=file.size;}
      catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      // A completed download may have published a replacement while stat was
      // pending. Never overwrite its newer accounting with the earlier result.
      if(active()||this.diskFiles.get(name)!==previous||this.cached.get(key)!==cached)continue;
      if(bytes===undefined)this.diskFiles.delete(name);else this.diskFiles.set(name,bytes);
      if(name.endsWith('.json'))this.metadataBytes+=(bytes??0)-previous;else this.bytes+=(bytes??0)-previous;
    }
    const keys=new Set([...this.cached.keys(),...[...this.diskFiles.keys()].map(name=>name.replace(/\.json$/,''))]),result:MediaInventory[]=[];
    for(const key of keys){
      const owners=this.store.mediaOwners(key),saved=this.cached.get(key);
      if(saved&&(this.diskFiles.get(key)!==saved.bytes||!(this.diskFiles.get(key+'.json')??0))){
        this.cached.delete(key);
        for(const taskKey of this.states.keys())if(taskKey.endsWith(':'+key)&&!this.tasks.has(taskKey))this.states.delete(taskKey);
        for(const owner of owners){const state=this.store.mediaSync(owner.postId);if(state?.status==='ready'||[EXTERNAL_ATTACHMENT_NOTE,UNSUPPORTED_ATTACHMENT_NOTE].includes(state?.reason??''))this.store.setMediaSync(this.store.generation,owner.postId,'pending','Saved media changed or is missing; Sync to save it again');}
      }
      const bytes=(this.diskFiles.get(key)??0)+(this.diskFiles.get(key+'.json')??0),current=this.cached.get(key);
      if(bytes)result.push({key,kind:current?.type.startsWith('image/')?'image':current?.type.startsWith('video/')?'video':'other',bytes,owners});
    }
    return result;
  }
  async clearPosts(ids:string[],keys:string[]){
    const selected=new Set(ids);
    for(const task of this.tasks.values())if(selected.has(task.postId))task.controller.abort();
    await this.clearMatching(task=>selected.has(task.postId),key=>selected.has(key.slice(0,key.lastIndexOf(':'))),keys);
    await this.reconcile();
  }
  async reload(){
    await this.close();this.cached.clear();this.states.clear();this.diskFiles.clear();this.bytes=0;this.metadataBytes=0;this.reconciledRevision=null;
    this.ready=this.load();await this.initialize();
  }
  async initialize() {
    await this.ready;
    await this.reconcile();
    // These were implementation limits, not evidence that a remote file vanished.
    for(const post of this.store.implementationLimitedMedia())this.store.setMediaSync(this.store.generation,post,'pending','Collector support changed; Sync to retry this file');
    for(const id of [...this.store.readyMediaIds()]){
      const post=this.store.getPost(id);
      if(post?.source==='live'&&post.bodySync?.status==='ready'&&!post.attachments.length&&hasExternalAttachment(post)){this.store.setMediaSync(this.store.generation,id,'unavailable',externalAttachmentNote(post));continue;}
      const saved=Boolean(post?.attachments.length&&post.attachments.every(item=>this.cached.has(mediaKey(item)))&&(!isGallery(post.outbound)||completeCollection('reddit:'+post.id,post.attachments)));
      if(saved)this.store.setMediaSync(this.store.generation,id,hasExternalAttachment(post!)?'unavailable':'ready',hasExternalAttachment(post!)?externalAttachmentNote(post!):null);
      else this.store.setMediaSync(this.store.generation,id,'pending','Saved media is incomplete; sync to download it again');
    }
  }
  async reconcile() {
    await this.ready;
    while(this.pruning)await this.pruning;
    const revision=`${this.store.generation}:${this.store.contentRevision}`;
    if(this.reconciledRevision===revision)return;
    const keys=[...new Set([...this.diskFiles.keys()].map(name=>name.replace(/\.json$/,'')))].filter(key=>!this.store.hasMediaOwner(key));
    const cleanup=this.clearMatching(task=>!this.store.hasMediaOwner(mediaKey(task.reference),task.postId),key=>keys.some(asset=>key.endsWith(':'+asset)),keys);
    this.pruning=cleanup;
    try{await cleanup;this.reconciledRevision=revision;}finally{if(this.pruning===cleanup)this.pruning=null;}
  }
  pendingPosts(source:string,session:string):string[] { return this.store.pendingMedia(source,session); }
  preparePost(id:string,session:string):{discover:boolean}|null {
    const post=this.store.getPost(id),previous=this.store.mediaSync(id);
    if(!post||post.availability!=='available'||!previous)return null;
    const gallery=isGallery(post.outbound),rediscover=Boolean(previous.reason?.startsWith('Media URL expired'));
    if(previous.status==='unavailable'&&!(gallery&&previous.reason?.startsWith('Complete gallery downloads')))return null;
    if(post.source==='live'&&post.bodySync?.status==='ready'&&!post.attachments.length&&hasExternalAttachment(post)){this.store.setMediaSync(this.store.generation,id,'unavailable',externalAttachmentNote(post),session);return null;}
    if(post.attachments.length&&post.attachments.every(item=>this.cached.has(mediaKey(item)))&&(!gallery||completeCollection('reddit:'+post.id,post.attachments))){
      this.store.setMediaSync(this.store.generation,id,hasExternalAttachment(post)?'unavailable':'ready',hasExternalAttachment(post)?externalAttachmentNote(post):null,session);return null;
    }
    if(gallery&&(!completeCollection('reddit:'+post.id,post.attachments)||rediscover)){
      this.store.setMediaSync(this.store.generation,id,'downloading',rediscover?previous.reason:null,session);return {discover:true};
    }
    if(!post.attachments.length&&post.outbound&&!['reddit.com','www.reddit.com','old.reddit.com','v.redd.it'].includes(new URL(post.outbound).hostname)){
      this.store.setMediaSync(this.store.generation,id,'unavailable','Offline download is not supported for this embedded provider',session);return null;
    }
    this.store.setMediaSync(this.store.generation,id,'downloading',rediscover?previous.reason:null,session);
    return {discover:!post.attachments.length||rediscover};
  }
  async syncPost(id:string,session:string,allowance:number,signal:AbortSignal) {
    signal.throwIfAborted();
    await this.reconcile();signal.throwIfAborted();
    this.budget=this.requests+allowance;
    this.store.setMediaSync(this.store.generation,id,'downloading',null,session);
    // Drain bounded batches so a large post is not cut off by the in-memory queue.
    let retry=true;
    while(true){
      await this.enqueue(id,retry,signal);retry=false;
      await Promise.all([...this.pending]);signal.throwIfAborted();
      const batch=await this.items(id);
      const interrupted=batch.some(item=>item.state==='error'&&(this.states.get(`${postId(id)}:${item.key}`)?.pause||/fetch failed|ENETUNREACH|ENOTFOUND|ECONN|request budget|storage (limit|cap)|ENOSPC/i.test(item.message??'')));
      if(interrupted||!batch.some(item=>item.state==='idle'))break;
    }
    const items=await this.items(id),failures=items.filter(item=>item.state==='error');
    const failureState=(item:MediaItem)=>this.states.get(`${postId(id)}:${item.key}`);
    for(const failure of failures){
      if(failureState(failure)?.pause)throw new SyncLimitError(failure.message??'Media saving interrupted');
      if(/fetch failed|ENETUNREACH|ENOTFOUND|ECONN/i.test(failure.message??''))throw new SyncLimitError('Media network request failed; sync paused. Resume when connected.');
      if(/request budget|storage (limit|cap)|ENOSPC/i.test(failure.message??''))throw new SyncLimitError(failure.message);
    }
    const retryable=failures.find(item=>!failureState(item)?.permanent);
    if(retryable)throw new Error(retryable.message??'Media download failed');
    if(failures.length&&items.every(item=>item.state==='ready'||item.state==='error'))throw new UnsupportedMediaError(failures[0]!.message??'Media is unavailable');
    if(!items.length||items.some(item=>item.state!=='ready'))throw new Error('Media files were not saved');
    if(hasExternalAttachment(this.store.getPost(id)!))throw new UnsupportedMediaError(externalAttachmentNote(this.store.getPost(id)!));
    this.store.setMediaSync(this.store.generation,id,'ready',null,session);
  }
  async view(id:string) {return {items:await this.items(id),sync:this.store.mediaSync(id)};}
  feedStatus(name: string): 'syncing' | 'queued' | 'idle' {
    const tasks=[...this.tasks.entries()].filter(([,task])=>task.subreddit===name);
    return tasks.some(([key])=>this.states.get(key)?.state==='loading')?'syncing':tasks.length?'queued':'idle';
  }
  async items(postId: string): Promise<MediaItem[]> {
    await this.ready;
    const post = this.store.getPost(postId);
    if (!post || post.availability !== 'available') return [];
    return post.attachments.map(reference => {
      const key = mediaKey(reference), saved = this.cached.get(key), state = this.states.get(`${post.id}:${key}`);
      return {key,kind:reference.kind,caption:reference.caption,state:saved?'ready':state?.state??'idle',message:state?.message,
        url:saved?`/media/${post.id}/${key}`:null,localPath:saved?join(this.options.directory,key):null};
    });
  }
  async enqueue(postId: string, retry = false, signal?:AbortSignal) {
    await this.ready;
    const post = this.store.getPost(postId);
    if (!post || post.availability !== 'available' || !this.store.followedSources().includes(post.subreddit)) throw new Error('Media post is unavailable');
    postId=post.id;
    if (!signal && retry && this.requests + (post.attachments.some(item=>/\.mpd(?:\?|$)/i.test(item.url))?3:post.attachments.some(item=>item.audioUrl)?2:1) > this.budget) this.budget = this.requests + (this.options.maxRequests ?? 40);
    for (const reference of post.attachments) {
      const key = mediaKey(reference), taskKey = `${postId}:${key}`;
      if (this.cached.has(key) || this.tasks.has(taskKey) || (!retry && this.states.has(taskKey))) continue;
      if (this.tasks.size >= 40) break;
      const task: Task = {postId,subreddit:post.subreddit,revision:this.store.sourceRevision(post.subreddit),reference,generation:this.store.generation,controller:new AbortController()};
      const abort=()=>task.controller.abort();
      signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
      this.tasks.set(taskKey,task); this.states.set(taskKey,{subreddit:post.subreddit,state:'queued'});
      const pending=this.options.queue.run(async () => {
        task.started=true;
        this.assertCurrent(task);
        if (this.cached.has(key)) return;
        if (this.requests+(/\.mpd(?:\?|$)/i.test(reference.url)?3:reference.audioUrl?2:1)>this.budget) throw new Error('Sync request budget reached; Resume to save remaining media.');
        this.states.set(taskKey,{subreddit:post.subreddit,state:'loading'});
        await this.download(task,key);
      },task.controller.signal,feedIdentity(post.subreddit).platform).catch(error => {
        if(this.tasks.get(taskKey)===task&&this.store.generation===task.generation&&this.store.sourceRevision(task.subreddit)===task.revision&&this.store.hasMediaOwner(key,task.postId))
          this.states.set(taskKey,{subreddit:post.subreddit,state:'error',permanent:!task.controller.signal.aborted&&error instanceof UnsupportedMediaError,pause:error instanceof SyncLimitError,message:task.controller.signal.aborted?'Media loading stopped.':error instanceof Error?error.message:'Media download failed.'});
      }).finally(()=>{signal?.removeEventListener('abort',abort);if(this.tasks.get(taskKey)===task)this.tasks.delete(taskKey);this.pending.delete(pending);});
      this.pending.add(pending);
      task.pending=pending;
    }
    return this.items(postId);
  }
  private assertCurrent(task: Task) {
    this.options.queue.assertOnline();
    task.controller.signal.throwIfAborted();
    const post = this.store.getPost(task.postId);
    if (this.store.generation !== task.generation || this.store.sourceRevision(task.subreddit)!==task.revision || post?.availability !== 'available' || !post.attachments.some(item=>mediaKey(item)===mediaKey(task.reference))
      || !this.store.followedSources().includes(post.subreddit)) throw new Error('Media was removed or cleared');
    if (this.store.getSetting('accessPause')) throw new Error('Collection is paused. Resume to revalidate access first.');
    if(feedIdentity(task.subreddit).platform==='tumblr'&&this.store.getSetting('accessPause:tumblr'))throw new Error('Tumblr collection is paused. Resume Tumblr to revalidate access first.');
  }
  private async response(task:Task,url:string,accept:string) {
    const visited=new Set<string>();
    while(true){
      if(isRemovedMediaPlaceholder(url))throw new UnsupportedMediaError('Media was removed by its host');
      if(visited.has(url)||visited.size>=5)throw new Error('Media redirect did not reach a file; Resume to retry');
      visited.add(url);
      this.assertCurrent(task);
      this.store.assertStorageAvailable();
      if(this.requests>=this.budget)throw new Error('Sync request budget reached; Resume to save remaining media.');
      const signal=AbortSignal.any([task.controller.signal,this.options.queue.signal,AbortSignal.timeout(60*60_000)]);
      this.requests++;
      const response=await (this.options.fetch??fetch)(url,{redirect:'manual',signal,headers:{Accept:accept}});
      if([301,302,303,307,308].includes(response.status)){
        const location=response.headers.get('location');await response.body?.cancel();
        let next:string;try{next=new URL(location??'',url).href;}catch{throw new UnsupportedMediaError('Invalid media redirect');}
        if(!location||!mediaReference(next))throw new UnsupportedMediaError('Media redirect leaves supported public file hosts');
        await this.options.queue.waitInterval(task.controller.signal);url=next;continue;
      }
      if([403,429].includes(response.status)){
        await response.body?.cancel();
        // A signed manifest or track may have expired. Persist the need to rediscover
        // its URLs before the global pause aborts this task. Only explicit Resume retries.
        if(response.status===403)
          this.store.setMediaSync(task.generation,task.postId,'failed','Media URL expired or access denied; Resume will rediscover it');
        const platform=feedIdentity(task.subreddit).platform==='tumblr'&&/^(?:[a-z0-9-]+\.)?media\.tumblr\.com$/.test(new URL(url).hostname)?'tumblr':'reddit';const error=new AccessError(`Media host returned ${response.status}; ${platform==='tumblr'?'Tumblr collection paused':'all collection stopped'}`,retryAfter(response.headers.get('retry-after')??undefined),platform);this.options.onAccess(error);throw error;
      }
      if(response.status!==200){await response.body?.cancel();const Failure=[404,410].includes(response.status)?UnsupportedMediaError:Error;throw new Failure(`Media unavailable (HTTP ${response.status}); no automatic retry.`);}
      return response;
    }
  }
  private async manifest(task:Task) {
    const response=await this.response(task,task.reference.url,'application/dash+xml,application/xml');
    if(!/^(application\/(dash\+xml|xml)|text\/xml)(?:;|$)/i.test(response.headers.get('content-type')??'')||!response.body){await response.body?.cancel();throw new Error('Media manifest format could not be read; Resume to rediscover it');}
    const decoder=new TextDecoder('utf-8',{fatal:true});let bytes=0,xml='';
    for await(const chunk of response.body){this.assertCurrent(task);bytes+=chunk.length;if(bytes>512*1024)throw new Error('Media manifest exceeds its parser safety bound; collection is incomplete');xml+=decoder.decode(chunk,{stream:true});}
    xml+=decoder.decode();try{return dashMedia(xml,response.url||task.reference.url);}catch(error){throw new Error(error instanceof Error?error.message:'Media manifest could not be read; Resume to retry');}
  }
  private async downloadFile(task:Task,url:string,path:string,kind:'image'|'video'|'audio') {
    const response=await this.response(task,url,kind==='image'?'image/*':kind==='audio'?'audio/*,video/mp4':'video/*');
    const type=(response.headers.get('content-type')??'').split(';')[0]!.trim().toLowerCase();
    const allowed=kind==='image'?/^image\/(jpeg|png|gif|webp|avif)$/:kind==='audio'?/^(audio|video)\/mp4$/:/^video\/(mp4|webm)$/;
    if(!allowed.test(type)||!response.body){await response.body?.cancel();throw new UnsupportedMediaError('Unsupported media format. Open the post on Reddit.');}
    try{this.store.assertStorageFits(Number(response.headers.get('content-length')??0));}catch(error){await response.body.cancel();throw error;}
    const file=await open(path,'wx',0o600);let bytes=0;
    try{for await(const chunk of response.body){this.assertCurrent(task);bytes+=chunk.length;if(this.bytes+bytes>(this.options.maxBytes??Infinity))throw new Error('Media storage limit reached.');this.store.assertStorageFits(bytes);await file.writeFile(chunk);}if(!bytes)throw new Error('Empty media response; Resume to retry');}
    finally{await file.close();}
    return {type,bytes};
  }
  private async download(task: Task, key: string) {
    const temporary=join(this.options.directory,`${key}.${randomUUID()}.part`),audio=temporary+'.audio.part',muxed=temporary+'.mux.part',metadataTemporary=temporary+'.json.part';
    let published=false,renamed=false;
    try{
      let reference=task.reference;
      if(/\.mpd(?:\?|$)/i.test(reference.url)){reference=await this.manifest(task);await this.options.queue.waitInterval(task.controller.signal);}
      let saved=await this.downloadFile(task,reference.url,temporary,reference.kind),result=temporary;
      if(reference.audioUrl){
        // Hold this source's lane while downloading both tracks. Space the second
        // actual HTTP request from completion too, including in this composite task.
        await this.options.queue.waitInterval(task.controller.signal);
        await this.downloadFile(task,reference.audioUrl,audio,'audio');
        await new Promise<void>((resolve,reject)=>{
          const process=spawn('ffmpeg',['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-i',temporary,'-protocol_whitelist','file,pipe','-i',audio,'-map','0:v:0','-map','1:a:0','-c','copy','-movflags','+faststart','-f','mp4',muxed],{stdio:'ignore',signal:AbortSignal.any([task.controller.signal,AbortSignal.timeout(30_000)])});
          process.on('error',(error:NodeJS.ErrnoException)=>reject(new SyncLimitError(error.code==='ENOENT'?'Reddit video with audio requires FFmpeg on the app’s PATH. Install it, then Resume.':'Video combining was interrupted; sync paused. Resume to retry.')));
          process.on('exit',(code,signal)=>code===0?resolve():reject(signal?new SyncLimitError('Video combining was interrupted; sync paused. Resume to retry.'):new UnsupportedMediaError('Video/audio tracks could not be combined. Open the post on Reddit.')));
        });
        saved={type:'video/mp4',bytes:(await stat(muxed)).size};result=muxed;
        if(this.bytes+saved.bytes>(this.options.maxBytes??Infinity))throw new Error('Media storage limit reached.');
      }
      const entry={key,...saved},metadata=JSON.stringify(entry),metadataBytes=Buffer.byteLength(metadata);
      this.assertCurrent(task);this.store.assertStorageFits(saved.bytes+metadataBytes);
      await rename(result,join(this.options.directory,key));renamed=true;
      await writeFile(metadataTemporary,metadata,{mode:0o600});
      await rename(metadataTemporary,join(this.options.directory,`${key}.json`));
      this.assertCurrent(task);this.store.assertStorageFits(saved.bytes+metadataBytes);
      this.cached.set(key,entry);this.bytes+=saved.bytes-(this.diskFiles.get(key)??0);this.metadataBytes+=metadataBytes-(this.diskFiles.get(key+'.json')??0);
      this.diskFiles.set(key,saved.bytes);this.diskFiles.set(key+'.json',metadataBytes);published=true;this.options.onSaved?.(task.subreddit,saved.bytes);
    }finally{
      await Promise.all([temporary,audio,muxed,metadataTemporary,...(!published&&renamed?[join(this.options.directory,key),join(this.options.directory,`${key}.json`)]:[])].map(path=>rm(path,{force:true})));
      if(!published&&renamed){this.bytes-=this.diskFiles.get(key)??0;this.metadataBytes-=this.diskFiles.get(key+'.json')??0;this.diskFiles.delete(key);this.diskFiles.delete(key+'.json');}
    }
  }
  stop(source?: string) {
    for (const task of this.tasks.values()) if (!source || task.subreddit===source) task.controller.abort();
  }
  stopPost(input:string) {
    const id=postId(input);for(const task of this.tasks.values())if(task.postId===id)task.controller.abort();
  }
  async clearSource(name:string,keys:string[]) {
    this.stop(name);await this.clearMatching(task=>task.subreddit===name,(_key,state)=>state.subreddit===name,keys);
    await this.reconcile();
  }
  async clearPost(input:string,keys:string[]) {
    const id=postId(input);this.stopPost(id);await this.clearMatching(task=>task.postId===id,key=>key.startsWith(id+':'),keys);
    await this.reconcile();
  }
  private async clearMatching(matches:(task:Task)=>boolean,matchesState:(key:string,state:{subreddit:string})=>boolean,keys:string[]) {
    await this.ready;
    const tasks=[...this.tasks.entries()].filter(([,task])=>matches(task));
    // An aborted queued task has never touched disk. Do not make Clear wait for
    // another subreddit's in-flight request ahead of it in the shared queue.
    const cancelled=new Set(tasks.map(([key])=>key));
    for(const [key,task] of tasks){task.controller.abort();if(!task.started)this.tasks.delete(key);}
    await Promise.all(tasks.filter(([,task])=>task.started).map(([,task])=>task.pending));
    for(const [key,state] of this.states)if(cancelled.has(key)||matchesState(key,state))this.states.delete(key);
    for(const key of keys){
      if(this.store.hasMediaOwner(key))continue;
      this.cached.delete(key);
      for(const taskKey of this.states.keys())if(taskKey.endsWith(':'+key))this.states.delete(taskKey);
      await Promise.all([key,key+'.json'].map(async file=>{
        await rm(join(this.options.directory,file),{force:true});
        if(file.endsWith('.json'))this.metadataBytes-=this.diskFiles.get(file)??0;else this.bytes-=this.diskFiles.get(file)??0;
        this.diskFiles.delete(file);
      }));
    }
  }
  async clear() {
    this.stop(); await this.ready;
    // In-flight work is generation checked and aborted; no late write can be published.
    await Promise.all([...this.pending]);
    for (const name of await readdir(this.options.directory)) if (/^[a-f0-9]{64}(\.json)?$/.test(name)) await rm(join(this.options.directory,name),{force:true});
    this.cached.clear();this.states.clear();this.diskFiles.clear();this.bytes=0;this.metadataBytes=0;
  }
  async close() { this.stop();await this.ready;await Promise.all([...this.pending]); }
  async serve(postId: string,key: string,range: string|undefined,res: ServerResponse) {
    await this.ready;
    const post=this.store.getPost(postId),saved=this.cached.get(key);
    if(!post||post.availability!=='available'||!saved||!post.attachments.some(item=>mediaKey(item)===key)) {res.writeHead(404).end();return;}
    try{const file=await stat(join(this.options.directory,key));if(!file.isFile()||file.size!==saved.bytes)throw new Error('Invalid saved media');}
    catch{await this.inventory();res.writeHead(404).end();return;}
    let start=0,end=saved.bytes-1;
    if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match||(!match[1]&&!match[2])){res.writeHead(416,{'Content-Range':`bytes */${saved.bytes}`}).end();return;}
      if(!match[1])start=Math.max(0,saved.bytes-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
      if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=saved.bytes){res.writeHead(416,{'Content-Range':`bytes */${saved.bytes}`}).end();return;}}
    res.writeHead(range?206:200,{'Content-Type':saved.type,'Content-Length':end-start+1,'Accept-Ranges':'bytes','Cache-Control':'no-store',...(range?{'Content-Range':`bytes ${start}-${end}/${saved.bytes}`}:{})});
    const stream=createReadStream(join(this.options.directory,key),{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }
}
