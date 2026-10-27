import { randomUUID } from 'node:crypto';
import { ReaderBrowser, AccessError } from './browser.ts';
import { readListing, readThread, collectClassicListingDom } from './extract.ts';
import { advanceBoundary } from './history.ts';
import type { ReaderStore } from './store.ts';
import { subredditName,postId } from './domain.ts';
import type { Page } from 'playwright';
import type { RequestQueue } from './request-gate.ts';
import { discoverMedia } from './media-discovery.ts';
import { SyncLimitError, UnsupportedMediaError, PostUnavailableError,PostIdentityError } from './sync-errors.ts';
import { setTimeout as delay } from 'node:timers/promises';

export interface MediaSyncDriver {
  readonly status:{requests:number};
  pendingPosts(source:string,session:string):string[];
  preparePost(id:string,session:string):{discover:boolean}|null;
  syncPost(id:string,session:string,allowance:number,signal:AbortSignal):Promise<void>;
  stop(source?:string):void;
  stopPost?(id:string):void;
  reconcile?():Promise<void>;
}
type Work = ({ id: string; kind: 'target'; targetId: string; head: boolean; deadline: number; generation: number } |
  { id: string; kind: 'thread' | 'media' | 'body'; postId: string; deadline: number; generation: number } |
  {id:string;kind:'media-source'|'body-source';subreddit:string;deadline:number;generation:number}) & {requestBaseline?:number};
export interface JobDependencies {
  network?: RequestQueue;
  mediaSync?:MediaSyncDriver|null;
  onPause?: () => void;
  browser?: Pick<ReaderBrowser, 'counts' | 'open' | 'navigate' | 'close' | 'manualSignIn'> & {mediaCandidates?:string[]};
  discoverMedia?: typeof discoverMedia;
  readListing?: typeof readListing;
  readThread?: typeof readThread;
  readAccount?: (page: Page) => Promise<string | null>;
}
export class ReaderJobs {
  private store: ReaderStore;
  private browser: NonNullable<JobDependencies['browser']>;
  private listing: typeof readListing;
  private discussion: typeof readThread;
  private account: NonNullable<JobDependencies['readAccount']>;
  private queue: Work[] = [];
  private active: Work | null = null;
  private controller: AbortController | null = null;
  private pumping = false;
  private pumpDone:Promise<void>|null=null;
  private mediaSync:MediaSyncDriver|null;
  private session='';
  private stopping = false;
  private manual = false;
  private stoppedWork = new Set<string>();
  private browserOpen = false;
  private mediaMode = false;
  private closing: Promise<void> | null = null;
  private completedRequests = 0;
  private archiveRequestBaseline:number|null=null;
  private feedRuns=new Map<string,string>();
  private message = 'Ready';
  private onPause: () => void;
  private discover: typeof discoverMedia;
  private attemptedBodies=new Set<string>();
  constructor(store: ReaderStore, dependencies: JobDependencies = {}) {
    this.store = store;this.mediaSync=dependencies.mediaSync??null;
    this.onPause = dependencies.onPause ?? (() => {});
    this.discover = dependencies.discoverMedia ?? discoverMedia;
    this.browser = dependencies.browser ?? new ReaderBrowser(error => {
      this.store.setSetting('accessPause', { reason: error.message, notBefore: error.notBefore });
      this.pause(error.message);
    }, dependencies.network);
    this.listing = dependencies.readListing ?? readListing;
    this.discussion = dependencies.readThread ?? readThread;
    this.account = dependencies.readAccount ?? (async page => (await page.evaluate(collectClassicListingDom)).account);
  }
  private sourceOf(work: Work): string | null {
    if('subreddit' in work)return work.subreddit;
    return work.kind === 'target' ? this.store.getTarget(work.targetId)?.subreddit ?? null : this.store.getPost(work.postId)?.subreddit ?? null;
  }
  feedStatus(input: string): 'idle' | 'queued' | 'syncing' | 'stopping' {
    const name = subredditName(input);
    if (this.active && this.sourceOf(this.active) === name) return this.stopping || this.stoppedWork.has(this.active.id) ? 'stopping' : 'syncing';
    return this.queue.some(work => this.sourceOf(work) === name) ? 'queued' : 'idle';
  }
  hasTarget(id:string):boolean{return (this.active?.kind==='target'&&this.active.targetId===id)||this.queue.some(work=>work.kind==='target'&&work.targetId===id);}
  get state() { return { running: this.pumping || this.manual, manual: this.manual, queued: this.queue.length, active: this.manual ? 'sign-in' : this.active?.kind ?? null,
    subreddit: this.active ? this.sourceOf(this.active) : null,
    message: this.message, requests: { ...this.browser.counts, sessionTotal: this.completedRequests + (this.browserOpen ? this.browser.counts.released : 0) },
    accessPause: this.store.getSetting<{reason: string; notBefore: number | null}>('accessPause') }; }
  private allowed(explicitResume: boolean) {
    if (this.manual) throw new Error('Finish the manual sign-in before collecting');
    if (this.stopping && this.pumping) throw new Error('The previous operation is stopping. Try again when it has closed.');
    const pause = this.store.getSetting<{reason: string; notBefore: number | null}>('accessPause');
    if (pause) {
      if (!explicitResume) throw new Error(`${pause.reason}. Use Resume to revalidate access explicitly.`);
      if (pause.notBefore && pause.notBefore > Date.now()) throw new Error(`Cooldown lasts until ${new Date(pause.notBefore).toLocaleString()}`);
      this.store.setSetting('accessPause', null);
    }
  }
  attachMedia(media:MediaSyncDriver|null){this.mediaSync=media;}
  private totalRequests(){return this.completedRequests+(this.browserOpen?this.browser.counts.released:0)+(this.mediaSync?.status.requests??0);}
  private queueMediaSource(name:string,deadline:number){
    if(!this.mediaSync||this.queue.some(work=>work.kind==='media-source'&&work.subreddit===name))return;
    this.queue.push({id:randomUUID(),kind:'media-source',subreddit:name,deadline,generation:this.store.generation});
  }
  private queueBodies(name:string,deadline:number,requestBaseline?:number){
    if(!this.queue.some(work=>work.kind==='body-source'&&work.subreddit===name))this.queue.push({id:randomUUID(),kind:'body-source',subreddit:name,deadline,generation:this.store.generation,requestBaseline});
  }
  syncMedia(names:string[],options:{resume?:boolean}={}){
    this.store.assertStorageAvailable();
    this.allowed(Boolean(options.resume));this.stopping=false;
    for(const name of names)if(this.store.followedSources().includes(subredditName(name)))this.queueMediaSource(subredditName(name),Date.now()+60*60_000);
    this.start();
  }
  assertCanQueue(resume=false) { this.store.assertStorageAvailable();this.allowed(resume); }
  /** One explicit operation owns listing catch-up, historical pages and offline files. */
  syncFeeds(inputs:string[],plan?:{heads:string[];history:string[]}) {
    this.assertCanQueue(true);
    const selectedNames=[...new Set(inputs.map(subredditName))];
    if(selectedNames.some(name=>!this.store.followedSources().includes(name)))throw new Error('Sync requires a subscribed feed');
    // History changes stop the previous run first. Its aborted page may still be
    // unwinding; an explicit replacement plan must queue behind it, not vanish.
    const names=selectedNames.filter(name=>this.feedStatus(name)==='idle'||Boolean(plan&&this.active&&
      this.sourceOf(this.active)===name&&this.stoppedWork.has(this.active.id)));
    const plans=names.map(name=>{
      const resume=plan?null:this.store.resumeSyncPlan(name);
      const selected=plan?{heads:plan.heads.filter(id=>this.store.getTarget(id)?.subreddit===name),history:plan.history.filter(id=>this.store.getTarget(id)?.subreddit===name)}:
        resume??this.store.planSync([name]);
      const goal=this.store.ensureHistoryTarget(name);
      const ids=[...new Set([...selected.heads,...selected.history,goal])];
      const run=this.store.beginFeedSync(name,ids);this.feedRuns.set(name,run);
      return selected;
    });
    try{
      this.targets(plans.flatMap(plan=>plan.heads),{heads:true,resume:true});
      this.targets(plans.flatMap(plan=>plan.history),{resume:true});
      this.syncMedia(names,{resume:true});
      for(const name of names)this.queueBodies(name,Date.now()+60*60_000);
      this.start();
      this.finishFeeds();
    }catch(error){for(const name of names)this.store.pauseSource(name,error instanceof Error?error.message:'Sync could not start');throw error;}
    return plans.reduce((sum,plan)=>sum+plan.heads.length+plan.history.length,0);
  }
  private finishFeeds(){
    for(const [name,id] of this.feedRuns){
      if(this.active&&this.sourceOf(this.active)===name||this.queue.some(work=>this.sourceOf(work)===name))continue;
      this.store.finishFeedSync(name,id);this.feedRuns.delete(name);
    }
  }
  /** Only an explicit archive Start/Resume resets its browser/CDN allowance. */
  beginArchiveRun() {this.archiveRequestBaseline=this.totalRequests();}
  /** Save just this committed archive page before the fetcher advances. */
  async archiveMedia(ids:string[],signal:AbortSignal) {
    signal.throwIfAborted();
    this.assertCanQueue();this.stopping=false;
    await this.mediaSync?.reconcile?.();signal.throwIfAborted();
    const matches=(work:Work)=>(work.kind==='media'||work.kind==='body')&&ids.includes(work.postId);
    for(const id of ids){const state=this.store.bodySync(id);if(state&&state.status!=='ready'&&!this.queue.some(work=>work.kind==='body'&&work.postId===id))this.queue.push({id:randomUUID(),kind:'body',postId:id,deadline:Date.now()+60*60_000,generation:this.store.generation,requestBaseline:this.archiveRequestBaseline??undefined});}
    for(const id of ids)if(this.store.mediaSync(id)&&!this.queue.some(work=>work.kind==='media'&&work.postId===id)&&!(this.active?.kind==='media'&&this.active.postId===id))
      this.queue.push({id:randomUUID(),kind:'media',postId:id,deadline:Date.now()+60*60_000,generation:this.store.generation,requestBaseline:this.archiveRequestBaseline??undefined});
    this.start();
    while(this.queue.some(matches)||(this.active&&matches(this.active))){await delay(50,undefined,{signal});}
    signal.throwIfAborted();
    const pause=this.store.getSetting<{reason:string}>('accessPause');if(pause)throw new Error(pause.reason);
    const missing=ids.filter(id=>{const state=this.store.mediaSync(id);return state&&['pending','downloading','failed'].includes(state.status);});
    const missingBodies=ids.filter(id=>{const state=this.store.bodySync(id);return state&&state.status!=='ready';});
    if(missingBodies.length)throw new Error(`${missingBodies.length} archive post bodies could not be saved; Resume archive to retry`);
    if(missing.length)throw new Error(`${missing.length} archive media post(s) could not be saved; Resume archive to retry`);
  }
  targets(ids: string[], options: { resume?: boolean; heads?: boolean } = {}) {
    this.store.assertStorageAvailable();
    this.allowed(Boolean(options.resume));
    this.stopping = false;
    const deadline = Date.now() + 60 * 60_000;
    for (const id of ids) {
      const target = this.store.getTarget(id);
      if (!target || ['done', 'cancelled'].includes(target.status) || !this.store.followedSources().includes(target.subreddit)) continue;
      if (this.queue.some(work => work.kind === 'target' && work.targetId === id) || (this.active?.kind === 'target' && this.active.targetId === id)) continue;
      if(target.dependsOn){const prerequisite=this.store.getTarget(target.dependsOn);
        if(!prerequisite||prerequisite.status==='cancelled')throw new Error('Newer catch-up was cancelled; Sync this feed to plan it again');
        if(prerequisite.status!=='done')this.targets([prerequisite.id],{...options,heads:true});
      }
      this.queue.push({ id: randomUUID(), kind: 'target', targetId: id, head: options.heads ?? false, deadline, generation: this.store.generation });
      this.queueMediaSource(target.subreddit,deadline);
    }
    this.start();
  }
  thread(postId: string) {
    this.store.assertStorageAvailable();
    this.allowed(false); this.stopping = false;
    if (!this.store.getPost(postId)) throw new Error('Post not found');
    if (this.queue.some(item => item.kind === 'thread' && item.postId === postId) || (this.active?.kind === 'thread' && this.active.postId === postId)) return;
    this.queue.unshift({ id: randomUUID(), kind: 'thread', postId, deadline: Date.now() + 3 * 60_000, generation: this.store.generation });
    this.start();
  }
  private async closeBrowser() {
    if (this.closing) return this.closing;
    this.closing = (async () => {
      await this.browser.close();
      if (this.browserOpen) { this.completedRequests += this.browser.counts.released; this.browserOpen = false; }
    })();
    try { await this.closing; } finally { this.closing = null; }
  }
  pause(reason = 'Stopped by user') {
    this.onPause();this.mediaSync?.stop();
    this.stopping = true;
    this.controller?.abort();
    const sources = new Set([...this.queue, ...(this.active ? [this.active] : [])].map(work => this.sourceOf(work)).filter((name): name is string => Boolean(name)));
    for (const name of sources) this.store.pauseSource(name, reason);
    this.queue = []; this.message = reason;
    this.manual = false;
    void this.closeBrowser();
  }
  accessFailure(error: AccessError) {
    this.store.setSetting('accessPause', { reason: error.message, notBefore: error.notBefore });
    this.pause(error.message);
  }
  async stopSource(input: string, reason = 'Stopped by user') {
    const name = subredditName(input);this.mediaSync?.stop(name);
    this.queue = this.queue.filter(work => this.sourceOf(work) !== name);
    this.store.pauseSource(name, reason);
    if (this.active && this.sourceOf(this.active) === name) {
      this.stoppedWork.add(this.active.id);
      this.controller?.abort();
      await this.closeBrowser();
    }
    this.message = `r/${name}: ${reason.toLowerCase()}`;
  }
  async stopPost(input:string) {
    const id=postId(input);this.mediaSync?.stopPost?.(id);
    const matches=(work:Work)=>['thread','media','body'].includes(work.kind)&&'postId' in work&&work.postId===id;
    this.queue=this.queue.filter(work=>!matches(work));
    if(this.active&&matches(this.active)){
      this.stoppedWork.add(this.active.id);this.controller?.abort();await this.closeBrowser();
    }
  }
  async signIn() {
    if (this.pumping) throw new Error('Stop collection and wait for the browser to close first');
    this.allowed(true); this.manual = true; this.browserOpen = true;
    this.message = 'Sign in in the dedicated Chrome window, then Finish sign-in. Requests have random 4–6 second gaps after response readiness.';
    try { await this.browser.manualSignIn(); }
    catch (error) { this.pause(error instanceof Error ? error.message : 'Sign-in failed'); throw error; }
  }
  async finishSignIn() { this.pause('Sign-in browser closed. Resume collection to verify the saved account.'); await this.closeBrowser(); }
  async close(reason='Application stopped; explicit Resume required') { this.pause(reason); await this.closeBrowser();await this.pumpDone; }
  private start() { if (!this.pumping && this.queue.length) { this.pumping = true;this.session=randomUUID();this.attemptedBodies.clear();this.pumpDone=this.pump(); } }
  private async pump() {
    const startingRequests = this.totalRequests();
    try {
      while (this.queue.length && !this.stopping) {
        const ready=(work:Work)=>work.kind!=='target'||!this.store.getTarget(work.targetId)?.dependsOn||this.store.getTarget(this.store.getTarget(work.targetId)!.dependsOn!)?.status==='done';
        const rank=(work:Work)=>work.kind==='thread'?0:work.kind==='target'&&work.head?1:work.kind==='media'||work.kind==='body'?2:work.kind==='media-source'||work.kind==='body-source'?3:4;
        let index=-1;
        for(let i=0;i<this.queue.length;i++)if(ready(this.queue[i]!)&&(index<0||rank(this.queue[i]!)<rank(this.queue[index]!)))index=i;
        if(index<0){for(const work of this.queue)if(work.kind==='target')this.store.pauseTarget(work.targetId,'Newer catch-up is unfinished; Resume to continue');this.queue=[];break;}
        const work = this.queue.splice(index, 1)[0]!;
        const workSession=this.feedRuns.get(this.sourceOf(work)??'')??this.session;
        this.active = work;
        this.controller = new AbortController();
        if (Date.now() >= work.deadline) {
          if (work.kind === 'target') this.store.pauseTarget(work.targetId, 'Session time budget reached; Resume to fetch more');
          continue;
        }
        try {
          if (this.closing) await this.closing;
          this.controller.signal.throwIfAborted();
          if(work.generation!==this.store.generation)continue;
          this.store.assertStorageAvailable();
          if(work.kind==='body-source'){
            const ids=this.store.pendingBodies(work.subreddit,this.attemptedBodies);
            for(const postId of ids){this.attemptedBodies.add(postId);this.queue.push({id:randomUUID(),kind:'body',postId,deadline:work.deadline,generation:work.generation,requestBaseline:work.requestBaseline});}
            if(ids.length)this.queue.push(work);continue;
          }
          if(work.kind==='media-source'){
            const ids=this.mediaSync?.pendingPosts(work.subreddit,workSession)??[];
            // Save observed files before opening another browser page for discovery.
            ids.sort((a,b)=>Number(!this.store.getPost(a)?.attachments.length)-Number(!this.store.getPost(b)?.attachments.length));
            for(const postId of ids)this.queue.push({id:randomUUID(),kind:'media',postId,deadline:work.deadline,generation:work.generation});
            if(ids.length)this.queue.push(work);
            continue;
          }
          const requestBaseline=work.requestBaseline??startingRequests;
          const remaining=120-(this.totalRequests()-requestBaseline);
          if(remaining<=0)throw new SyncLimitError(work.requestBaseline!==undefined?'Archive media request budget reached; Resume archive to save remaining media.':'Sync request budget reached; Resume to fetch remaining posts and media.');
          if(work.kind==='media'){
            const plan=this.mediaSync?.preparePost(work.postId,workSession);if(!plan)continue;
            const post=this.store.getPost(work.postId);if(!post)continue;
            this.message=`Saving media for r/${post.subreddit}: ${post.title}`;
            if(plan.discover){
              if(this.browserOpen&&!this.mediaMode)await this.closeBrowser();
              await this.browser.open(120-(this.totalRequests()-requestBaseline),'media');this.browserOpen=true;this.mediaMode=true;
              const page=await this.browser.navigate(post.permalink.replace('https://www.reddit.com','https://old.reddit.com'),this.controller.signal);
              const account=await this.account(page);this.controller.signal.throwIfAborted();if(!account)throw new AccessError('Saved sign-in is unavailable');this.store.bindAccount(account);
              let attachments;
              try{attachments=await this.discover(page,post.id,()=>this.browser.mediaCandidates??[],this.controller.signal);}
              catch(error){
                this.controller.signal.throwIfAborted();
                if(!(error instanceof PostUnavailableError))throw error;
                this.store.markPostUnavailable(work.generation,post.id,error.availability);
                await this.mediaSync?.reconcile?.();
                this.store.noteSyncGap(post.subreddit);
                this.message=`r/${post.subreddit}: post ${error.availability}; continuing sync`;
                await this.closeBrowser();continue;
              }
              this.controller.signal.throwIfAborted();
              if(!attachments.length)throw new Error('Media discovery found no download link; sync this feed again to retry');
              this.store.saveMediaReferences(work.generation,post.id,attachments);
              this.store.setMediaSync(work.generation,post.id,'downloading',null,workSession);
              await this.mediaSync?.reconcile?.();
            }
            await this.closeBrowser();this.controller.signal.throwIfAborted();
            await this.mediaSync!.syncPost(post.id,workSession,120-(this.totalRequests()-requestBaseline),this.controller.signal);
            const progress=this.store.offlineMedia(post.subreddit);
            this.message=`r/${post.subreddit}: media saved for ${progress.ready}/${progress.total} posts`;
            continue;
          }
          if(this.browserOpen&&this.mediaMode)await this.closeBrowser();
          await this.browser.open(120-(this.totalRequests()-requestBaseline));this.browserOpen=true;this.mediaMode=false;
          this.controller.signal.throwIfAborted();
          if (work.kind === 'target') {
            const target = this.store.getTarget(work.targetId);
            if (!target || ['done','cancelled'].includes(target.status)) continue;
            this.message = `Syncing r/${target.subreddit} · ${target.observedCount} posts encountered`;
            const head = target.continuation === null || new URL(target.continuation).search === '';
            const url = target.continuation ?? `https://old.reddit.com/r/${target.subreddit}/new/`;
            const listing = await this.listing(await this.browser.navigate(url, this.controller.signal), target.subreddit);
            this.controller.signal.throwIfAborted();
            if (this.store.getTarget(target.id)?.status === 'cancelled') continue;
            this.store.bindAccount(listing.account);
            const result = advanceBoundary(target, listing, this.store.hasBatch(target.id, listing.signature));
            this.store.commitBatch({ generation: work.generation, targetId: target.id, observations: listing.posts.map(post=>post.bodyNeedsFetch&&this.attemptedBodies.has(post.id)?{...post,body:undefined,bodyNeedsFetch:false}:post),
              continuation: listing.next, omissions: listing.omissions, boundary: result.boundary, batchKey: listing.signature,
              fromHead: head, pageUrl:url, completion:result.completion,
              status: result.done ? 'done' : result.stalled ? 'paused' : 'queued',
              reason: result.reason ?? (result.stalled ? 'Listing repeated three times; continuation needs inspection' : undefined) });
            await this.mediaSync?.reconcile?.();
            this.message = `r/${target.subreddit}: ${listing.posts.length} posts checked${listing.omissions ? `, ${listing.omissions} omitted` : ''}`;
            if (!result.done && !result.stalled) this.queue.push({ ...work, head: false });
            this.queueMediaSource(target.subreddit,work.deadline);
            this.queueBodies(target.subreddit,work.deadline);
          } else if(work.kind==='thread'||work.kind==='body') {
            const post = this.store.getPost(work.postId);
            if (!post) continue;
            if(work.kind==='body'){
              if(!this.store.bodySync(post.id)||this.store.bodySync(post.id)?.status==='ready')continue;
              this.attemptedBodies.add(post.id);this.store.setBodySync(work.generation,post.id,'fetching');
            }
            this.message = work.kind==='body'?`Saving post text: ${post.title}`:`Reading discussion: ${post.title}`;
            const page = await this.browser.navigate(post.permalink.replace('https://www.reddit.com', 'https://old.reddit.com'), this.controller.signal);
            const account = await this.account(page);
            this.controller.signal.throwIfAborted();
            if (!account) throw new AccessError('Saved sign-in is unavailable');
            this.store.bindAccount(account);
            const { snapshot, attachments } = await this.discussion(page, post.id);
            this.controller.signal.throwIfAborted();
            if(work.kind==='body'){
              if(snapshot.availability!=='available'){this.store.markPostUnavailable(work.generation,post.id,snapshot.availability,snapshot.observedAt);this.store.noteSyncGap(post.subreddit);}
              else if(snapshot.body===null)throw new Error('The complete post body was not exposed; Resume to retry');
              else this.store.savePostBody(work.generation,post.id,snapshot.body,snapshot.observedAt);
            }else this.store.saveSnapshot(work.generation, snapshot);
            if(attachments)this.store.saveMediaReferences(work.generation,post.id,attachments);
            await this.mediaSync?.reconcile?.();
            if(this.mediaSync&&this.store.mediaSync(post.id))this.queue.push({id:randomUUID(),kind:'media',postId:post.id,deadline:work.deadline,generation:work.generation});
            this.message = work.kind==='body'?'Post text saved offline':`Discussion saved: ${snapshot.comments.length} sampled comments; sort ${snapshot.sort}`;
          }
        } catch (error) {
          const reason=error instanceof Error?error.message:'Collection failed';
          if (this.stoppedWork.has(work.id)) {
            await this.closeBrowser();
          } else if (!this.stopping) {
            if(error instanceof SyncLimitError){this.accessFailure(new AccessError(reason));}
            else if((work.kind==='media'||work.kind==='body')&&(error instanceof UnsupportedMediaError||(!(error instanceof AccessError)&&!(error instanceof PostIdentityError)&&!/sign.in|account|block|verification|layout|does not match|request control/i.test(reason)))){
              if(work.kind==='media')this.store.setMediaSync(work.generation,work.postId,error instanceof UnsupportedMediaError?'unavailable':'failed',reason,workSession);
              else this.store.setBodySync(work.generation,work.postId,'failed',reason);
              this.message=`${work.kind==='body'?'Post text':'Media'} ${error instanceof UnsupportedMediaError?'unavailable':'failed'}: ${reason}`;
              await this.closeBrowser();
            }else{
              this.pause(reason);
              if (error instanceof AccessError || /sign.in|account|block|verification/i.test(reason)) this.store.setSetting('accessPause', { reason, notBefore: error instanceof AccessError ? error.notBefore : null });
            }
          }
        } finally {
          if(work.kind==='media'&&this.store.mediaSync(work.postId)?.status==='downloading'){const reason=this.store.mediaSync(work.postId)?.reason;this.store.setMediaSync(work.generation,work.postId,'pending',reason?.startsWith('Media URL expired')?reason:'Sync interrupted; Resume to finish saving this feed',workSession);}
          if(work.kind==='body'&&this.store.bodySync(work.postId)?.status==='fetching')this.store.setBodySync(work.generation,work.postId,'pending','Sync interrupted; Resume to finish saving post text');
          this.stoppedWork.delete(work.id);
          this.active=null;this.finishFeeds();
        }
      }
    } finally {
      await this.closeBrowser();
      this.active = null; this.controller = null; this.pumping = false;
      this.finishFeeds();
      if (this.queue.length && !this.stopping) this.start();
    }
  }
}
